/** Installed publisher plugin and its paired Harness subprocess; all provider/Git traffic uses generated local fixtures. */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { open, mkdtemp, realpath, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { repositoryPublicationFixture } from './fixtures/repository-publication.ts'
import { PublicationClient } from '../src/publication/client.ts'
import { CoordinatorOwnership } from '../src/ownership/lease.ts'
import { fingerprint } from '../src/remote/journal.ts'
import type { PublicationIdentity } from '../src/publication/protocol.ts'
import type { RepositoryDestinationView, RepositoryReceipt, RepositoryTransferReceipt } from '../src/publication/repository-model.ts'

const exec = promisify(execFile), cleanup: (() => Promise<unknown>)[] = []
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it.runIf(process.env.DSH_PUBLICATION_HARNESS_QUALIFICATION === '1')('preserves credentialed repository uploads and original publication outcomes in the installed Harness across process restarts', async () => {
  const cli = process.env.DSH_PUBLICATION_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (!cli) throw new Error('Supply DSH_PUBLICATION_QUALIFICATION_CLI or DSH_ENDPOINT_QUALIFICATION_CLI for installed publisher qualification')
  const fixture = await repositoryPublicationFixture(cleanup)
  await fixture.owner.close(); await fixture.service.close()
  await expect(stat(fixture.config.stateDir + '.lock')).rejects.toMatchObject({ code: 'ENOENT' })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh repository Harness ')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const installation = join(directory, 'installation'), home = join(installation, 'home'), profile = 'repository-publisher-proof'
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
  // No operator profile, API key environment, or provider credentials are copied into this temporary Harness home.
  const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
  const installed = await exec('python3', [resolve('scripts/agentic-os'), 'init', '--directory', installation, '--role', 'workspace',
    '--checkout', resolve('.'), '--dsh', cli, '--profile', profile, '--port', String(port)], { env: environment, timeout: 120000 })
  expect(JSON.parse(installed.stdout)).toMatchObject({ installed: true, role: 'workspace', version: '0.2.1-rc.3' })
  const patch = join(directory, 'publisher.json'), shim = join(directory, 'local-transport.mjs'), probe = join(directory, 'transport.jsonl'), log = join(directory, 'harness.log')
  await writeFile(probe, '', { mode: 0o600 })
  // Qualification-only exact transport mapping. Production provider/source checks and the imported program remain unchanged.
  // The child still exercises Harness resolveExecutable/spawn, pairing, authenticated TLS Git, bundle validation and create-only push.
  await writeFile(shim, `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const fetchOriginal=globalThis.fetch, spawnOriginal=cp.spawnSync;
globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://api.github.com')return fetchOriginal(${JSON.stringify(fixture.providerOrigin)}+url.pathname+url.search,init);
  if(url.hostname!=='127.0.0.1'||!['http:','https:'].includes(url.protocol))throw new Error('Qualification blocked an external fetch');
  return fetchOriginal(input,init);
};
cp.spawnSync=function(command,args,options){
  if(command==='git'&&args.includes('https://github.com/acme/project.git')){
    const mapped=args.map(value=>value==='https://github.com/acme/project.git'?${JSON.stringify(fixture.git.url)}:value);
    fs.appendFileSync(${JSON.stringify(probe)},JSON.stringify({operation:args.includes('push')?'push':'fetch'})+'\\n');
    return spawnOriginal.call(this,command,mapped,{...options,env:{...options.env,GIT_SSL_CAINFO:${JSON.stringify(fixture.git.certFile)}}});
  }
  if(command==='git'&&args.some(value=>typeof value==='string'&&/^https?:/.test(value)))throw new Error('Qualification blocked another Git destination');
  return spawnOriginal.call(this,command,args,options);
};syncBuiltinESMExports();\n`, { mode: 0o600 })
  await writeFile(patch, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port } },
    { id: 'dsh-superagent', disabled: true }, { id: 'dsh-superagent-sources', disabled: true },
    { id: 'dsh-superagent-github', disabled: true }, { id: 'dsh-superagent-feishu', disabled: true }, { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'repository-publication-qualification', name: 'dsh-superagent/publication', config: fixture.config }] },
  ]), { mode: 0o600 })
  let child: ChildProcess | undefined, owner: CoordinatorOwnership | undefined, stage = 'initial plugin startup'
  const stop = async (hard = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, exited = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill(hard ? 'SIGKILL' : 'SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(timer) }
    // Respect the production single-writer lock after abrupt death. No unlinking or shortened stale threshold.
    if (hard) await vi.waitFor(async () => {
      const lock = await stat(fixture.config.stateDir + '.lock').catch(() => undefined)
      if (lock) expect(Date.now() - lock.mtimeMs).toBeGreaterThan(30000)
    }, { timeout: 35000, interval: 250 })
  }
  cleanup.push(async () => { await owner?.close(); await stop() })
  const connection = { ...fixture.connection, url: `http://127.0.0.1:${port}` }
  const claim = async () => {
    owner = new CoordinatorOwnership({ ...fixture.authority.config, leaseMs: 10000, prepareTimeoutMs: 15000 }); await owner.start()
    return new PublicationClient(connection, owner)
  }
  const start = async (acquire = true) => {
    const output = await open(log, 'a', 0o600)
    try { child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: resolve('.'),
      env: { ...environment, DSH_HOME: home, NODE_OPTIONS: `--import=${pathToFileURL(shim).href}` }, stdio: ['ignore', output.fd, output.fd] }) }
    finally { await output.close() }
    const observer = new PublicationClient(connection)
    await vi.waitFor(async () => {
      expect(child?.exitCode, 'Harness exited during startup').toBeNull()
      expect(await observer.call<PublicationIdentity>({ op: 'identity' })).toMatchObject({ id: connection.serviceId,
        capabilities: { repositories: true }, ownership: { authorityId: fixture.authority.config.authorityId, resourceId: 'publication' } })
    }, { timeout: 30000, interval: 250 })
    return acquire ? claim() : observer
  }
  try {
    let client = await start()
    const catalog = await client.call<(typeof RepositoryDestinationView._output)[]>({ op: 'repository.destinations' })
    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toMatchObject({ id: fixture.destination.id, repository: 'acme/project', repositoryId: 20, hash: fixture.publication.destinationHash })
    const { hash, ...destination } = catalog[0]!; expect(fingerprint(destination)).toBe(hash)
    const denied = await fetch(connection.url + '/publication/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'identity' }) })
    expect(denied.status).toBe(401); await denied.body?.cancel()
    await expect(new PublicationClient(connection).call({ op: 'repository.transfer.begin', transfer: fixture.transfer })).rejects.toThrow('ownership')
    await client.call({ op: 'repository.transfer.begin', transfer: fixture.transfer })
    const chunk = fixture.bytes.subarray(0, 65536), chunkRequest = { op: 'repository.transfer.chunk' as const, id: fixture.transfer.id,
      offset: 0, data: chunk.toString('base64'), hash: digest(chunk) }
    await expect(client.call({ ...chunkRequest, hash: '0'.repeat(64) })).rejects.toThrow()
    const first = await client.call<RepositoryTransferReceipt>(chunkRequest)
    expect(first).toMatchObject({ id: fixture.transfer.id, phase: 'receiving', received: 65536 })
    stage = 'restart after partial upload'
    await owner!.close(); await stop(true)
    client = await start()
    expect(await client.call({ op: 'repository.transfer.get', id: fixture.transfer.id })).toEqual(first)
    const resumed = await client.call<RepositoryTransferReceipt>({ op: 'repository.transfer.begin', transfer: fixture.transfer })
    expect(resumed).toMatchObject({ received: first.received, phase: 'receiving', ownership: owner!.status().owner })
    expect(resumed.owners).toHaveLength(2)
    for (let offset = resumed.received; offset < fixture.bytes.length; offset += 65536) {
      const data = fixture.bytes.subarray(offset, offset + 65536)
      await client.call({ op: 'repository.transfer.chunk', id: fixture.transfer.id, offset, data: data.toString('base64'), hash: digest(data) })
    }
    const transferred = await client.call<RepositoryTransferReceipt>({ op: 'repository.transfer.finish', id: fixture.transfer.id })
    expect(transferred).toMatchObject({ phase: 'ready', received: fixture.bytes.length, hash: fingerprint(fixture.transfer), bundle: { sha256: digest(fixture.bytes) } })
    stage = 'paired subprocess import'
    const prepared = await client.call<{ prepared: boolean; receipt: RepositoryReceipt }>({ op: 'repository.prepare', publication: fixture.publication })
    expect(prepared.prepared, prepared.receipt.problem).toBe(true)
    expect(fixture.posts).toBe(0); expect(fixture.git.pushes()).toBe(0)
    fixture.losePull()
    stage = 'original publication with lost PR reply'
    const unknown = await client.call<RepositoryReceipt>({ op: 'repository.publish', publication: fixture.publication, evidence: fixture.evidence() })
    expect(unknown).toMatchObject({ phase: 'unknown', step: 'pull', branchResult: { sha: fixture.transfer.bundle.head } })
    expect(fixture.posts).toBe(1); expect(fixture.git.pushes()).toBe(1)
    stage = 'restart and observe unknown publication before ownership takeover'
    await owner!.close(); await stop(true)
    client = await start(false)
    expect(await client.call({ op: 'repository.receipt.get', id: fixture.publication.id })).toEqual(unknown)
    const observed = await client.call<RepositoryReceipt>({ op: 'repository.receipt.observe', id: fixture.publication.id })
    expect(observed).toMatchObject({ id: fixture.publication.id, phase: 'published', pullResult: { number: 1 } })
    client = await claim()
    expect(await client.call({ op: 'repository.publish', publication: fixture.publication, evidence: fixture.evidence() })).toEqual(observed)
    expect(fixture.posts).toBe(1); expect(fixture.git.pushes()).toBe(1)
    expect(await fixture.git.git('-C', fixture.git.bare, 'rev-parse', 'refs/heads/agentic/' + fixture.publication.id)).toBe(fixture.transfer.bundle.head)
    const transport = (await readFile(probe, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(transport.filter(value => value.operation === 'fetch').length).toBeGreaterThan(0)
    expect(transport.filter(value => value.operation === 'push')).toHaveLength(1)
  } catch (error) {
    const diagnostics = await readFile(log, 'utf8').catch(() => '')
    const safe = diagnostics.split('\n').filter(line => !/api.?key|authoriz|credential|token|secret|signing/i.test(line)).slice(-35).join('\n')
    throw new Error(`${stage}: ${String(error)}\nInstalled publisher diagnostics (sensitive lines omitted):\n${safe}`, { cause: error })
  }
}, 180000)
