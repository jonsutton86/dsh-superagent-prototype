import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RemoteWorld } from '../remote/world.ts'
import { runAsWorker } from '../infra/environment.ts'

export const remoteWorld = (ctx: Context): RemoteWorld | undefined => ctx.get('superagentRemoteWorld')

/** Filesystem and process operations for a bound remote profile; never interprets a remote path on the coordinator host. */
export class RemoteWorkspace {
  constructor(readonly world: RemoteWorld, private readonly filesystem: FileSystem, private readonly subprocess: SubprocessRuntime,
    private readonly lifetime: AbortSignal) {}
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
