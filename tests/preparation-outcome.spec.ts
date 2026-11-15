import { expect, it, vi } from 'vitest'
import { preparationOutcome } from '../src/executor/preparation-outcome.ts'

it('retains nonzero command exit separately from confirmed managed-range termination', async () => {
  const waitForExit = vi.fn(async () => true)
  expect(await preparationOutcome({ done: Promise.resolve({ exitCode: 3, signal: null }), waitForExit }, new AbortController().signal))
    .toEqual({ command: 'exited', exitCode: 3, quiescence: 'confirmed' })
  expect(waitForExit).toHaveBeenCalledOnce()
})
it.each([false, 'throw'])('does not infer quiet from successful command exit when observation is %s', async mode => {
  const waitForExit = async () => { if (mode === 'throw') throw new Error('unavailable'); return false }
  expect(await preparationOutcome({ done: Promise.resolve({ exitCode: 0, signal: null }), waitForExit }, new AbortController().signal))
    .toEqual({ command: 'exited', exitCode: 0, quiescence: 'unknown' })
})
it('holds a rejected command outcome without probing or retrying', async () => {
  const waitForExit = vi.fn(async () => true)
  expect(await preparationOutcome({ done: Promise.reject(new Error('response lost')), waitForExit }, new AbortController().signal))
    .toEqual({ command: 'unknown', exitCode: null, quiescence: 'unknown' })
  expect(waitForExit).not.toHaveBeenCalled()
})
it('bounds an unresponsive range observation without claiming termination', async () => {
  const controller = new AbortController()
  let entered!: () => void
  const observed = new Promise<void>(resolve => { entered = resolve })
  const result = preparationOutcome({ done: Promise.resolve({ exitCode: 1, signal: null }),
    waitForExit: () => { entered(); return new Promise<boolean>(() => {}) } }, controller.signal)
  await observed; controller.abort()
  expect(await result).toEqual({ command: 'exited', exitCode: 1, quiescence: 'unknown' })
})
