/** Optional ordered trace of worker admission. Silent unless DSH_ADMISSION_TRACE is a file path. */
import { appendFileSync } from 'node:fs'

const file = process.env.DSH_ADMISSION_TRACE
const identities = new WeakMap<object, number>()
let next = 0
const started = Date.now()

export function traceAgent(agent: unknown): number | undefined {
  if (!agent || typeof agent !== 'object') return undefined
  const known = identities.get(agent)
  if (known) return known
  const id = ++next
  identities.set(agent, id)
  return id
}

export function admissionTrace(event: string, detail: Record<string, unknown> = {}): void {
  if (!file) return
  const line = JSON.stringify({ ms: Date.now() - started, event, ...detail }) + '\n'
  try { appendFileSync(file, line) } catch { /* The trace is evidence, not a launch dependency. */ }
}
