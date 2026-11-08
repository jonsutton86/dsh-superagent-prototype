import { randomUUID, createHash } from 'node:crypto'
import { chmod, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteClient } from '../src/remote/client.ts'
import { RemoteWorld } from '../src/remote/world.ts'
import { worldBinding } from '../src/remote/world-journal.ts'
import type { EndpointCredential, GrantReceipt, RemoteJob, OutputWindow } from '../src/remote/protocol.ts'
import { remoteFixture } from './fixtures/remote.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; vi.restoreAllMocks() })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(native = false) {
  const h = await remoteFixture(cleanup, { native })
  const provision = async (id = 'service', secret: string = randomUUID(), mode: 'env' | 'file' = 'env', revision = 0) => {
    const file = `${id}-${randomUUID()}`
    await writeFile(join(h.endpoint.credentials.imports, file), secret, { mode: 0o600 })
    const request = { op: 'credential.import' as const, requestId: randomUUID(), id, revision, file,
      variable: mode === 'env' ? 'SERVICE_API_KEY' : 'SERVICE_CONFIG_FILE', mode, reason: 'Authorized service access' }
    return { credential: await h.admin.intent<EndpointCredential>(request), secret, request }
  }
  const enroll = async (credentials: EndpointCredential[]) => {
    const receipt = await h.admin.intent<GrantReceipt>({ op: 'grant.create', requestId: randomUUID(), owner: 'coordinator', workspace: randomUUID(),
      operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000, credentials: credentials.map(({ id, version }) => ({ id, version })) })
    const credentialFile = join(h.directory, `${receipt.grant.id}.token`)
    await writeFile(credentialFile, receipt.credential!, { mode: 0o600 })
    const client = new RemoteClient({ ...h.connection, credentialFile })
    const run = async (script: string, extra = {}) => {
      const job = await client.intent<RemoteJob>(h.spawn(script, { cwd: receipt.grant.root, revision: receipt.grant.revision, ...extra }))
      let final!: RemoteJob
      await vi.waitFor(async () => { final = await client.call<RemoteJob>({ op: 'job.get', id: job.id }); expect(final.quiescent).toBe(true) }, { timeout: 5000 })
      const window = await client.call<OutputWindow>({ op: 'job.output', id: job.id, stream: 'stdout', offset: 0 })
      return { job: final, output: Buffer.from(window.data, 'base64').toString() }
    }
    return { client, receipt, run }
  }
  return Object.assign(h, { provision, enroll })
}
const envProof = `node -e 'const fs=require("fs");process.stdout.write(require("crypto").createHash("sha256").update(process.env.SERVICE_API_KEY).digest("hex")+fs.readFileSync(0,"utf8"))'`

it('injects endpoint-owned credentials inside the command, preserving stdin without placing values in provider argv or receipts', async () => {
  const h = await fixture(), saved = await h.provision(), grant = await h.enroll([saved.credential])
  const calls = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await grant.run(envProof, { stdin: '-stdin-proof' })
  expect(result.job.outcome?.exitCode).toBe(0)
  expect(result.output).toBe(digest(saved.secret) + '-stdin-proof')
  expect(result.job.credentials).toEqual(grant.receipt.grant.credentials)
  expect(result.job.request).not.toHaveProperty('credentials')
  expect(JSON.stringify(calls.mock.calls)).not.toContain(saved.secret)
  expect(JSON.stringify(result.job)).not.toContain(saved.secret)
  expect(JSON.stringify(await h.admin.call({ op: 'credential.list' }))).not.toContain(saved.secret)
  expect((await readFile(join(h.directory, 'control/endpoint.sqlite-wal'))).includes(Buffer.from(saved.secret))).toBe(false)
  await expect(grant.client.call({ op: 'credential.list' })).rejects.toMatchObject({ status: 403 })
  await expect(grant.client.call({ op: 'credential.revoke', requestId: 'worker-revoke', id: saved.credential.id, revision: 1, reason: 'Not authorized' })).rejects.toMatchObject({ status: 403 })
  await expect(grant.client.call({ op: 'fs.read', path: join(h.directory, 'control/credential-vault', saved.credential.version) })).rejects.toThrow('outside')
  await expect(grant.client.intent(h.spawn('true', { cwd: grant.receipt.grant.root, env: { SERVICE_API_KEY: null } }))).rejects.toThrow('cannot replace')
})

