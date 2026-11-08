import { FsError, type FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { RemoteError, type RemoteGrant, type RpcRequest } from './protocol.ts'
import type { ExecutionIsolation } from './isolation.ts'

/** File reads and writes cross the OS boundary too; path prechecks alone cannot protect against concurrent symlink substitution. */
export function confinedFilesystem(subprocess: SubprocessRuntime, isolation: ExecutionIsolation, helper: string) {
  return async (grant: RemoteGrant, request: RpcRequest, signal: AbortSignal): Promise<unknown> => {
    const node = await subprocess.resolveExecutable('node', undefined, signal)
    const argv = await isolation.wrap([node, '/run/dsh-filesystem.mjs'], grant.root, grant.root, false, signal, {}, helper)
    const handle = subprocess.spawn({ argv, cwd: grant.root, graceMs: 1000, signal,
      stdio: { stdin: { data: JSON.stringify({ root: grant.root, request }) }, stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 65536 } } })
    const result = await handle.done
    if (!await handle.waitForExit(signal)) throw new RemoteError(503, 'filesystem_unknown', 'Confined filesystem process did not reach quiescence')
    if (result.exitCode !== 0) throw new RemoteError(503, 'isolation_unavailable', handle.collected.stderr?.readFrom(0).text.slice(0, 4000) || 'Confined filesystem runner failed')
    const output = handle.collected.stdout!.readFrom(0)
    if (output.lossy) throw new Error('Filesystem result exceeds transport limit')
    const value = JSON.parse(output.text) as { result?: unknown; error?: { code: FsErrorCode; message: string } }
    if (value.error) throw new FsError(value.error.message, value.error.code)
    return value.result
  }
}
