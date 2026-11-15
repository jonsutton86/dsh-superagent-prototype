/** Opt-in native subprocess contract for preparation outcome observation. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.runIf(!!process.env.DSH_PREPARATION_HARNESS_PACKAGE)('distinguishes native command failure from a surviving Harness-managed descendant', async () => {
  const result = await promisify(execFile)(process.execPath, [resolve('tests/fixtures/preparation-harness.mjs'), process.env.DSH_PREPARATION_HARNESS_PACKAGE!],
    { timeout: 20000, maxBuffer: 1024 * 1024 })
  const line = result.stdout.split('\n').find(value => value.startsWith('PREPARATION_HARNESS '))
  expect(line).toBeDefined()
  const receipt = JSON.parse(line!.slice('PREPARATION_HARNESS '.length))
  expect(receipt.cleanup).toBe('all-owned-ranges-empty')
  expect(receipt.results).toHaveLength(2)
  expect(receipt.results[0].outcome.quiescence).toBe('confirmed')
  expect(receipt.results[1]).toMatchObject({ outcome: { command: 'exited', quiescence: 'unknown' }, eventualManagedRangeEmpty: true })
}, 25000)

it.runIf(!!process.env.DSH_PREPARATION_HARNESS_PACKAGE)('keeps the original preparation intent held after database reopen while its native range is alive', async () => {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Store } = await import('../src/app/store.ts')
  const { Effects } = await import('../src/app/effects.ts')
  const { HealthBoard } = await import('../src/infra/health.ts')
  const { ExecutorStops } = await import('../src/executor/stops.ts')
  const { readStop, validateStopAuthority } = await import('../src/executor/stop-store.ts')
  const requireHarness = createRequire(join(process.env.DSH_PREPARATION_HARNESS_PACKAGE!, 'package.json'))
  const { Context } = await import(pathToFileURL(requireHarness.resolve('@deepseek-ai/cordis')).href)
  const { default: LocalSubprocessRuntime } = await import(pathToFileURL(requireHarness.resolve('@deepseek-ai/dsh-subprocess-local')).href)
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'preparation-reopen-')), path = join(root, 'state.sqlite')
  let store = new Store(path)
  let handle: import('@deepseek-ai/dsh-subprocess').SubprocessHandle | undefined
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    const ticket = { id: 'native-preparation', title: 'Native preparation', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), inputs: [], undelivered: [],
      assignments: [{ id: 'original', state: 'pending', createdAt: new Date().toISOString(), execution: { directory: root, mode: 'local' } }] } as unknown as import('../src/core/index.ts').Ticket
    store.tickets.save(ticket)
    const context = { agents: new Map(), get: () => undefined } as unknown as import('@deepseek-ai/cordis').Context
    const host = () => ({ store, context, effects: new Effects(store, new HealthBoard()), signal: new AbortController().signal,
      remote: () => undefined, authorize: () => {}, authorizeObservation: () => {}, closing: () => false })
    const firstHost = host(), original = new ExecutorStops(firstHost)
    firstHost.effects.ensure('launch', 'original', { ticketId: ticket.id, assignmentId: 'original' })
    firstHost.effects.beginLaunch('original')
    const command = '/bin/sleep 2 >/dev/null 2>&1 & exit 9'
    const id = original.beginPreparation(ticket, ticket.assignments[0]!, command)
    expect(readStop(store.db, id)?.preparation?.phase).toBe('intent')
    handle = ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', command], cwd: root, env: {}, graceMs: 100,
      signal: AbortSignal.timeout(10000), stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    expect((await handle!.done).exitCode).toBe(9)
    expect(await handle!.waitForExit(AbortSignal.timeout(100))).toBe(false)
    // Lose coordinator memory and reopen durable authority without transferring the original process handle.
    store.close(); store = new Store(path)
    const recovered = new ExecutorStops(host())
    recovered.recover(); await recovered.idle()
    expect(await recovered.recheck(id)).toMatchObject({ id, state: 'unknown', proof: null })
    expect(() => recovered.beforeAdmission(ticket.id, 'original')).toThrow('Original work is not confirmed stopped')
    // Even a real later exit cannot be claimed by a new coordinator that lacks the original handle's authority.
    expect(await handle!.waitForExit(AbortSignal.timeout(5000))).toBe(true)
    recovered.finishPreparation(id, { command: 'exited', exitCode: 9, quiescence: 'confirmed' })
    expect(await recovered.recheck(id)).toMatchObject({ id, state: 'unknown', proof: null })
    expect(recovered.list(ticket.id).items.map(item => item.id)).toEqual([id])
    validateStopAuthority(store.db, new Map([[ticket.id, store.tickets.get(ticket.id)!]]), () => {})
  } finally {
    let quiet = !handle
    try {
      if (handle) { handle.terminate(); quiet = await handle.waitForExit(AbortSignal.timeout(5000)); expect(quiet, 'Retained native recovery evidence: ' + root).toBe(true) }
    } finally {
      await ctx.fiber.dispose(); store.close()
      if (quiet) await rm(root, { recursive: true, force: true })
    }
  }
}, 25000)