it('binds only explicit credentials and supports read-only credential files', async () => {
  const h = await fixture(), saved = await h.provision('config', '{"service":"private configuration"}', 'file')
  const grant = await h.enroll([saved.credential]), none = await h.enroll([])
  const result = await grant.run(`node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.env.SERVICE_CONFIG_FILE)).digest("hex"))'`)
  expect(result.job.outcome?.exitCode).toBe(0); expect(result.output).toBe(digest(saved.secret))
  expect((await none.run('test -z "$SERVICE_CONFIG_FILE" && test -z "$SERVICE_API_KEY"')).job.outcome?.exitCode).toBe(0)
  const base = { ...grant.receipt.grant, credentials: undefined }
  expect(worldBinding(h.endpoint.journal.id, grant.receipt.grant)).not.toBe(worldBinding(h.endpoint.journal.id, base))
})

it('invalidates and cancels grants on rotation without silently transferring old clients to new credential versions', async () => {
  const h = await fixture(), first = await h.provision(), grant = await h.enroll([first.credential])
  const started = await grant.client.intent<RemoteJob>(h.spawn('sleep 30', { cwd: grant.receipt.grant.root }))
  await vi.waitFor(() => expect(h.endpoint.journal.job(started.id).phase).toBe('started'))
  const next = await h.provision('service', randomUUID(), 'env', 1)
  expect(next.credential.version).not.toBe(first.credential.version)
  expect(await grant.client.call({ op: 'grant.status' })).toMatchObject({ authorized: false })
  await vi.waitFor(() => expect(h.endpoint.journal.job(started.id).quiescent).toBe(true))
  await expect(grant.client.intent(h.spawn('true', { cwd: grant.receipt.grant.root }))).rejects.toThrow('revoked')
  const current = h.endpoint.journal.grant(grant.receipt.grant.id)
  await expect(h.admin.intent({ op: 'grant.change', requestId: 'missing-rebind', id: current.id, revision: current.revision,
    enabled: true, leaseMs: 300_000, reason: 'Cannot inherit rotation' })).rejects.toThrow('current credential versions')
  const replacement = await h.admin.intent<GrantReceipt>({ op: 'grant.change', requestId: 'explicit-rebind', id: current.id, revision: current.revision,
    enabled: true, leaseMs: 300_000, reason: 'Authorize the new service credential', credentials: [{ id: next.credential.id, version: next.credential.version }] })
  expect(replacement.grant.epoch).toBe(current.epoch + 1)
  const credentialFile = join(h.directory, 'replacement-grant.token'); await writeFile(credentialFile, replacement.credential!, { mode: 0o600 })
  const client = new RemoteClient({ ...h.connection, credentialFile })
  const proof = await client.intent<RemoteJob>(h.spawn(envProof, { cwd: replacement.grant.root, revision: replacement.grant.revision }))
  await vi.waitFor(() => expect(h.endpoint.journal.job(proof.id).quiescent).toBe(true))
  const output = await client.call<OutputWindow>({ op: 'job.output', id: proof.id, stream: 'stdout', offset: 0 })
  expect(Buffer.from(output.data, 'base64').toString()).toBe(digest(next.secret))
  await h.admin.intent(first.request) // Replaying a historical import must not invalidate newly bound authority.
  expect(await client.call({ op: 'grant.status' })).toMatchObject({ authorized: true })
  await expect(grant.client.call({ op: 'grant.renew', requestId: 'old-renewal', revision: current.revision, leaseMs: 300_000 })).rejects.toThrow()
})

