/** Read-only process projections. Session ownership does not establish assignment or exact Agent-lifecycle ownership. */
import { EXECUTION_EVIDENCE_LIMIT, ExecutionEvidenceSchema, unavailableExecutionEvidence, type ExecutionEvidence,
  type RemoteExecutionEvidence } from '../supervision/execution-evidence.ts'
import { createHash } from 'node:crypto'

interface ObservedAgent { id: string; status: string; session: { header: { origin?: string; parentSession?: string } } }
interface Agents { get(id: string): ObservedAgent | undefined; list(): readonly ObservedAgent[] }
interface Job { id: string; owner?: string; status: string; output?: { total?: number } }
const digest = (rows: unknown[][]) => createHash('sha256').update(JSON.stringify(rows.sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0))).digest('hex')
export interface ExecutionEvidenceInput {
  sessionId: string; assignmentId: string | null
  agents: Agents
  jobs(): { list(caller: string): readonly Job[] } | undefined
  handedOff: ReadonlySet<string>
  executor: ExecutionEvidence['executor']
  remoteEffects(): RemoteExecutionEvidence
}

/** No asynchronous service discovery, restoration, output reads, endpoint calls, or authority changes are permitted here. */
export function collectExecutionEvidence(input: ExecutionEvidenceInput): ExecutionEvidence {
  const result = unavailableExecutionEvidence(input.sessionId, input.assignmentId)
  result.executor = { ...input.executor }
  try { result.remoteEffects = input.remoteEffects() } catch { /* Preserve unavailable, including absent managed worlds. */ }
  let agent: ObservedAgent | undefined
  try { agent = input.agents.get(input.sessionId) } catch { return ExecutionEvidenceSchema.parse(result) }
  if (!agent || agent.id !== input.sessionId) return ExecutionEvidenceSchema.parse(result)
  result.session.availability = 'available'; result.session.state = agent.status === 'running' || agent.status === 'idle' ? agent.status : 'unknown'
  try {
    const registry = input.jobs()
    if (registry) {
      const jobs = registry.list(input.sessionId)
      const identities: unknown[][] = []
      result.jobs.availability = 'available'; result.jobs.coverage = jobs.length > EXECUTION_EVIDENCE_LIMIT ? 'partial' : 'complete'
      result.jobs.outputBytes = 0
      for (const job of jobs.slice(0, EXECUTION_EVIDENCE_LIMIT)) {
        if (job.owner !== input.sessionId) continue // Harness also returns unowned jobs to every caller.
        result.jobs.sampled++
        const bytes = job.output?.total, validBytes = Number.isSafeInteger(bytes) && bytes! >= 0 ? bytes! : null
        identities.push([job.id, job.status, input.handedOff.has(job.id) ? null : validBytes, input.handedOff.has(job.id)])
        if (input.handedOff.has(job.id)) {
          if (job.status === 'running' || job.status === 'stopping') result.jobs.handedOff[job.status]++
          continue
        }
        const state = job.status
        if (state === 'running' || state === 'stopping' || state === 'completed' || state === 'killed' || state === 'failed') result.jobs.counts[state]++
        else result.jobs.counts.unknown++
        result.jobs.outputBytes = validBytes === null || result.jobs.outputBytes === null ? null
          : Math.min(Number.MAX_SAFE_INTEGER, result.jobs.outputBytes + validBytes)
      }
      result.jobs.sampleRevision = digest(identities)
    }
  } catch { result.jobs = unavailableExecutionEvidence().jobs }
  try {
    const loaded = input.agents.list()
    const identities: unknown[][] = []
    result.subagents.availability = 'available'; result.subagents.coverage = 'loaded-only'
    result.subagents.truncated = loaded.length > EXECUTION_EVIDENCE_LIMIT
    for (const child of loaded.slice(0, EXECUTION_EVIDENCE_LIMIT)) {
      if (child === agent || child.session.header.origin !== 'subagent' || child.session.header.parentSession !== input.sessionId) continue
      if (input.agents.get(child.id) !== child) { result.subagents.truncated = true; continue }
      result.subagents.sampled++
      identities.push([child.id, child.status])
      if (child.status === 'running' || child.status === 'idle') result.subagents.counts[child.status]++
      else result.subagents.counts.unknown++
    }
    result.subagents.sampleRevision = digest(identities)
  } catch { result.subagents = unavailableExecutionEvidence().subagents }
  // A replaced parent invalidates this sample. Job attribution still remains Session-only even when the parent is current.
  try {
    if (input.agents.get(input.sessionId) !== agent) {
      const unavailable = unavailableExecutionEvidence(input.sessionId, input.assignmentId)
      result.session = unavailable.session; result.jobs = unavailable.jobs; result.subagents = unavailable.subagents
    }
  } catch {
    const unavailable = unavailableExecutionEvidence(input.sessionId, input.assignmentId)
    result.session = unavailable.session; result.jobs = unavailable.jobs; result.subagents = unavailable.subagents
  }
  return ExecutionEvidenceSchema.parse(result)
}
