import { access, realpath } from 'node:fs/promises'
import { dirname, parse } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { RemoteError } from './protocol.ts'

export interface ExecutionIsolation {
  readonly name: string
  wrap(argv: readonly string[], root: string, cwd: string, network: boolean, signal: AbortSignal,
    env?: Record<string, string | null>, helper?: string, mounts?: readonly { source: string; target: string }[]): Promise<readonly string[]>
}

/** Linux process worlds expose only system runtime files and one granted workspace, never endpoint control state. */
export class BubblewrapIsolation implements ExecutionIsolation {
  readonly name = 'linux-bubblewrap'
  constructor(private readonly subprocess: SubprocessRuntime) {
    if (process.platform !== 'linux') throw new RemoteError(503, 'isolation_unavailable', 'The remote endpoint requires Linux with bubblewrap and user namespaces')
  }
  async wrap(argv: readonly string[], root: string, cwd: string, network: boolean, signal: AbortSignal,
    env: Record<string, string | null> = {}, helper?: string, mounts: readonly { source: string; target: string }[] = []): Promise<readonly string[]> {
    const program = await this.subprocess.resolveExecutable('bwrap', undefined, signal)
    const args = [program, '--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL']
    if (network) args.push('--share-net')
    for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64']) {
      if (!await access(path).then(() => true, () => false)) continue
      const canonical = await realpath(path)
      if (canonical === path) args.push('--ro-bind', path, path)
      else args.push('--symlink', canonical, path)
    }
    args.push('--dir', '/etc')
    for (const path of ['/etc/ssl', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group'])
      if (await access(path).then(() => true, () => false)) args.push('--ro-bind', path, path)
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp')
    const parents: string[] = []
    for (let value = dirname(root); value !== parse(value).root; value = dirname(value)) parents.unshift(value)
    for (const parent of parents) if (!['/tmp', '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/dev'].includes(parent)) args.push('--dir', parent)
    if (helper || mounts.length) args.push('--dir', '/run')
    if (helper) args.push('--ro-bind', helper, '/run/dsh-filesystem.mjs')
    if (mounts.length) {
      args.push('--dir', '/run/dsh-credentials')
      for (const mount of mounts) {
        if (mount.target !== '/run/dsh-command.mjs' && !/^\/run\/dsh-credentials\/[a-zA-Z0-9_-]{1,100}$/.test(mount.target))
          throw new RemoteError(400, 'credential_mount', 'Credential mount target is outside the reserved command namespace')
        args.push('--ro-bind', mount.source, mount.target)
      }
    }
    args.push('--bind', root, root, '--chdir', cwd, '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      '--setenv', 'HOME', root, '--setenv', 'TMPDIR', '/tmp')
    for (const [key, value] of Object.entries(env)) args.push(...(value === null ? ['--unsetenv', key] : ['--setenv', key, value]))
    args.push('--', ...argv)
    return args
  }
}
