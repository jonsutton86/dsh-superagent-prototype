import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'

const { endurancePlan, enduranceStatus, runEndurance, enduranceCompletionState } = await import(pathToFileURL(resolve('scripts/supervision-endurance.mjs')).href)

it('plans an eight-hour isolated endurance run without traffic and refuses durations that cannot cover restart recovery', () => {
  expect(endurancePlan()).toMatchObject({ mode: 'plan', modelTraffic: false, durationSeconds: 28800, chunkSeconds: 1200, jobCompletion: 'native_notice_then_one_nonwaiting_read', effectiveJobWaitCapMs: 5000,
    watchdog: { reviewEveryMs: 3600000 } })
  expect(endurancePlan(120).limits).toMatchObject({ sampleRecordBytes: 8192, workerMaxGapSeconds: 10, globalGraceSeconds: 130 })
  expect(endurancePlan().chunks).toHaveLength(24)
  expect(endurancePlan(120, 60).chunks).toEqual([{ index: 0, seconds: 60 }, { index: 1, seconds: 60 }])
  for (const chunk of [59, 1201, Infinity]) expect(() => endurancePlan(120, chunk)).toThrow()
  for (const duration of [0, 60, 119, 120.1, 86401, Infinity]) expect(() => endurancePlan(duration)).toThrow()
})

