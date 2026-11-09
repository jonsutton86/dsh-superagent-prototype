import { randomUUID } from 'node:crypto'
import { key, latestAssignment } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { Workspace } from './service.ts'
import type { Library } from './library.ts'
import type { LibraryRead, LibraryReader } from './library-model.ts'
import type { ScheduleOccurrence } from './schedule-model.ts'
import { WorkspaceError } from './model.ts'
import { ProposeReflection, ReadReflection, ReviewReflection, type ReflectionSpec, type ReflectionRun,
  type ReflectionSnapshot, type ReflectionProposal, type ReflectionView, type ReflectionList } from './reflection-model.ts'

const recordFingerprint = (record: LibraryRead) => key(JSON.stringify([record.id, record.revision, record.hash,
  record.archived, record.expired, record.superseded, record.conflicted]))

/** Captured reflection evidence and operator-only promotion, sharing the scheduler's transaction and existing Harness workers. */
export class Reflections {
  constructor(private readonly store: Store, private readonly workspace: Workspace, private readonly library: Library,
    private readonly runnable: () => boolean, private readonly clock: () => number = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_reflection (id TEXT PRIMARY KEY, mission TEXT NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_reflection_proposal (id TEXT PRIMARY KEY, run TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_reflection_proposal_run ON workspace_reflection_proposal(run);
      CREATE TABLE IF NOT EXISTS workspace_reflection_command (actor TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        proposal TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE TABLE IF NOT EXISTS workspace_reflection_read (owner TEXT PRIMARY KEY, calls INTEGER NOT NULL, bytes INTEGER NOT NULL);`)
  }
  private run(id: string): ReflectionRun {
    const row = this.store.db.prepare('SELECT value FROM workspace_reflection WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Reflection run not found')
    const run = JSON.parse(String(row.value)) as ReflectionRun, serialized = JSON.stringify(run.snapshot)
    if (key(serialized) !== run.snapshotHash || Buffer.byteLength(serialized) !== run.bytes)
      throw new WorkspaceError(409, 'Reflection snapshot integrity check failed')
    return run
  }
  get(id: string): ReflectionView {
    const run = this.run(id)
    return { ...run, proposals: this.store.db.prepare('SELECT value FROM workspace_reflection_proposal WHERE run=? ORDER BY rowid').all(id)
      .map(row => JSON.parse(String(row.value)) as ReflectionProposal) }
  }
  list(offset = 0, limit = 30): ReflectionList {
    const rows = this.store.db.prepare('SELECT value FROM workspace_reflection ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => {
      const { snapshot: _snapshot, ...run } = JSON.parse(String(row.value)) as ReflectionRun
      const pending = Number(this.store.db.prepare("SELECT count(*) AS count FROM workspace_reflection_proposal WHERE run=? AND value ->> '$.status'='pending'").get(run.id)!.count)
      return { ...run, pending }
    }), nextOffset: rows.length > limit ? offset + limit : null }
  }
  /** Called inside the occurrence transaction before any executor effect can escape. Retries never recapture context. */
  prepare(occurrence: ScheduleOccurrence, missionId: string, spec: ReflectionSpec): void {
    if (this.store.db.prepare('SELECT id FROM workspace_reflection WHERE id=?').get(occurrence.id)) return
    const at = new Date(this.clock()).toISOString(), since = new Date(this.clock() - spec.lookbackHours * 3600000).toISOString()
    const snapshot: ReflectionSnapshot = { capturedAt: at, since, guidance: spec.guidance, missions: [], records: [], contextOnly: true,
      omissions: { missions: 0, records: 0, unavailable: 0, partialRecords: 0, selectionStopped: false } }
    const deadline = performance.now() + 200, fits = () => Buffer.byteLength(JSON.stringify(snapshot)) <= spec.maxBytes
    const selected = spec.missionIds.length ? ` AND m.id IN (${spec.missionIds.map(() => '?').join(',')})` : ''
    // Agent reports and operator events count as activity even when the mission definition has not changed.
    const ids = this.store.db.prepare(`SELECT m.id,max(m.value ->> '$.updatedAt',
      coalesce((SELECT max(e.value ->> '$.at') FROM workspace_event e WHERE e.mission=m.id),''),
      coalesce((SELECT max(t.value ->> '$.updatedAt') FROM json_each(m.value,'$.actions') a,
        json_each(a.value,'$.runs') r JOIN ticket t ON t.id=r.value),'')) AS activity
      FROM workspace_mission m WHERE m.id!=? AND NOT EXISTS
      (SELECT 1 FROM workspace_reflection r WHERE r.mission=m.id)${selected} AND activity>=?
      ORDER BY activity DESC,m.rowid DESC LIMIT ?`).all(missionId, ...spec.missionIds, since, spec.maxMissions + 1)
    snapshot.omissions.missions = ids.length > spec.maxMissions ? 1 : 0
    for (const row of ids.slice(0, spec.maxMissions)) {
      if (performance.now() > deadline) { snapshot.omissions.selectionStopped = true; snapshot.omissions.missions++; continue }
      const value = this.workspace.get(String(row.id), false), fingerprint = key(JSON.stringify(value))
      const events = this.store.db.prepare('SELECT id,value FROM workspace_event WHERE mission=? ORDER BY id DESC LIMIT 10').all(value.id)
      value.events = events.map(event => ({ ...JSON.parse(String(event.value)), id: Number(event.id) }))
      snapshot.missions.push({ value, fingerprint })
      if (!fits()) { snapshot.missions.pop(); snapshot.omissions.missions++ }
    }
    const scopes = ['workspace', ...snapshot.missions.map(item => `mission:${item.value.id}`)]
    const records = this.store.db.prepare(`SELECT id FROM workspace_library WHERE scope IN (${scopes.map(() => '?').join(',')})
      AND value ->> '$.createdAt'>=? AND archived=0 ORDER BY rowid DESC LIMIT ?`).all(...scopes, since, spec.maxRecords + 1)
    snapshot.omissions.records = records.length > spec.maxRecords ? 1 : 0
    const reader: LibraryReader = { role: 'reflection', scopes }, inspector = this.library.inspector(reader)
    for (const row of records.slice(0, spec.maxRecords)) {
      if (performance.now() > deadline) { snapshot.omissions.selectionStopped = true; snapshot.omissions.records++; continue }
      try {
        const value = this.library.read(String(row.id), { limit: 4000 }, reader, inspector)
        snapshot.records.push({ value, fingerprint: recordFingerprint(value) })
        if (!fits()) { snapshot.records.pop(); snapshot.omissions.records++ }
        else if (value.nextOffset !== null || value.incomingTruncated || !value.freshness?.complete) snapshot.omissions.partialRecords++
      } catch { snapshot.omissions.unavailable++ }
    }
    // Reserve room for changed omission counters, including multibyte JSON. The snapshot is never silently clipped.
    while (!fits() && (snapshot.records.length || snapshot.missions.length)) {
      if (snapshot.records.length) { snapshot.records.pop(); snapshot.omissions.records++ }
      else { snapshot.missions.pop(); snapshot.omissions.missions++ }
    }
    if (!fits()) throw new WorkspaceError(409, 'Reflection guidance exceeds the selected context byte limit')
    const serialized = JSON.stringify(snapshot), run: ReflectionRun = { id: occurrence.id, missionId, scheduleId: occurrence.scheduleId,
      scheduleRevision: occurrence.revision, capturedAt: at, bytes: Buffer.byteLength(serialized), snapshotHash: key(serialized), snapshot }
    this.store.db.prepare('INSERT INTO workspace_reflection VALUES (?,?,?)').run(run.id, missionId, JSON.stringify(run))
  }
  forTicket(ticketId: string): boolean {
    const ticket = this.store.tickets.get(ticketId), trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
    return typeof trigger?.meta.mission === 'string' && !!this.store.db.prepare('SELECT id FROM workspace_reflection WHERE mission=?').get(trigger.meta.mission)
  }
  private worker(ticketId: string) {
    if (!this.runnable()) throw new WorkspaceError(409, 'Reflection is paused')
    const mission = this.workspace.plans.workerMission(ticketId, true), ticket = this.store.tickets.get(ticketId)!
    if (!this.workspace.executionAllowed(ticket)) throw new WorkspaceError(409, 'Reflection execution authority is unavailable')
    const row = this.store.db.prepare('SELECT id FROM workspace_reflection WHERE mission=?').get(mission)
    const assignment = latestAssignment(ticket)
    if (!row || !assignment) throw new WorkspaceError(404, 'Reflection run not found')
    return { run: this.run(String(row.id)), assignmentId: assignment.id, owner: key(ticketId, assignment.id) }
  }
  read(ticketId: string, input: unknown) {
    const page = ReadReflection.parse(input)
    return this.store.atomic(() => {
      const { run, owner } = this.worker(ticketId), serialized = JSON.stringify(run.snapshot)
      const prior = this.store.db.prepare('SELECT calls,bytes FROM workspace_reflection_read WHERE owner=?').get(owner)
      const calls = Number(prior?.calls ?? 0), used = Number(prior?.bytes ?? 0)
      const end = Math.min(serialized.length, page.offset + page.limit), result = { runId: run.id, snapshotHash: run.snapshotHash,
        content: serialized.slice(page.offset, end), offset: page.offset, nextOffset: end < serialized.length ? end : null,
        totalChars: serialized.length, contextOnly: true as const }
      const bytes = Buffer.byteLength(JSON.stringify(result))
      if (calls >= 100 || used + bytes > Math.max(65536, run.bytes * 8)) throw new WorkspaceError(409, 'Reflection snapshot read allowance exhausted for this assignment')
      this.store.db.prepare(`INSERT INTO workspace_reflection_read VALUES (?,?,?) ON CONFLICT(owner)
        DO UPDATE SET calls=excluded.calls,bytes=excluded.bytes`).run(owner, calls + 1, used + bytes)
      return result
    })
  }
  private proposal(id: string): ReflectionProposal {
    const row = this.store.db.prepare('SELECT value FROM workspace_reflection_proposal WHERE id=?').get(id)
    if (!row) throw new WorkspaceError(404, 'Reflection proposal not found')
    return JSON.parse(String(row.value)) as ReflectionProposal
  }
  private command(actor: string, id: string, input: unknown, apply: () => ReflectionProposal): ReflectionProposal {
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input)), old = this.store.db.prepare('SELECT * FROM workspace_reflection_command WHERE actor=? AND id=?').get(actor, id)
      if (old) {
        if (old.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return this.proposal(String(old.proposal))
      }
      const result = apply()
      this.store.db.prepare('INSERT INTO workspace_reflection_command VALUES (?,?,?,?)').run(actor, id, fingerprint, result.id)
      return result
    })
  }
  propose(ticketId: string, input: unknown): ReflectionProposal {
    const request = ProposeReflection.parse(input), { run, assignmentId, owner } = this.worker(ticketId)
    return this.command(owner, request.requestId, request, () => {
      if (this.get(run.id).proposals.length >= 10) throw new WorkspaceError(409, 'Reflection proposal limit reached')
      const { candidate, evidence } = request, missions = new Set(run.snapshot.missions.map(item => item.value.id)), records = new Set(run.snapshot.records.map(item => item.value.id))
      if (!evidence.missions.length && !evidence.records.length) throw new WorkspaceError(400, 'Cite at least one captured evidence item')
      if (evidence.missions.some(id => !missions.has(id)) || evidence.records.some(id => !records.has(id))) throw new WorkspaceError(404, 'Evidence was not captured in this reflection')
      if ('missionId' in candidate && candidate.missionId && (!missions.has(candidate.missionId) || !evidence.missions.includes(candidate.missionId)))
        throw new WorkspaceError(400, 'Cite the captured target mission')
      const proposal: ReflectionProposal = { id: randomUUID(), runId: run.id, revision: 1, status: 'pending', createdAt: new Date(this.clock()).toISOString(),
        ticketId, assignmentId, rationale: request.rationale, evidence, candidate }
      this.store.db.prepare('INSERT INTO workspace_reflection_proposal VALUES (?,?,?)').run(proposal.id, run.id, JSON.stringify(proposal))
      return proposal
    })
  }
  private fresh(proposal: ReflectionProposal): void {
    const run = this.run(proposal.runId)
    for (const id of proposal.evidence.missions) {
      const captured = run.snapshot.missions.find(item => item.value.id === id)!
      if (key(JSON.stringify(this.workspace.get(id, false))) !== captured.fingerprint)
        throw new WorkspaceError(409, 'Cited mission evidence changed. Reject this candidate and capture a new reflection.')
    }
    const reader: LibraryReader = { role: 'reflection', scopes: ['workspace', ...run.snapshot.missions.map(item => `mission:${item.value.id}`)] }, inspector = this.library.inspector(reader)
    for (const id of proposal.evidence.records) {
      const captured = run.snapshot.records.find(item => item.value.id === id)!, current = this.library.read(id, { limit: 1 }, reader, inspector)
      if (recordFingerprint(current) !== captured.fingerprint || current.freshness?.status !== 'current')
        throw new WorkspaceError(409, 'Cited library evidence changed or is not current. Capture a new reflection.')
    }
  }
  review(runId: string, proposalId: string, input: unknown): ReflectionProposal {
    const request = ReviewReflection.parse(input)
    return this.command('operator', request.requestId, { runId, proposalId, ...request }, () => {
      const proposal = this.proposal(proposalId)
      if (proposal.runId !== runId) throw new WorkspaceError(404, 'Reflection proposal not found')
      if (proposal.status !== 'pending' || proposal.revision !== request.revision) throw new WorkspaceError(409, 'Reflection proposal already changed')
      let result: NonNullable<ReflectionProposal['review']>['result']
      if (request.decision === 'approve') {
        this.fresh(proposal)
        const candidate = proposal.candidate
        if (candidate.kind === 'memory') {
          const record = this.library.publishReviewed({ requestId: `reflection-${proposal.id}`, kind: 'memory', title: candidate.title,
            summary: candidate.summary, content: candidate.content, scope: candidate.missionId ? `mission:${candidate.missionId}` : 'workspace',
            sources: proposal.evidence.records.map(id => ({ id, relation: 'derived_from' })) },
          { runId, proposalId, ticketId: proposal.ticketId, assignmentId: proposal.assignmentId })
          result = { kind: 'memory', id: record.id }
        } else {
          const mission = candidate.kind === 'plan' ? this.workspace.get(candidate.missionId, false)
            : this.workspace.create({ requestId: `reflection-${proposal.id}`, title: candidate.plan.title, objective: candidate.plan.objective, acceptance: candidate.plan.acceptance })
          const applied = this.workspace.applyPlan(mission.id, mission.revision, candidate.plan, proposal.id)
          result = { kind: 'mission', id: applied.id, version: applied.planVersion }
        }
      }
      proposal.status = request.decision === 'approve' ? 'approved' : 'rejected'; proposal.revision++
      proposal.review = { at: new Date(this.clock()).toISOString(), note: request.note, ...(result ? { result } : {}) }
      this.store.db.prepare('UPDATE workspace_reflection_proposal SET value=? WHERE id=?').run(JSON.stringify(proposal), proposal.id)
      return proposal
    })
  }
}
