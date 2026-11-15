/** Observe the original preparation handle; command exit is separate from managed-range termination. */
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

export interface PreparationOutcome {
  command: 'exited' | 'unknown'
  exitCode: number | null
  quiescence: 'confirmed' | 'unknown'
}

/** Observation only: never spawns, terminates, retries, or treats a missing response as success. */
export async function preparationOutcome(handle: Pick<SubprocessHandle, 'done' | 'waitForExit'>,
  signal: AbortSignal): Promise<PreparationOutcome> {
  let abort!: () => void
  const interrupted = new Promise<undefined>(resolve => { abort = () => resolve(undefined) })
  signal.addEventListener('abort', abort, { once: true })
  const done = handle.done.catch(() => undefined)
  try {
    if (signal.aborted) return { command: 'unknown', exitCode: null, quiescence: 'unknown' }
    const exited = await Promise.race([done, interrupted])
    if (!exited) return { command: 'unknown', exitCode: null, quiescence: 'unknown' }
    // Even a provider that ignores the wait signal cannot make observation unbounded.
    const quiet = signal.aborted ? false : await Promise.race([
      Promise.resolve().then(() => handle.waitForExit(signal)).catch(() => false), interrupted,
    ])
    return { command: 'exited', exitCode: exited.exitCode, quiescence: quiet === true ? 'confirmed' : 'unknown' }
  } finally { signal.removeEventListener('abort', abort) }
}
