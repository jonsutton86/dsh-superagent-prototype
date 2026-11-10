import type { ReactNode } from 'react'
import { EXECUTION_EVIDENCE_LIMIT, type ExecutionEvidence } from './execution-evidence.ts'

function Facts({ title, rows }: { title: string; rows: [string, ReactNode][] }) {
  return <table className="wd-evidence-table"><caption>{title}</caption><tbody>{rows.map(([name, value]) =>
    <tr key={name}><th scope="row">{name}</th><td>{value}</td></tr>)}</tbody></table>
}
const yesNo = (value: boolean) => value ? 'Yes' : 'No'
const amount = (value: number | null) => value === null ? 'Unknown' : value.toLocaleString()

/** Presents bounded host observations without turning activity, missing data, or Session membership into task progress. */
export function ExecutionEvidenceView({ evidence }: { evidence?: ExecutionEvidence }) {
  if (!evidence) return <section className="wd-execution" aria-label="Execution observations"><h3>Execution observations</h3>
    <p>Execution observations are unavailable in this snapshot.</p></section>
  const { session, jobs, subagents, executor, remoteEffects: remote } = evidence
  return <section className="wd-execution" aria-label="Execution observations"><h3>Execution observations</h3>
    <p>Host observations support assessment. Activity alone does not prove useful progress.</p>
    <Facts title="Observed work" rows={[
      ['Task assignment', evidence.assignmentId ?? 'Unknown'], ['Session', session.id],
      ['Session state', session.availability === 'unavailable' ? 'Unavailable' : session.state],
    ]} />
    <p className="wd-muted">Session activity may belong to earlier work. Its assignment attribution is unknown.</p>
    <h4>Session jobs</h4>
    {jobs.availability === 'unavailable' ? <p>Session jobs unavailable. Counts and output activity are unknown.</p> : <>
      <p>{jobs.sampled} job records observed · {jobs.coverage === 'complete' ? 'Complete available snapshot' : 'Partial snapshot'} · limit {EXECUTION_EVIDENCE_LIMIT} records.</p>
      <Facts title="Job states" rows={[
        ['Running', jobs.counts.running], ['Stopping', jobs.counts.stopping], ['Completed', jobs.counts.completed],
        ['Killed', jobs.counts.killed], ['Failed', jobs.counts.failed], ['Unknown state', jobs.counts.unknown],
        ['Handed-off jobs running', jobs.handedOff.running], ['Handed-off jobs stopping', jobs.handedOff.stopping],
        ['Observed output bytes', amount(jobs.outputBytes)],
      ]} />
      <p className="wd-muted">These jobs belong to the Session. Assignment and execution-attempt attribution are unknown. Output bytes show captured activity, not verified results.</p>
    </>}
    <h4>Subagents</h4>
    {subagents.availability === 'unavailable' ? <p>Subagent observations unavailable. Counts are unknown.</p> : <>
      <p>Loaded subagents only: {subagents.sampled} observed{subagents.truncated ? ' · more records omitted' : ''}. Unloaded subagents are not covered.</p>
      <Facts title="Loaded subagent states" rows={[
        ['Running', subagents.counts.running], ['Idle', subagents.counts.idle], ['Unknown state', subagents.counts.unknown],
      ]} />
      <p className="wd-muted">Linked by observed Session relationships; assignment attribution is unknown. At most {EXECUTION_EVIDENCE_LIMIT} loaded Session records were examined.</p>
    </>}
    {executor.availability === 'unavailable' ? <><h4>Coordinator activity</h4><p>Coordinator activity unavailable. Retry counts and work state are unknown.</p></> : <><Facts title="Coordinator activity" rows={[
      ['Preparing work', yesNo(executor.preparing)], ['Retry pending', yesNo(executor.retrying)],
      ['Turn retry attempts', executor.turnRetryAttempts], ['Launch retry attempts', executor.launchRetryAttempts],
      ['Finishing work', yesNo(executor.settling)], ['Stopping work', yesNo(executor.stopping)],
      ['Known handed-off jobs', executor.knownHandedOffJobs],
    ]} />
    <p className="wd-muted">Observed in this coordinator process. These flags are not durable completion evidence.</p></>}
    <h4>Remote operations</h4>
    {remote.availability === 'not_applicable' ? <p>Remote operations do not apply to this assignment.</p>
      : remote.availability === 'unavailable' ? <p>Remote operation observations unavailable. Outcomes and whether work has stopped are unknown.</p> : <>
        <p>Attributed to this task assignment. {remote.sampled} operations observed · {remote.coverage === 'complete' ? 'Complete available snapshot' : 'Partial snapshot'} · limit {EXECUTION_EVIDENCE_LIMIT} records.</p>
        <Facts title="Remote operation phases" rows={[
          ['Pending', remote.phases.pending], ['Accepted', remote.phases.accepted], ['Started', remote.phases.started],
          ['Outcome recorded', remote.phases.settled], ['Refused', remote.phases.refused], ['Unknown phase', remote.phases.unknown],
        ]} />
        <Facts title="Remote operation outcomes" rows={[
          ['Succeeded', remote.outcomes.succeeded], ['Failed', remote.outcomes.failed],
          ['Ended by signal', remote.outcomes.signalled], ['Unknown outcome', remote.outcomes.unknown],
          ['Confirmed stopped', remote.quiescence.confirmed], ['Not confirmed stopped', remote.quiescence.unconfirmed],
          ['Stopped state unknown', remote.quiescence.unknown],
        ]} />
        <p className="wd-muted">An accepted operation or recorded outcome is not automatically successful. Unknown outcomes remain unresolved.</p>
      </>}
  </section>
}
