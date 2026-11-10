import { posix } from 'node:path'
import type { ManagedWorld } from '../environments/pool.ts'
import { fingerprint } from '../remote/journal.ts'
import { RemoteSubprocess } from '../remote/subprocess.ts'
import { RemoteError, type RemoteJob, type OutputWindow } from '../remote/protocol.ts'
import { RepositoryBundle, REPOSITORY_EXPORT_LIMITS as L, type RepositoryExportRecord } from './repository-export-model.ts'
import { REPOSITORY_EXPORT_PROGRAM } from './repository-export-program.ts'

export const exportDirectory = (member: ManagedWorld, id: string) => posix.join(member.world.grant.root, '.repository-export-' + id)
/** Replay observes one original export job. Unknown or failed work is never replaced by a second bundle command. */
export async function repositoryExportJob(member: ManagedWorld, record: RepositoryExportRecord, signal: AbortSignal): Promise<RepositoryBundle> {
  const { world, subprocess } = member, root = world.grant.root, client = world.executionClient()
  if (!(subprocess instanceof RemoteSubprocess)) throw new Error('Repository export requires paired remote execution')
  const argv = ['node', '-e', REPOSITORY_EXPORT_PROGRAM, JSON.stringify({ root, directory: record.directory,
    output: exportDirectory(member, record.id), base: record.source.commit, head: record.head, tree: record.tree, maxBytes: L.bytes })]
  let job: RemoteJob | undefined
  try { job = await client.call<RemoteJob>({ op: 'job.get', id: record.commandId }, signal) }
  catch (error) { if (!(error instanceof RemoteError) || error.code !== 'not_found') throw error }
  if (!job) {
    const handle = subprocess.spawnIntent(record.commandId, { argv, cwd: root, graceMs: 2000, signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    await handle.done
    if (!await handle.waitForExit(signal)) throw new Error('Repository export has not stopped')
    job = await client.call<RemoteJob>({ op: 'job.get', id: record.commandId }, signal)
  }
  for (;;) {
    if (job.id !== record.commandId || job.grantId !== world.grant.id || job.epoch !== world.grant.epoch || job.request.cwd !== root
      || fingerprint(job.request.argv) !== fingerprint(argv) || Object.keys(job.request.env).length || job.request.verification || job.request.stdin !== undefined)
      throw new Error('Repository export receipt differs from the original intent')
    if (job.phase === 'unknown') throw new Error('Repository export outcome is unknown; reconcile its original receipt')
    if (job.phase === 'settled' && job.quiescent) break
    signal.throwIfAborted(); await new Promise(resolve => setTimeout(resolve, 100))
    job = await client.call<RemoteJob>({ op: 'job.get', id: record.commandId }, signal)
  }
  if (job.outcome?.exitCode !== 0) throw new Error('Repository export failed; inspect the original receipt and preserved files')
  const output = await client.call<OutputWindow>({ op: 'job.output', id: record.commandId, stream: 'stdout', offset: 0, limit: 4096 }, signal)
  if (output.gap || output.offset || output.totalBytes !== output.nextOffset) throw new Error('Repository export metadata is incomplete')
  const bundle = RepositoryBundle.parse(JSON.parse(Buffer.from(output.data, 'base64').toString('utf8')))
  if (bundle.base !== record.source.commit || bundle.head !== record.head || bundle.tree !== record.tree) throw new Error('Repository export metadata changed')
  return bundle
}
