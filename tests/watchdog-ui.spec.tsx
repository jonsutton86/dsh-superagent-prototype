// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WatchdogConsole } from '../src/supervision/console.tsx'
import { ExecutionEvidenceView } from '../src/supervision/execution-evidence-view.tsx'
import { emptyRemoteExecutionEvidence, type ExecutionEvidence } from '../src/supervision/execution-evidence.ts'
import { watchdogServer } from './fixtures/watchdog.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: Awaited<ReturnType<typeof watchdogServer>> | undefined, root: Root | undefined, container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); await host?.stop(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); host = undefined; root = undefined; container = undefined })
async function waitFor(check: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); check() })
}
async function mount() {
  if (!container) { container = document.createElement('div'); document.body.append(container) }
  else await act(async () => root?.unmount())
  root = createRoot(container); await act(async () => root!.render(<WatchdogConsole />))
}
const text = () => container!.textContent!
async function click(label: string) {
  let button: HTMLButtonElement | undefined
  await vi.waitFor(() => { button = [...container!.querySelectorAll('button')].find(value => value.textContent === label || value.querySelector('strong')?.textContent === label); expect(button, label).toBeTruthy() })
  await act(async () => button!.click())
}
function connect(loseFirst = false) {
  const requests: string[] = []; let lose = loseFirst
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const response = await host!.request(url, init)
    if (url.endsWith('/acknowledgements')) {
      requests.push(String(init.body))
      if (lose) { lose = false; await response.text(); throw new TypeError('Response lost after commit') }
    }
    return response
  })
  return requests
}
function execution(): ExecutionEvidence {
  return { version: 1, assignmentId: 'assignment-one',
    session: { id: 'session-one', availability: 'available', state: 'running', attribution: 'session', assignmentAttribution: 'unknown' },
    jobs: { availability: 'available', attribution: 'session', assignmentAttribution: 'unknown', lifecycleAttribution: 'unknown',
      coverage: 'complete', sampled: 0, sampleRevision: 'a'.repeat(64), counts: { running: 0, stopping: 0, completed: 0, killed: 0, failed: 0, unknown: 0 },
      handedOff: { running: 0, stopping: 0 }, outputBytes: 0 },
    subagents: { availability: 'available', attribution: 'observed-session-lineage', assignmentAttribution: 'unknown', coverage: 'loaded-only',
      sampled: 0, sampleRevision: 'b'.repeat(64), truncated: false, counts: { running: 0, idle: 0, unknown: 0 } },
    executor: { availability: 'available', provenance: 'process-local', retrying: false, turnRetryAttempts: 0, launchRetryAttempts: 0,
      settling: false, preparing: false, stopping: false, knownHandedOffJobs: 0 },
    remoteEffects: emptyRemoteExecutionEvidence('not_applicable') }
}
async function mountEvidence(value?: ExecutionEvidence) {
  if (!container) { container = document.createElement('div'); document.body.append(container) }
  else await act(async () => root?.unmount())
  root = createRoot(container); await act(async () => root!.render(<ExecutionEvidenceView evidence={value} />))
}

it('reviews an incident during a main outage and replays an unconfirmed acknowledgement after remount against changed evidence', async () => {
  host = await watchdogServer(); host.journal.unavailable(host.now, 'Main service offline')
  const requests = connect(true)
  await mount(); await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('Waiting for the target platform.'))
  expect(text()).toContain('Unreachable'); expect(text()).toContain('Main service offline')
  const textarea = container!.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Reviewing platform choices.')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('Acknowledge evidence')
  await waitFor(() => expect(text()).toContain('Response lost after commit'))
  expect(host.journal.counts()).toMatchObject({ open: 1, unacknowledged: 0 })
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'drift', evidence: 'New scope mismatch observed.' }, host.now + 1)
  await mount(); await click('Retry acknowledgement')
  await waitFor(() => expect(text()).toContain('Evidence acknowledged.')); expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1])
  expect(host.journal.history(incident.id).items.filter(item => item.kind === 'acknowledged')).toHaveLength(1)
  expect(host.journal.counts()).toMatchObject({ open: 1, unacknowledged: 1 })
  expect(sessionStorage.getItem('dsh.watchdog.ack.v1')).toBeNull()
  await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('New evidence since acknowledgement'))
  expect(text()).toContain('New scope mismatch observed.')
})