it('fences a queued command when its credential is revoked during confinement preparation', async () => {
  const h = await fixture(), saved = await h.provision(), grant = await h.enroll([saved.credential])
  const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), wrap = h.isolation.wrap.bind(h.isolation)
  vi.spyOn(h.isolation, 'wrap').mockImplementation(async (...args) => {
    if (args[0].includes('/run/dsh-command.mjs')) { reached.resolve(); await release.promise }
    return wrap(...args)
  })
  const job = await grant.client.intent<RemoteJob>(h.spawn('touch forbidden-effect', { cwd: grant.receipt.grant.root }))
  await reached.promise
  try { await h.admin.intent({ op: 'credential.revoke', requestId: 'stop-credential', id: saved.credential.id, revision: 1, reason: 'Withdraw service access' }) }
  finally { release.resolve() }
  await vi.waitFor(() => expect(h.endpoint.journal.job(job.id)).toMatchObject({ phase: 'settled', quiescent: true }))
  await expect(readFile(join(grant.receipt.grant.root, 'forbidden-effect'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await grant.client.call({ op: 'grant.status' })).toMatchObject({ authorized: false })
})

it('retains pinned snapshots and revocations across endpoint restart, with idempotent import receipts', async () => {
  const h = await fixture(), saved = await h.provision(), grant = await h.enroll([saved.credential])
  await writeFile(join(h.endpoint.credentials.imports, saved.request.file), 'changed-source', { mode: 0o600 })
  await h.admin.intent(saved.request)
  expect((await grant.run(envProof)).output).toBe(digest(saved.secret))
  await h.restart()
  expect((await grant.run(envProof)).output).toBe(digest(saved.secret))
  await h.admin.intent({ op: 'credential.revoke', requestId: 'persistent-revoke', id: saved.credential.id, revision: 1, reason: 'Revoked' })
  await h.restart()
  expect(await grant.client.call({ op: 'grant.status' })).toMatchObject({ authorized: false })
  await expect(h.enroll([saved.credential])).rejects.toThrow('unavailable')
})

it('refuses unsafe import files, conflicting variables and reserved runtime names', async () => {
  const h = await fixture(), saved = await h.provision()
  await chmod(join(h.endpoint.credentials.imports, saved.request.file), 0o644)
  await expect(h.admin.intent({ ...saved.request, requestId: 'public-file', revision: 1 })).rejects.toThrow('private regular file')
  await symlink(join(h.endpoint.credentials.imports, saved.request.file), join(h.endpoint.credentials.imports, 'linked'))
  await expect(h.admin.intent({ ...saved.request, requestId: 'symlink-file', revision: 1, file: 'linked' })).rejects.toThrow('private regular file')
  await expect(h.admin.intent({ ...saved.request, requestId: 'escape-file', revision: 1, file: '../admin.token' })).rejects.toThrow()
  await expect(h.admin.intent({ ...saved.request, requestId: 'reserved-name', revision: 1, variable: 'NODE_OPTIONS' })).rejects.toThrow('runtime')
  const duplicate = await h.provision('other-service')
  await expect(h.enroll([saved.credential, duplicate.credential])).rejects.toThrow('one variable')
  await expect(h.enroll([saved.credential, saved.credential])).rejects.toThrow('repeat credentials')
})

it('rejects mutated vault snapshots without exposing values or launching the requested command', async () => {
  const h = await fixture(), saved = await h.provision(), grant = await h.enroll([saved.credential])
  await writeFile(join(h.directory, 'control/credential-vault', saved.credential.version), 'unauthorized replacement', { mode: 0o600 })
  const result = await grant.run('touch never-created')
  expect(result.job).toMatchObject({ phase: 'settled', quiescent: true, error: expect.stringContaining('snapshot changed') })
  expect(JSON.stringify(result.job)).not.toContain('unauthorized replacement')
  await expect(readFile(join(grant.receipt.grant.root, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('pins credentials into the coordinator world and refuses replacement after restart', async () => {
  const h = await fixture(), saved = await h.provision(), grant = await h.enroll([saved.credential])
  vi.spyOn(h.endpoint, 'identity').mockReturnValue({ ...h.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const config = { ...grant.client.connection, stateDir: join(h.directory, 'world') }, world = new RemoteWorld(config)
  cleanup.push(() => world.close()); await world.start()
  expect(world.grant.credentials).toEqual(grant.receipt.grant.credentials)
  await world.close()
  const next = await h.provision('service', randomUUID(), 'env', 1), replacement = await h.enroll([next.credential])
  const restored = new RemoteWorld({ ...config, credentialFile: replacement.client.connection.credentialFile }); cleanup.push(() => restored.close())
  await expect(restored.start()).rejects.toThrow('no longer matches')
})

it.runIf(process.env.DSH_REMOTE_ISOLATION === '1')('qualifies private credential mounts and cancellation through native Linux confinement', async () => {
  const h = await fixture(true), env = await h.provision(), file = await h.provision('config', 'private-config-file', 'file')
  const grant = await h.enroll([env.credential, file.credential])
  const proof = await grant.run(envProof, { stdin: '-native-stdin' })
  expect(proof.job.outcome?.exitCode).toBe(0); expect(proof.output).toBe(digest(env.secret) + '-native-stdin')
  const boundary = await grant.run('test ! -e "$1" && test ! -e /run/dsh-credentials/unbound && ! (printf changed > "$SERVICE_CONFIG_FILE")',
    { argv: ['/bin/sh', '-c', 'test ! -e "$1" && test ! -e /run/dsh-credentials/unbound && ! (printf changed > "$SERVICE_CONFIG_FILE")', 'proof', join(h.directory, 'control')] })
  expect(boundary.job.outcome?.exitCode).toBe(0)
  const running = await grant.client.intent<RemoteJob>(h.spawn('sleep 30', { cwd: grant.receipt.grant.root }))
  await vi.waitFor(() => expect(h.endpoint.journal.job(running.id).phase).toBe('started'))
  await h.admin.intent({ op: 'credential.revoke', requestId: 'native-revoke', id: env.credential.id, revision: 1, reason: 'Withdraw native credential grant' })
  await vi.waitFor(() => expect(h.endpoint.journal.job(running.id).quiescent).toBe(true), { timeout: 5000 })
  expect(await grant.client.call({ op: 'grant.status' })).toMatchObject({ authorized: false })
}, 30_000)
