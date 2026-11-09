/** Real installed-Harness publication plugin qualification against the local provider contract server. */
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import { CoordinatorOwnership, type CoordinatorOwnershipConfig } from '../../src/ownership/lease.ts'
import { PublicationClient } from '../../src/publication/client.ts'
import { contentHash } from '../../src/publication/github.ts'
import type { DestinationView, Publication, PublicationIdentity, PublicationReceipt } from '../../src/publication/protocol.ts'
import type { publicationFixture } from './publication.ts'

export async function qualifyPublication(input: { cli: string; home: string; profile: string; directory: string; port: number;
  publisher: Awaited<ReturnType<typeof publicationFixture>>; ownership: CoordinatorOwnershipConfig }) {
  const { publisher } = input, patch = join(input.directory, 'publication.json'), shim = join(input.directory, 'publication-provider.mjs')
  await publisher.service.close()
  // Test-only transport substitution. Production keeps the fixed api.github.com origin and never accepts this setting.
  await writeFile(shim, `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return original(url.origin === 'https://api.github.com' ? ${JSON.stringify(publisher.providerOrigin)} + url.pathname + url.search : input, init);
  };\n`, { mode: 0o600 })
  await writeFile(patch, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
    { id: 'dsh-superagent', disabled: true }, { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'publication-qualification', name: 'dsh-superagent/publication', config: publisher.config }] },
  ]), { mode: 0o600 })
  let child: ChildProcess | undefined, owner: CoordinatorOwnership | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, exited = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const start = async () => {
    child = spawn(input.cli, ['--profile', input.profile, '--patch', patch, '--no-open'], {
      cwd: resolve('.'), env: { ...process.env, DSH_HOME: input.home,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(shim).href}`].filter(Boolean).join(' ') }, stdio: 'ignore',
    })
    const client = new PublicationClient({ ...publisher.connection, url: `http://127.0.0.1:${input.port}` })
    await vi.waitFor(async () => {
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Publication Harness exited during startup')
      expect((await client.call<PublicationIdentity>({ op: 'identity' })).id).toBe(publisher.connection.serviceId)
    }, { timeout: 30_000, interval: 250 })
    owner = new CoordinatorOwnership(input.ownership); await owner.start()
    return new PublicationClient(client.config, owner)
  }
  try {
    const client = await start(), destinations = await client.call<DestinationView[]>({ op: 'destinations' })
    const text = 'Installed Harness publication proof', hash = contentHash(text), before = publisher.posts
    const publication: Publication = { id: randomUUID(), text, hash, destination: destinations[0]!.id, destinationHash: destinations[0]!.hash,
      artifact: { id: randomUUID(), revision: 1, hash } }
    publisher.loseProviderReply()
    expect((await client.call<PublicationReceipt>({ op: 'publish', publication })).phase).toBe('unknown')
    const receipt = await client.call<PublicationReceipt>({ op: 'receipt.observe', id: publication.id })
    expect(receipt.phase).toBe('sent'); expect(publisher.posts).toBe(before + 1)
    await owner!.close(); await stop()
    const restarted = await start()
    expect(await restarted.call({ op: 'receipt.get', id: publication.id })).toEqual(receipt)
    expect(await restarted.call({ op: 'publish', publication })).toEqual(receipt)
    expect(publisher.posts).toBe(before + 1)
  } finally { try { await owner?.close() } finally { await stop() } }
}