it('refuses acknowledgement of evidence changed after rendering and escapes observed task content', async () => {
  host = await watchdogServer(); connect()
  host.snapshot.tickets[0]!.title = '<img src=x onerror=alert(1)> Suspicious task'
  host.snapshot.tickets[0]!.stage = 'person/answer'; host.snapshot.tickets[0]!.question = 'Choose <script>Linux</script> or macOS.'
  host.snapshot.tickets[0]!.revision = 'new-title'; host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('<img src=x onerror=alert(1)> Suspicious task')
  await waitFor(() => expect(container!.querySelector('textarea')).not.toBeNull())
  expect(container!.querySelector('img')).toBeNull(); expect(container!.querySelector('script')).toBeNull()
  expect(text()).toContain('Operator answer needed'); expect(text()).toContain('Choose <script>Linux</script> or macOS.')
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'unknown', evidence: 'Evidence changed during review.' }, host.now + 2)
  await click('Acknowledge evidence')
  await waitFor(() => expect(text()).toContain('New evidence is available'))
  expect(host.journal.counts().unacknowledged).toBe(1)
  await waitFor(() => expect(text()).toContain('Evidence changed during review.'))
  await click('Acknowledge evidence')
  await waitFor(() => expect(host!.journal.counts().unacknowledged).toBe(0))
  expect(text()).toContain('Monitoring continues.')
})

it('pages incidents and history without treating a changed cursor as an empty successful page', async () => {
  host = await watchdogServer(); connect()
  host.snapshot.tickets = Array.from({ length: 60 }, (_, index) => ({ ...host!.snapshot.tickets[0]!, id: `many-${index}`, title: `Incident ${index}` }))
  host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('More incidents')
  await waitFor(() => expect(container!.querySelectorAll('.wd-list li')).toHaveLength(10))
  await click('Previous incidents')
  await waitFor(() => expect(container!.querySelectorAll('.wd-list li')).toHaveLength(50))
  const incident = host.journal.open()[0]!
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'unknown', evidence: 'Changed snapshot' }, host.now + 2)
  await click('More incidents')
  await waitFor(() => expect(text()).toContain('Incidents changed while paging'))
  await click('Refresh'); await click('Older events')
  await waitFor(() => expect(text()).toContain('Newer events'))
  expect(container!.querySelector('footer')!.textContent).toContain('Open incidents are retained')
})

it('keeps original stop holds visible for ended paused tasks without presenting the pending replacement as active', async () => {
  host = await watchdogServer(); connect()
  const observation = host.snapshot.tickets[0]!
  observation.stage = 'ended'; observation.canNudge = false; observation.revision = 'stop-evidence'
  observation.stopHold = { held: true, count: 1, revision: 'a'.repeat(64), pendingAssignmentId: 'replacement-waiting', pendingInputs: 2,
    originals: [{ id: 'original-stop', assignmentId: 'original-assignment', revision: 1, scope: 'all', state: 'unknown', proof: null, legacy: false }], truncated: false }
  host.snapshot.paused = true
  host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('Original work is not confirmed stopped'))
  expect(text()).toContain('Original assignment: original-assignment')
  expect(text()).toContain('Pending replacement: replacement-waiting')
  expect(text()).toContain('Acknowledgement does not release this hold')
  await click('Acknowledge evidence')
  await waitFor(() => expect(host!.journal.counts().unacknowledged).toBe(0))
  expect(host.journal.open()).toHaveLength(1)
  expect(host.journal.open()[0]!.observation.canNudge).toBe(false)
})

