/** Native Harness subprocess evidence; no provider traffic or user-profile access. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { preparationOutcome } from '../../src/executor/preparation-outcome.ts'

const requireHarness = createRequire(join(process.argv[2], 'package.json'))
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: LocalSubprocessRuntime } = await load('@deepseek-ai/dsh-subprocess-local')
const ctx = new Context(), handles = []
const results = []
try {
  await ctx.plugin(LocalSubprocessRuntime)
  const spawn = command => {
    const handle = ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', command], cwd: process.cwd(),
      env: {}, graceMs: 100, signal: AbortSignal.timeout(10000), stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
    handles.push(handle); return handle
  }
  const failed = spawn('exit 7')
  const settled = await preparationOutcome(failed, AbortSignal.timeout(5000))
  assert.deepEqual(settled, { command: 'exited', exitCode: 7, quiescence: 'confirmed' })
  results.push({ case: 'failed-command-empty-range', outcome: settled })
  // The direct command closes its stdio and exits while a descendant retains the original managed range.
  const lingering = spawn('/bin/sleep 2 >/dev/null 2>&1 & exit 9')
  assert.equal((await lingering.done).exitCode, 9)
  const held = await preparationOutcome(lingering, AbortSignal.timeout(100))
  assert.deepEqual(held, { command: 'exited', exitCode: 9, quiescence: 'unknown' })
  assert.equal(await lingering.waitForExit(AbortSignal.timeout(5000)), true)
  results.push({ case: 'exited-command-live-descendant', outcome: held, eventualManagedRangeEmpty: true })
} finally {
  for (const handle of handles) {
    handle.terminate()
    assert.equal(await handle.waitForExit(AbortSignal.timeout(5000)), true, 'Owned native range cleanup must be confirmed')
  }
  await ctx.fiber.dispose()
}
process.stdout.write('PREPARATION_HARNESS ' + JSON.stringify({ results, cleanup: 'all-owned-ranges-empty' }) + '\n')
