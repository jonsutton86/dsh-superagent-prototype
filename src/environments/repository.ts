import { posix } from 'node:path'
import { fingerprint } from '../remote/journal.ts'
import { RemoteError, type RemoteJob, type OutputWindow } from '../remote/protocol.ts'
import type { RemoteSubprocess } from '../remote/subprocess.ts'
import type { RemoteWorld } from '../remote/world.ts'
import { repositoryCredential, type RepositorySource } from './repository-model.ts'
import { REPOSITORY_PROGRAM } from './repository-program.ts'

/** One durable endpoint preparation intent per task, including through response loss and coordinator replacement. */
export async function prepareRepository(world: RemoteWorld, source: RepositorySource, directory: string, ticketId: string,
  lifetime: AbortSignal, subprocess: RemoteSubprocess): Promise<void> {
  const root = world.grant.root, binding = world.status().binding
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(ticketId) || posix.dirname(directory) !== root || directory.includes('\0'))
    throw new Error('Repository task must be a direct child of its original execution world')
  const id = 'repository-' + fingerprint({ binding, ticketId }), client = world.executionClient()
  const credential = repositoryCredential(source, world.grant)
  const config = { root, directory, source, branch: 'agentic/' + ticketId, staging: posix.join(root, '.' + id), ...(credential ? { credential } : {}) }
  const argv = ['node', '-e', REPOSITORY_PROGRAM, JSON.stringify(config)]
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(180_000)])
  let submitted = false, complete = false
  world.commands.assertReady()
  try {
    let job: RemoteJob | undefined
    try { job = await client.call<RemoteJob>({ op: 'job.get', id }, signal) }
    catch (error) { if (!(error instanceof RemoteError) || error.code !== 'not_found') throw error }
    if (!job) {
      submitted = true
      const handle = subprocess.spawnIntent(id, { argv, cwd: root, graceMs: 2000, signal,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
      await handle.done
      if (!await handle.waitForExit(signal)) throw new Error('Repository preparation has not reached quiescence')
      job = await client.call<RemoteJob>({ op: 'job.get', id }, signal)
    }
    for (;;) {
      if (job.id !== id || job.grantId !== world.grant.id || job.epoch !== world.grant.epoch || job.request.cwd !== root
        || fingerprint(job.request.argv) !== fingerprint(argv) || Object.keys(job.request.env).length || job.request.verification || job.request.stdin !== undefined)
        throw new Error('Repository preparation receipt differs from the original task and source')
      if (job.phase === 'unknown') throw new Error('Repository preparation was interrupted; inspect its original receipt and files before authorizing new work')
      if (job.phase === 'settled' && job.quiescent) {
        complete = true
        if (job.outcome?.exitCode !== 0) {
          const output = await client.call<OutputWindow>({ op: 'job.output', id, stream: 'stderr', offset: 0, limit: 4096 }, signal).catch(() => undefined)
          const phase = output && /Repository preparation failed during (configuration|initialization|fetch|commit verification|checkout|durable publication)\./.exec(Buffer.from(output.data, 'base64').toString('utf8'))?.[1]
          throw new Error('Repository preparation failed' + (phase ? ' during ' + phase : '') + '; inspect its original receipt. Existing files were preserved')
        }
        return
      }
      submitted = true
      signal.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 100))
      job = await client.call<RemoteJob>({ op: 'job.get', id }, signal)
    }
  } catch (error) {
    if (submitted && !complete) {
      await client.intent({ op: 'job.cancel', id, requestId: 'cancel-' + id }, AbortSignal.timeout(2000)).catch(() => {})
    }
    throw error
  }
}
