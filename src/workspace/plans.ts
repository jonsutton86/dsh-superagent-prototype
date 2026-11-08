import { randomUUID } from 'node:crypto'
import { key, liveTicket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { WorkspaceError, type Mission } from './model.ts'
import type { Workspace } from './service.ts'
import { ProposePlan, ReviewPlan, RequestPlan, definitionOf, type PlanAuthor, type PlanIndex, type PlanProposal, type PlanVersion } from './plan-model.ts'

/** Immutable plan history and candidate proposals, with operator-only approval through Workspace. */
export class Planning {
  constructor(private readonly store: Store, private readonly workspace: Workspace) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_plan_version (mission TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(mission,version));
      CREATE TABLE IF NOT EXISTS workspace_plan_proposal (id TEXT PRIMARY KEY, mission TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_plan_proposal_mission ON workspace_plan_proposal(mission);
      CREATE TABLE IF NOT EXISTS workspace_plan_command (actor TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        proposal TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE TABLE IF NOT EXISTS workspace_planning_request (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, mission TEXT NOT NULL);`)
    store.atomic(() => {
      for (const row of store.db.prepare('SELECT id,value FROM workspace_mission').all()) {
        const mission = JSON.parse(String(row.value)) as Mission
        if (mission.planVersion) continue
        mission.planVersion = 1
        store.db.prepare('UPDATE workspace_mission SET value=? WHERE id=?').run(JSON.stringify(mission), mission.id)
        this.snapshot(mission, 'Imported existing mission definition')
      }
    })
  }
  snapshot(mission: Mission, reason: string, proposalId?: string): void {
    const value: PlanVersion = { version: mission.planVersion, at: new Date().toISOString(), reason,
      ...(proposalId ? { proposalId } : {}), plan: definitionOf(mission) }
    this.store.db.prepare('INSERT INTO workspace_plan_version VALUES (?,?,?)').run(mission.id, value.version, JSON.stringify(value))
  }
  version(id: string, version: number): PlanVersion {
    this.workspace.get(id, false)
    const row = this.store.db.prepare('SELECT value FROM workspace_plan_version WHERE mission=? AND version=?').get(id, version)
    if (!row) throw new WorkspaceError(404, 'Plan version not found')
    return JSON.parse(String(row.value)) as PlanVersion
  }
  proposal(missionId: string, id: string): PlanProposal {
    this.workspace.get(missionId, false)
    const row = this.store.db.prepare('SELECT value FROM workspace_plan_proposal WHERE id=? AND mission=?').get(id, missionId)
    if (!row) throw new WorkspaceError(404, 'Plan proposal not found')
    return JSON.parse(String(row.value)) as PlanProposal
  }
  list(id: string, offset = 0, limit = 20): PlanIndex {
    const mission = this.workspace.get(id, false)
    const versions = this.store.db.prepare('SELECT value FROM workspace_plan_version WHERE mission=? ORDER BY version DESC LIMIT ? OFFSET ?').all(id, limit + 1, offset)
    const proposals = this.store.db.prepare('SELECT value FROM workspace_plan_proposal WHERE mission=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(id, limit + 1, offset)
    return { currentVersion: mission.planVersion,
      versions: versions.slice(0, limit).map(row => { const { plan, ...value } = JSON.parse(String(row.value)) as PlanVersion; return value }),
      proposals: proposals.slice(0, limit).map(row => { const { plan, ...value } = JSON.parse(String(row.value)) as PlanProposal; return value }),
      nextOffset: versions.length > limit || proposals.length > limit ? offset + limit : null }
  }
  /** Scope is derived from the host-bound ticket, never from model-supplied mission or actor fields. */
  workerMission(ticketId: string, writing = false): string {
    const ticket = this.store.tickets.get(ticketId), trigger = ticket && this.store.triggers.get(ticket.origin.triggerId)
    if (!ticket || trigger?.source !== 'workspace' || typeof trigger.meta.mission !== 'string')
      throw new WorkspaceError(404, 'This ticket has no mission plan')
    const mission = this.workspace.get(trigger.meta.mission, false), action = mission.actions.find(action => action.runs.includes(ticketId))
    if (!action || (writing && (!liveTicket(ticket) || mission.status !== 'active' || action.runs.at(-1) !== ticketId
      || !action.ticket?.currentDefinition || this.store.settings().sources.workspace?.enabled === false)))
      throw new WorkspaceError(409, 'This mission no longer authorizes a proposal from this worker')
    return mission.id
  }
  private command(actor: string, requestId: string, input: unknown, operation: () => PlanProposal): PlanProposal {
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input))
      const receipt = this.store.db.prepare('SELECT fingerprint,proposal FROM workspace_plan_command WHERE actor=? AND id=?').get(actor, requestId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        const row = this.store.db.prepare('SELECT value FROM workspace_plan_proposal WHERE id=?').get(String(receipt.proposal))
        return JSON.parse(String(row!.value)) as PlanProposal
      }
      const result = operation()
      this.store.db.prepare('INSERT INTO workspace_plan_command VALUES (?,?,?,?)').run(actor, requestId, fingerprint, result.id)
      return result
    })
  }
  propose(id: string, input: unknown, ticketId?: string): PlanProposal {
    const request = ProposePlan.parse(input), actor = ticketId ? `worker:${ticketId}` : 'operator'
    return this.command(actor, request.requestId, { operation: 'propose', id, ...request }, () => {
      if (ticketId && this.workerMission(ticketId, true) !== id) throw new WorkspaceError(404, 'Mission not found')
      const mission = this.workspace.get(id, false)
      if (mission.status !== 'active' || mission.planVersion !== request.baseVersion)
        throw new WorkspaceError(409, 'The mission plan changed or is closed. Read the current plan before proposing changes.')
      const author: PlanAuthor = ticketId ? { role: 'worker', ticketId, sessionId: workerSessionId(ticketId) } : { role: 'operator' }
      const proposal: PlanProposal = { id: randomUUID(), missionId: id, baseVersion: request.baseVersion, rationale: request.rationale,
        plan: request.plan, author, createdAt: new Date().toISOString(), revision: 1, status: 'pending' }
      this.store.db.prepare('INSERT INTO workspace_plan_proposal VALUES (?,?,?)').run(proposal.id, id, JSON.stringify(proposal))
      return proposal
    })
  }
  review(id: string, proposalId: string, input: unknown): PlanProposal {
    const request = ReviewPlan.parse(input)
    return this.command('operator', request.requestId, { operation: 'review', id, proposalId, ...request }, () => {
      const proposal = this.proposal(id, proposalId)
      if (proposal.revision !== request.revision || proposal.status !== 'pending') throw new WorkspaceError(409, 'This proposal has already been reviewed')
      let version: number | undefined
      if (request.decision === 'approve') {
        if (this.workspace.get(id, false).planVersion !== proposal.baseVersion) throw new WorkspaceError(409, 'This proposal is stale. Create a new proposal against the current plan.')
        version = this.workspace.applyPlan(id, request.missionRevision, proposal.plan, proposal.id).planVersion
      }
      proposal.status = request.decision === 'approve' ? 'approved' : 'rejected'; proposal.revision++
      proposal.review = { at: new Date().toISOString(), note: request.note, ...(version ? { version } : {}) }
      this.store.db.prepare('UPDATE workspace_plan_proposal SET value=? WHERE id=?').run(JSON.stringify(proposal), proposalId)
      return proposal
    })
  }
  /** Explicitly authorize a planning assignment; publishing its proposal never approves or dispatches that plan. */
  request(id: string, input: unknown) {
    const request = RequestPlan.parse(input), prefix = `plan-${key(request.requestId)}`
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify({ id, ...request }))
      const receipt = this.store.db.prepare('SELECT fingerprint,mission FROM workspace_planning_request WHERE id=?').get(request.requestId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return this.workspace.get(String(receipt.mission))
      }
      const mission = this.workspace.add(id, { requestId: `${prefix}-add`, revision: request.revision, title: 'Propose a mission plan', owner: 'agent',
        instructions: 'Read the current mission using workspace_plan_read. Prepare a complete practical plan with agent and human actions, clear instructions and dependencies. '
          + 'Keep existing useful action IDs. Omit this planning assignment from the proposed action list. Submit it using workspace_plan_propose with the current baseVersion and a rationale. '
          + 'Do not execute the proposed steps. Report ready with the proposal ID and limitations; the operator will review it before any plan is applied.'
          + (request.instructions ? `\nOperator planning guidance:\n${request.instructions}` : '') })
      const result = this.workspace.act(id, mission.actions.at(-1)!.id, { requestId: `${prefix}-run`, revision: mission.revision, command: 'run' })
      this.store.db.prepare('INSERT INTO workspace_planning_request VALUES (?,?,?)').run(request.requestId, fingerprint, id)
      return result
    })
  }
}
