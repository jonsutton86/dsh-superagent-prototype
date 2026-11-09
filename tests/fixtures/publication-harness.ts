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
import type { DestinationConfig, DestinationView, Publication, PublicationIdentity, PublicationReceipt } from '../../src/publication/protocol.ts'
import type { publicationFixture } from './publication.ts'

export async function qualifyPublication(input: { cli: string; home: string; profile: string; directory: string; port: number;
  publisher: Awaited<ReturnType<typeof publicationFixture>>; ownership: CoordinatorOwnershipConfig }) {
  const { publisher } = input, patch = join(input.directory, 'publication.json'), shim = join(input.directory, 'publication-provider.mjs')
  await publisher.service.close()
  // Test-only transport substitution. Production keeps fixed provider origins and never accepts this setting.
  await writeFile(shim, `const original = globalThis.fetch; globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    return original(['https://api.github.com', 'https://open.feishu.cn', 'https://open.larksuite.com'].includes(url.origin) ? ${JSON.stringify(publisher.providerOrigin)} + url.pathname + url.search : input, init);
  };\n`, { mode: 0o600 })
  const common = { maxBytes: 30_000, credentialFile: publisher.destination.credentialFile }
  const destinations: DestinationConfig[] = [...publisher.config.destinations,
    { ...common, id: 'review-replies', name: 'Review replies', kind: 'github-review', repository: 'acme/project', issue: 7, comment: 11, login: 'agent-bot' },
    ...(['feishu', 'lark'] as const).map(brand => ({ ...common, id: `${brand}-replies`, name: `${brand} replies`, kind: 'feishu-reply' as const,
      brand, appId: 'cli_agent', botId: 'ou_bot', chatId: 'oc_chat', messageId: 'om_root' }))]
  await writeFile(patch, JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
    { id: 'dsh-superagent', disabled: true }, { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'publication-qualification', name: 'dsh-superagent/publication', config: { ...publisher.config, destinations } }] },
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
    const client = await start(), catalog = await client.call<DestinationView[]>({ op: 'destinations' })
    expect(catalog).toHaveLength(destinations.length)
    const text = 'Installed Harness publication proof', hash = contentHash(text), before = publisher.posts
    const proofs: { publication: Publication; receipt: PublicationReceipt }[] = []
    for (const destination of catalog) {
      if (destination.kind === 'github-pr-review') {
        const observation = await client.call<{ binding: { head: { sha: string } } }>({ op: 'pull.inspect', destination: destination.id, destinationHash: destination.hash })
        expect(observation.binding.head.sha).toBe(publisher.pull.head.sha)
        continue
      }
      const publication: Publication = { id: randomUUID(), text, hash, destination: destination.id, destinationHash: destination.hash,
        message: { id: randomUUID(), ticketId: randomUUID(), missionId: randomUUID(), grantId: randomUUID(), planVersion: 1 } }
      publisher.loseProviderReply()
      expect((await client.call<PublicationReceipt>({ op: 'publish', publication })).phase).toBe('unknown')
      const receipt = await client.call<PublicationReceipt>({ op: 'receipt.observe', id: publication.id })
      expect(receipt.phase, destination.id).toBe('sent'); proofs.push({ publication, receipt })
    }
    expect(publisher.posts).toBe(before + 4)
    await owner!.close(); await stop()
    const restarted = await start()
    for (const { publication, receipt } of proofs) {
      expect(await restarted.call({ op: 'receipt.get', id: publication.id })).toEqual(receipt)
      expect(await restarted.call({ op: 'publish', publication })).toEqual(receipt)
    }
    expect(publisher.posts).toBe(before + 4)
    return proofs.map(({ publication }) => publication.id)
  } finally {
    try { await owner?.close() }
    finally {
      await stop()
      // Later recovery inspection needs the independent resource online, with its complete persisted destination catalog.
      await publisher.restart(destinations)
    }
  }
}