it('distinguishes missing observations from available zero counts and non-remote assignments', async () => {
  await mountEvidence()
  expect(text()).toContain('Execution observations are unavailable in this snapshot.')
  const value = execution()
  value.session.availability = 'unavailable'; value.jobs.availability = 'unavailable'; value.jobs.coverage = 'unavailable'
  value.subagents.availability = 'unavailable'; value.subagents.coverage = 'unavailable'
  value.executor.availability = 'unavailable'
  value.remoteEffects = emptyRemoteExecutionEvidence()
  await mountEvidence(value)
  expect(text()).toContain('Session jobs unavailable. Counts and output activity are unknown.')
  expect(text()).toContain('Subagent observations unavailable. Counts are unknown.')
  expect(text()).toContain('Remote operation observations unavailable.')
  expect([...container!.querySelectorAll('caption')].map(item => item.textContent)).toEqual(['Observed work'])
  expect(text()).toContain('Coordinator activity unavailable. Retry counts and work state are unknown.')
  expect(text()).not.toContain('Preparing workNo')
  expect(text()).not.toContain('Observed output bytes'); expect(text()).not.toContain('0 job records observed')
  await mountEvidence(execution())
  expect(text()).toContain('0 job records observed'); expect(text()).toContain('Observed output bytes0')
  expect(text()).toContain('Remote operations do not apply to this assignment.')
  expect(text()).not.toContain('Unknown outcome0')
  const unknownOutput = execution(); unknownOutput.jobs.outputBytes = null
  await mountEvidence(unknownOutput)
  expect(text()).toContain('0 job records observed'); expect(text()).toContain('Observed output bytesUnknown')
  expect(text()).not.toContain('Observed output bytes0')
})

it('shows bounded Session activity separately from assignment outcomes, escaping identifiers and omitting raw details', async () => {
  const value = execution()
  value.session.id = '<img src=x onerror=alert(1)>'
  value.assignmentId = '<script>assignment</script>'
  value.jobs.sampled = 256; value.jobs.coverage = 'partial'; value.jobs.counts.running = 256
  value.jobs.handedOff.running = 3; value.jobs.handedOff.stopping = 1; value.jobs.outputBytes = 1234
  value.subagents.sampled = 256; value.subagents.counts.running = 256; value.subagents.truncated = true
  value.remoteEffects = { ...emptyRemoteExecutionEvidence('available'), coverage: 'partial', sampled: 2,
    phases: { pending: 0, accepted: 1, started: 0, settled: 0, refused: 0, unknown: 1 },
    quiescence: { confirmed: 0, unconfirmed: 1, unknown: 1 }, outcomes: { succeeded: 0, failed: 0, signalled: 0, unknown: 2 } }
  Object.assign(value.jobs, { command: 'DO_NOT_RENDER_COMMAND', path: '/DO_NOT_RENDER_PATH', labels: ['DO_NOT_RENDER_LABEL'] })
  await mountEvidence(value)
  expect(container!.querySelector('img')).toBeNull(); expect(container!.querySelector('script')).toBeNull()
  expect(text()).toContain('<img src=x onerror=alert(1)>'); expect(text()).toContain('<script>assignment</script>')
  expect(text()).toContain('Assignment and execution-attempt attribution are unknown.')
  expect(text()).toContain('Attributed to this task assignment. 2 operations observed')
  expect(text()).toContain('Partial snapshot · limit 256 records.')
  expect(text()).toContain('Loaded subagents only: 256 observed · more records omitted.')
  expect(text()).toContain('Unloaded subagents are not covered.')
  expect(text()).toContain('Handed-off jobs running3'); expect(text()).toContain('Unknown outcome2')
  expect(text()).toContain('Not confirmed stopped1'); expect(text()).toContain('Stopped state unknown1')
  expect(text()).toContain('Activity alone does not prove useful progress.')
  expect(text()).not.toContain('DO_NOT_RENDER')
})