it('refuses to execute into an existing output directory before accessing any runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'endurance output guard '))
  try { await expect(runEndurance({ dsh: '/does-not-exist', output: directory, durationSeconds: 120 })).rejects.toThrow() }
  finally { await rm(directory, { recursive: true, force: true }) }
})
it('reports the last recorded chunk and supervision activity without asserting process liveness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'endurance status '))
  try {
    await writeFile(join(directory, 'report.json'), JSON.stringify({ runId: 'synthetic', state: 'running', heartbeatAt: new Date().toISOString(),
      plan: { chunks: [{}, {}, {}] }, latestObservation: { startedChunks: 2, monitorReachable: true }, provider: { completedChunks: 1, nativeWakes: 1, jobOutput: 1 } }))
    expect(await enduranceStatus(directory)).toMatchObject({ liveness: 'unknown_from_report_only',
      chunks: { planned: 3, started: 2, completed: 1, nativeWakes: 1, outputReads: 1 }, latestObservation: { monitorReachable: true } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('cannot qualify a late internal abort or uncertain cleanup after productive verification', () => {
  const result = { verified: true, failed: false, aborted: false, cancelled: false, cleanupConfirmed: true }
  expect(enduranceCompletionState(result)).toBe('completed')
  for (const change of [{ aborted: true }, { failed: true }, { cleanupConfirmed: false }]) expect(enduranceCompletionState({ ...result, ...change })).toBe('failed')
  expect(enduranceCompletionState({ ...result, cancelled: true })).toBe('cancelled')
})


const { enduranceWorker } = await import(pathToFileURL(resolve('tests/fixtures/supervision-endurance-provider.mjs')).href)
it('ends the worker turn and consumes each exact native job notice only once, including a completion already injected with the bash result', () => {
  const worker = enduranceWorker({ commands: ['first', 'last'], proof: 'proof' })
  const tool = (content: string) => ({ role: 'tool', content })
  // Official rc.3 tool-jobs fitCompletionNotice untruncated wire format; output is separately validated.
  const notice = (id: string) => ({ role: 'user', content: `background job ${id} (bash: Run synthetic endurance chunk) finished [status: completed, exit code: 0]. Read its output with job_output.` })
  expect(worker.next([])).toMatchObject({ name: 'bash', args: { command: 'first', run_in_background: true } })
  const first = [tool('started background job job-one')]
  expect(worker.next(first)).toHaveProperty('stop')
  expect(worker.snapshot()).toMatchObject({ jobOutput: 0, nativeWakes: 0 })
  expect(worker.next([...first, notice('job-one')])).toEqual({ name: 'job_output', args: { job_id: 'job-one', wait: false } })
  expect(worker.next([tool('ENDURANCE_CHUNK_DONE_0\n[status: completed, exit code: 0]')])).toMatchObject({ name: 'bash', args: { command: 'last' } })
  // A one-second remainder can finish before the continuation request; there must be no second wait for a lost notice.
  expect(worker.next([tool('started background job job-two'), notice('job-two')])).toEqual({ name: 'job_output', args: { job_id: 'job-two', wait: false } })
  expect(worker.next([tool('ENDURANCE_CHUNK_DONE_1\n[status: completed, exit code: 0]')])).toMatchObject({ name: 'workspace_publish' })
  expect(worker.next([tool('published')])).toMatchObject({ name: 'orchestrator_report' })
  expect(worker.next([])).toHaveProperty('stop')
  expect(worker.snapshot()).toMatchObject({ bash: 2, jobOutput: 2, nativeWakes: 2, completedChunks: 2, publish: 1, report: 1 })
})
it('refuses an unsolicited worker continuation and a nonterminal chunk output', () => {
  const worker = enduranceWorker({ commands: ['one'], proof: 'proof' })
  worker.next([]); worker.next([{ role: 'tool', content: 'started background job original' }])
  expect(() => worker.next([{ role: 'user', content: 'background job another (bash: fake) finished [status: completed]. Read its output with job_output.' }])).toThrow('worker_woke_without_native_completion')
  worker.next([{ role: 'user', content: 'background job original (bash: real) finished [status: completed]. Read its output with job_output.' }])
  expect(() => worker.next([{ role: 'tool', content: 'ENDURANCE_CHUNK_DONE_0\n[status: running]' }])).toThrow('chunk_output_not_completed')
  for (const status of ['[status: completed, exit code: 1]', '[status: completed]']) {
    expect(() => worker.next([{ role: 'tool', content: 'ENDURANCE_CHUNK_DONE_0\n' + status }])).toThrow('chunk_output_not_completed')
  }
})

it.runIf(process.env.DSH_SUPERVISION_ENDURANCE_QUALIFICATION === '1')('qualifies two minutes of real productive work across watchdog faults and restart, then proves cancellation quiescence', async () => {
  const dsh = process.env.DSH_SUPERVISION_ENDURANCE_QUALIFICATION_CLI ?? process.env.DSH_ENDPOINT_QUALIFICATION_CLI
  if (!dsh) throw new Error('Supply the installed Harness qualification CLI')
  const directory = await mkdtemp(join(tmpdir(), 'dsh endurance acceptance ')), output = join(directory, 'completed'), cancelOutput = join(directory, 'cancelled')
  let safeToRemove = false
  try {
    const result = await runEndurance({ dsh, output, durationSeconds: 120, chunkSeconds: 60 })
    expect(result.state, JSON.stringify({ failure: result.failure, cleanup: result.cleanup, stage: result.stage })).toBe('completed')
    expect(result.outcome).toBe('qualified_scripted_duration'); expect(result.cleanup).toMatchObject({ state: 'completed', workerQuiescence: 'confirmed_group_absent' })
    expect(result.progress.monotonicSeconds).toBeGreaterThanOrEqual(120); expect(result.progress.wallSeconds).toBeGreaterThanOrEqual(120)
    expect(result.progress.chunks).toHaveLength(2)
    expect(result.progress.productiveMonotonicSeconds).toBeGreaterThanOrEqual(120)
    expect(result.progress.samples).toBeGreaterThanOrEqual(115); expect(result.progress.maximumWallGapMs).toBeLessThanOrEqual(10000)
    expect(result.progress.postCleanupDigestsVerified).toBe(true)
    expect(result.provider).toMatchObject({ bash: 2, jobOutput: 2, nativeWakes: 2, completedChunks: 2, publish: 1, report: 1, statusRequests: 0, failures: [], errors: 1, hangs: 1, aborted: 1 })
    expect(result.original).toMatchObject({ assignmentId: expect.any(String), deliveryHistoryFound: true, acknowledgement: { receipt: expect.any(Object) } })
    expect(result.phases.map((value: { name: string }) => value.name)).toEqual(expect.arrayContaining(['watchdog_provider_error', 'watchdog_provider_hang',
      'watchdog_assessment_recovery', 'watchdog_process_outage', 'watchdog_restored', 'productive_job_verified', 'settled_main_restart']))
    const status = await enduranceStatus(output)
    expect(status).toMatchObject({ state: 'completed', liveness: 'unknown_from_report_only', cleanup: { state: 'completed' } })
    expect((await stat(join(output, 'report.json'))).mode & 0o077).toBe(0)
    const observations = (await readFile(join(output, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(observations.some(value => value.plannedWatchOutage)).toBe(true)
    expect(observations.some(value => value.observation?.execution?.jobs?.counts?.running >= 1)).toBe(true)
    const controller = new AbortController(), cancellation = runEndurance({ dsh, output: cancelOutput, durationSeconds: 120, signal: controller.signal })
    await vi.waitFor(async () => {
      const report = JSON.parse(await readFile(join(cancelOutput, 'report.json'), 'utf8'))
      expect(report.progress.workerStart?.runId).toBe(report.runId); expect(report.progress.workerStart?.pid).toBeGreaterThan(1)
    }, { timeout: 60000, interval: 100 })
    controller.abort()
    const cancelled = await cancellation
    expect(cancelled).toMatchObject({ state: 'cancelled', outcome: 'incomplete_or_unknown', cleanup: { state: 'completed', workerQuiescence: 'confirmed_group_absent' } })
    expect((await enduranceStatus(cancelOutput)).state).toBe('cancelled')
    process.stdout.write('ENDURANCE_QUALIFICATION ' + JSON.stringify({ durationSeconds: 120, chunks: 2, nativeWakes: result.provider.nativeWakes, jobOutput: result.provider.jobOutput, productiveMonotonicSeconds: result.progress.productiveMonotonicSeconds, monotonicSeconds: result.progress.monotonicSeconds,
      wallSeconds: result.progress.wallSeconds, samples: result.progress.samples, maximumWallGapMs: result.progress.maximumWallGapMs,
      snapshotManifestSha256: result.snapshot.manifestSha256, completion: result.cleanup, cancellation: cancelled.cleanup }) + '\n')
    safeToRemove = true
  } finally {
    // Keep evidence when cleanup is unknown; never delete a possibly active worker's lease/workspace.
    if (safeToRemove) await rm(directory, { recursive: true, force: true })
  }
}, 360000)
