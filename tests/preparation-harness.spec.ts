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
