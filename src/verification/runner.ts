/** Runs host-selected checks against a captured workspace using the existing Harness process provider. */
import { mkdir, lstat, readdir, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { SubprocessRuntime, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ExecutionIsolation } from '../remote/isolation.ts'
import type { VerificationJob, CheckEvidence, SnapshotManifest } from './model.ts'
import { sameSnapshotFiles, validateSnapshot } from './snapshot.ts'

interface Host {
  subprocess: SubprocessRuntime; isolation: ExecutionIsolation; helper: string; storageRoot: string; lifetime: AbortSignal
  authorize(): Promise<void>; signal: AbortSignal
  checkpoint(evidence: CheckEvidence): void
  live(handle: SubprocessHandle | undefined): void
  output(stream: 'stdout' | 'stderr', bytes: Buffer): void
}
export interface CheckInput { id: string; root: string; source: string; argv: string[]; env: Record<string, string | null>; stdin?: string; spec: VerificationJob }
export interface CheckResult { evidence: CheckEvidence; quiescent: boolean; outcome?: { exitCode: number | null; signal: string | null }; problem?: string }
/** Remove only private copied inputs after process quiescence; never follow a link while making directories removable. */
export async function discardSnapshot(path: string): Promise<void> {
  const unlock = async (directory: string): Promise<void> => {
    const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info?.isDirectory()) return
    await chmod(directory, 0o700)
    for (const name of await readdir(directory)) await unlock(join(directory, name))
  }
  await unlock(path); await rm(path, { recursive: true, force: true })
}
/** Each process dispatch has a durable checkpoint; no failed or interrupted attempt is replayed here. */
export async function runCapturedCheck(input: CheckInput, host: Host): Promise<CheckResult> {
  const evidence: CheckEvidence = { kind: input.spec.kind, stage: 'capturing', confinement: host.isolation.name, startedAt: new Date().toISOString() }
  const container = join(host.storageRoot, input.id), copy = join(container, 'workspace'), scratch = join(container, 'scratch')
  let quiescent = true, createdContainer = false, active: SubprocessHandle | undefined, outcome: CheckResult['outcome']
  const output = { stdout: { hash: createHash('sha256'), bytes: 0 }, stderr: { hash: createHash('sha256'), bytes: 0 } }
  let ranCheck = false
  const total = AbortSignal.any([host.signal, host.lifetime, AbortSignal.timeout((2 * input.spec.snapshot.timeoutSeconds + input.spec.timeoutSeconds + 10) * 1000)])
  const run = async (argv: readonly string[], cwd: string, data: string | undefined, timeoutMs: number, capture: boolean): Promise<string> => {
    await host.authorize(); total.throwIfAborted()
    host.checkpoint(evidence) // Persist the uncertainty boundary before handing the process to Harness.
    quiescent = false
    const signal = AbortSignal.any([total, AbortSignal.timeout(timeoutMs)])
    active = host.subprocess.spawn({ argv, cwd, signal, graceMs: 1000,
      stdio: { stdin: data === undefined ? 'ignore' : { data }, stdout: capture ? { maxBytes: 4 * 1024 * 1024 } : 'pipe', stderr: capture ? { maxBytes: 65536 } : 'pipe' } })
    host.live(active)
    if (!capture) {
      ranCheck = true
      for (const stream of ['stdout', 'stderr'] as const) active[stream]?.on('data', (value: Buffer) => {
        const bytes = Buffer.from(value); output[stream].hash.update(bytes); output[stream].bytes += bytes.length; host.output(stream, bytes)
      })
    }
    const handle = active, result = await handle.done
    quiescent = await handle.waitForExit(AbortSignal.any([host.lifetime, AbortSignal.timeout(5000)]))
    if (!quiescent) throw new Error('Verification process range has not reached quiescence')
    host.live(undefined); active = undefined
    if (!capture) outcome = result
    signal.throwIfAborted() // A timeout-triggered termination cannot pass by trapping the signal and returning zero.
    if (!capture) return ''
    return activeOutput(result, handle.collected)
  }
  const activeOutput = (result: { exitCode: number | null }, output: SubprocessHandle['collected']) => {
    const text = output.stdout?.readFrom(0)
    if (result.exitCode !== 0 || !text || text.lossy) throw new Error(output.stderr?.readFrom(0).text.slice(0, 2000) || text?.text.slice(0, 2000) || 'Snapshot helper failed')
    return text.text
  }
  const collect = async (root: string, source: string, destination?: string): Promise<SnapshotManifest> => {
    const node = await host.subprocess.resolveExecutable('node', undefined, total)
    const argv = await host.isolation.wrap([node, '/run/dsh-filesystem.mjs'], root, root, false, total, {}, host.helper, [],
      { readOnly: true, temporaryDirectory: scratch, ...(destination ? { writableSnapshot: container } : {}) })
    const text = await run(argv, root, JSON.stringify({ source, destination, spec: { ...input.spec.snapshot, ...destination ? {} : { repository: 'none' } } }),
      input.spec.snapshot.timeoutSeconds * 1000, true)
    const value = JSON.parse(text) as { result?: unknown; error?: string }
    if (!value.result || value.error) throw new Error(value.error ?? 'Snapshot helper omitted its result')
    return validateSnapshot(value.result)
  }
  try {
    await host.authorize(); total.throwIfAborted()
    host.checkpoint(evidence) // Preparation itself is durable: a restart must not replay a partly created snapshot.
    // The parent is service-owned; a request ID may never reuse an existing private copy.
    await mkdir(host.storageRoot, { recursive: true, mode: 0o700 })
    try { await mkdir(container, { mode: 0o700 }); createdContainer = true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        quiescent = false // Existing copied inputs may still belong to an unobserved process; never remove or reuse them.
        throw new Error('Snapshot storage already exists; reconcile the original process range before cleanup')
      }
      throw error
    }
    await mkdir(scratch, { mode: 0o700 })
    evidence.snapshot = await collect(input.root, input.source, copy)
    if (input.spec.expectedSnapshot && evidence.snapshot.hash !== input.spec.expectedSnapshot) throw new Error('Captured source no longer matches the reviewed snapshot')
    if (input.spec.expectedRepository && (evidence.snapshot.repository?.commit !== input.spec.expectedRepository.commit
      || input.spec.expectedRepository.tree && evidence.snapshot.repository?.tree !== input.spec.expectedRepository.tree))
      throw new Error('Captured Git commit or tree no longer matches the reviewed revision')
    if (input.spec.artifact) {
      const entry = evidence.snapshot.entries.find(entry => entry.path === input.spec.artifact!.path && entry.kind === 'file')
      if (!entry || entry.hash !== input.spec.artifact.hash) throw new Error('Captured artifact bytes do not match the approved library hash')
      evidence.artifactHash = entry.hash
    }
    if (input.spec.kind === 'check') {
      evidence.stage = 'checking'; evidence.checkedAt = new Date().toISOString(); await host.authorize(); total.throwIfAborted()
      const argv = await host.isolation.wrap(input.argv, copy, copy, false, total, input.env, undefined, [], { readOnly: true, temporaryDirectory: scratch })
      await run(argv, copy, input.stdin, input.spec.timeoutSeconds * 1000, false)
      const after = await collect(copy, copy)
      evidence.snapshotUnchanged = sameSnapshotFiles(evidence.snapshot, after)
      if (!evidence.snapshotUnchanged) throw new Error('Verification command changed its captured input snapshot')
    } else evidence.snapshotUnchanged = true // Capturing bytes is not a successful command execution.
    evidence.stage = 'finished'; host.checkpoint(evidence)
    return { evidence, outcome, quiescent }
  } catch (error) {
    if (active) {
      try { active.terminate(); quiescent = await active.waitForExit(AbortSignal.any([host.lifetime, AbortSignal.timeout(5000)])) } catch { quiescent = false }
      if (quiescent) host.live(undefined)
    }
    evidence.problem = error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)
    return { evidence, outcome, quiescent, problem: evidence.problem }
  } finally {
    evidence.finishedAt = new Date().toISOString()
    if (ranCheck && quiescent) evidence.output = { stdout: { hash: output.stdout.hash.digest('hex'), bytes: output.stdout.bytes },
      stderr: { hash: output.stderr.hash.digest('hex'), bytes: output.stderr.bytes } }
    if (quiescent && createdContainer) {
      try { await discardSnapshot(container); evidence.storageReleased = true } catch { /* Keep the reservation charged until private storage is removed. */ }
    } else if (quiescent) evidence.storageReleased = true
  }
}
