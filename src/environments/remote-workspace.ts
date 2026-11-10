import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorld } from '../remote/world.ts'
import { runAsWorker } from '../infra/environment.ts'
import { RepositorySource, repositoryCredential } from './repository-model.ts'
import { prepareRepository } from './repository.ts'
import { RemoteSubprocess } from '../remote/subprocess.ts'

export const remoteWorld = (ctx: Context): RemoteWorld | undefined => ctx.get('superagentRemoteWorld')

/** Filesystem and process operations for a bound remote profile; never interprets a remote path on the coordinator host. */
export class RemoteWorkspace {
  readonly repository?: RepositorySource
  private readonly preparing = new Map<string, Promise<void>>()
  constructor(readonly world: RemoteWorld, private readonly filesystem: FileSystem, private readonly subprocess: SubprocessRuntime,
    private readonly lifetime: AbortSignal, repository?: RepositorySource) {
    this.repository = repository && Object.freeze(RepositorySource.parse(repository))
    if (this.repository) repositoryCredential(this.repository, world.grant)
  }
  /** Observe the original preparation receipt on every launch; an existing directory alone proves nothing. */
  async prepareRepository(path: string, ticketId: string, signal = this.lifetime): Promise<void> {
    this.assertPair()
    if (!this.repository) throw new Error('This execution world has no repository source')
    if (!(this.subprocess instanceof RemoteSubprocess)) throw new Error('Repository preparation requires the paired remote process provider')
    const key = JSON.stringify([path, ticketId]), existing = this.preparing.get(key)
    if (existing) return existing
    const work = this.prepareAndCheck(path, ticketId, signal).finally(() => this.preparing.delete(key))
    this.preparing.set(key, work)
    return work
  }
  private async prepareAndCheck(path: string, ticketId: string, signal: AbortSignal): Promise<void> {
    await prepareRepository(this.world, this.repository!, path, ticketId, AbortSignal.any([this.lifetime, signal]), this.subprocess as RemoteSubprocess)
    signal.throwIfAborted()
    this.assertPair()
    for (const target of [path, posix.join(path, '.git')]) {
      const resolved = await this.filesystem.resolve(target, { signal: this.lifetime })
      if (this.filesystem.processPath(resolved) !== target || (await this.filesystem.stat(resolved, this.lifetime))?.type !== 'directory')
        throw new Error('The prepared repository directory changed; it was not recreated')
    }
  }
  assertPair(): void {
    const binding = this.world.status().binding
    if ((this.filesystem as FileSystem & { executionBinding?: string }).executionBinding !== binding
      || (this.subprocess as SubprocessRuntime & { executionBinding?: string }).executionBinding !== binding)
      throw new Error('The profile must compose filesystem and subprocess providers from the same remote execution world')
    if (!this.world.status().ready) throw new Error('The remote execution world is unavailable or revoked')
  }
  async canonical(path: string): Promise<string> {
    this.assertPair()
    return this.filesystem.processPath(await this.filesystem.resolve(path, { signal: this.lifetime }))
  }
  async exists(path: string): Promise<boolean> {
    this.assertPair()
    return !!await this.filesystem.stat(await this.filesystem.resolve(path, { signal: this.lifetime }), this.lifetime)
  }
  async mkdir(path: string): Promise<void> {
    this.assertPair()
    const root = this.world.grant.root, relative = posix.relative(root, path)
    if (posix.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) throw new Error('Task directory is outside the remote grant')
    await runAsWorker(this.subprocess, ['mkdir', '-p', '-m', '700', '--', path], root, this.lifetime)
    this.assertPair()
  }
  /** A remote write/read/process proof, with no host-path mapping or host filesystem access. */
  async verify(path: string): Promise<void> {
    this.assertPair()
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000)])
    const target = await this.filesystem.resolve(path, { signal })
    if (this.filesystem.processPath(target) !== path || (await this.filesystem.stat(target, signal))?.type !== 'directory')
      throw new Error('Remote execution directory is missing or resolves to another location')
    const nonce = randomUUID(), name = posix.join(path, `.dsh-world-${nonce}`)
    const proof = await this.filesystem.resolve(name, { signal })
    await this.filesystem.writeText(proof, nonce, { kind: 'createIfAbsent' }, signal)
    try {
      if (await this.filesystem.readText(proof, signal) !== nonce
        || await runAsWorker(this.subprocess, ['cat', '--', name], path, signal) !== nonce)
        throw new Error('Remote filesystem and process views do not match')
      this.assertPair()
    } finally {
      // Revocation can prevent cleanup; the unique proof contains no user data and cannot authorize later work.
      await runAsWorker(this.subprocess, ['rm', '--', name], path, signal).catch(() => {})
    }
  }
}