it('marks prior assessments and interventions as historical when current execution evidence changes', async () => {
  host = await watchdogServer(); connect()
  Object.assign(host.snapshot.tickets[0]!, { execution: execution(), episodeRevision: 'ticket-one', revision: 'execution-base' })
  host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  const incident = host.journal.open()[0]!
  for (let attempt = 0; attempt < 3; attempt++) {
    const reserved = host.journal.reserve(incident.id, host.now + 2 + attempt * 1000, 1000)!
    host.journal.delivered(incident.id, reserved.delivery!.id)
  }
  host.journal.assess({ incidentId: incident.id, incidentRevision: incident.revision, finding: 'progressing', evidence: 'Earlier work appeared to progress.' }, host.now + 3003)
  host.journal.intervention(incident.id, incident.revision, { accepted: true, reason: 'status_requested' }, host.now + 3004)
  host.snapshot.tickets[0]!.execution!.jobs.counts.failed = 1; host.snapshot.tickets[0]!.execution!.jobs.sampled = 1
  host.snapshot.tickets[0]!.revision = 'execution-changed'
  host.journal.reconcile(host.snapshot, host.now + 3005, 1000, 3600000)
  await mount(); await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('Historical assessment'))
  expect(container!.querySelector('.wd-list li span')!.textContent).toContain('Evidence changed—assessment is historical')
  expect(container!.querySelector('.wd-badge')!.textContent).toBe('Evidence changed—assessment is historical')
  expect(text()).toContain('limit reached; operator review needed')
  expect(text()).toContain('Earlier work appeared to progress.'); expect(text()).toContain('it does not assess the current observations')
  expect(text()).toContain('Progress request based on earlier evidence: accepted')
  expect(text()).toContain('Job statesRunning0Stopping0Completed0Killed0Failed1')
  const current = host.journal.get(incident.id)!
  host.journal.assess({ incidentId: current.id, incidentRevision: current.revision, finding: 'blocked', evidence: 'The current observation includes a failed job.' }, host.now + 3006)
  await click('Refresh')
  await waitFor(() => expect(container!.querySelector('.wd-badge')!.textContent).toBe('Assessment: blocked'))
  expect(text()).not.toContain('limit reached; operator review needed')
  expect([...container!.querySelectorAll('h3')].some(item => item.textContent === 'Historical assessment')).toBe(false)
})

it('retains an unconfirmed acknowledgement identity across an execution evidence refresh', async () => {
  host = await watchdogServer(); const requests = connect(true)
  Object.assign(host.snapshot.tickets[0]!, { execution: execution(), episodeRevision: 'ticket-one', revision: 'execution-base' })
  host.journal.reconcile(host.snapshot, host.now + 1, 1000, 3600000)
  await mount(); await click('Prepare release evidence')
  await waitFor(() => expect(text()).toContain('0 job records observed'))
  await click('Acknowledge evidence'); await waitFor(() => expect(text()).toContain('Response lost after commit'))
  const pending = sessionStorage.getItem('dsh.watchdog.ack.v1')
  host.snapshot.tickets[0]!.execution!.jobs.outputBytes = 10
  host.snapshot.tickets[0]!.revision = 'execution-output-changed'
  host.journal.reconcile(host.snapshot, host.now + 2, 1000, 3600000)
  await click('Refresh'); await waitFor(() => expect(text()).toContain('Observed output bytes10'))
  expect(sessionStorage.getItem('dsh.watchdog.ack.v1')).toBe(pending)
  expect(container!.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(true)
  await click('Retry acknowledgement'); await waitFor(() => expect(text()).toContain('Evidence acknowledged.'))
  expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1])
  await waitFor(() => expect(text()).toContain('New evidence since acknowledgement'))
  expect(host.journal.counts().unacknowledged).toBe(1)
})


it('shows durable recovery allowances separately from provider request retries', async () => {
  const value = execution()
  value.executor = { ...value.executor, provenance: 'process-and-durable-queue', launchRetryAttempts: 2,
    recovery: { providerRetryOwner: 'harness', terminalTurnRetries: 0, launchRetryLimit: 3,
      hostRestart: { limit: 3, used: 5, remaining: 0, exhausted: true } } }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(<ExecutionEvidenceView evidence={value} />))
  expect(text()).toContain('Managed by DeepSeek Harness')
  expect(text()).toContain('failed launch deliveries come from the durable queue')
  expect(text()).toContain('Automatic host recoveries used5')
  expect(text()).toContain('Automatic host recovery limit reachedYes')
  expect(text()).toContain('does not retry a task or reset recovery allowances')
})
