/** Explicit local process mode. Clearing ambient credentials is useful hygiene, not an OS/filesystem/network sandbox. */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExecutionIsolation } from '../remote/isolation.ts'

export const snapshotHelperPath = () => {
  const built = fileURLToPath(new URL('./verification-snapshot-worker.js', import.meta.url))
  return existsSync(built) ? built : fileURLToPath(new URL('./snapshot-worker.ts', import.meta.url))
}
/** Explicitly unconfined local execution with cleared environment and private working/scratch directories. */
export class HostProcessIsolation implements ExecutionIsolation {
  readonly name = 'host-process'
  async wrap(argv: readonly string[], root: string, _cwd: string, _network: boolean, signal: AbortSignal,
    env: Record<string, string | null> = {}, helper?: string, _mounts?: readonly { source: string; target: string }[],
    options: { temporaryDirectory?: string } = {}): Promise<readonly string[]> {
    signal.throwIfAborted()
    const values: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: root, TMPDIR: options.temporaryDirectory ?? '/tmp' }
    for (const [name, value] of Object.entries(env)) { if (value === null) delete values[name]; else values[name] = value }
    const command = argv.map(value => helper && value === '/run/dsh-filesystem.mjs' ? helper : value)
    return ['/usr/bin/env', '-i', ...Object.entries(values).map(([name, value]) => `${name}=${value}`), ...command]
  }
}
