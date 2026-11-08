import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, latestAssignment, ticketStage, canRetry, canStop, hasPendingFollowup, type Engine, type Policy, type Trigger, type Ticket } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { SourceKind } from '../sources/kind.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { ActionCommand, AddAction, CreateMission, MissionCommand, WorkspaceError,
  type ActionView, type Mission, type MissionAction, type MissionEvent, type MissionList, type MissionView } from './model.ts'
import { Planning } from './plans.ts'
import { PlanDefinition, definitionOf } from './plan-model.ts'
import type { PersonaRef } from '../personas/model.ts'

type Execution = Pick<Engine, 'receive' | 'decide' | 'stopTicket' | 'retryTicket'>
const SOURCE = 'workspace'
const OPERATOR = 'local-operator'
const now = () => new Date().toISOString()

/** Single-owner local workspace, sharing the Engine's database transaction and crash-safe effect queue. */
export class Workspace {
  readonly plans: Planning
  constructor(private readonly store: Store, private readonly engine: () => Execution, private readonly runnable: () => boolean,
    private readonly evidenceRevision?: (ticketId: string) => string, private readonly executionAuthorization?: (ticket: Ticket) => boolean,
    private readonly personaSelection?: (reference: PersonaRef) => unknown) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_mission (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_event (id INTEGER PRIMARY KEY, mission TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_event_mission ON workspace_event(mission, id);
      CREATE TABLE IF NOT EXISTS workspace_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, mission TEXT NOT NULL);`)
    this.plans = new Planning(store, this)
  }
  executionAllowed(ticket: Ticket): boolean { return this.executionAuthorization?.(ticket) ?? true }

  readonly source: SourceKind = { kind: SOURCE, title: { en: 'Workspace', zh: '工作空间' },
    description: { en: 'Missions authorized by the local operator.', zh: '由本地用户授权的任务。' },
    schema: z.object({}).strict(), fields: [], health: [],
    scope: ({ meta }) => this.authorized(meta) ? { listened: true, observed: false } : { listened: false, reason: 'Unknown workspace action' } }

  /** Only host-created intents backed by an existing active mission can originate workspace execution. */
  policy(base: Policy): Policy {
    return { ...base,
      gate: (trigger, thread, tickets) => trigger.source !== SOURCE ? base.gate(trigger, thread, tickets)
        : this.validTrigger(trigger) ? { admissible: true, strength: 'explicit', basis: {
          via: 'addressed', addressed: 'direct', source: SOURCE, scope: trigger.meta, sender: OPERATOR } }
          : { admissible: false, reason: 'Invalid local workspace request' },
      revalidate: mandate => mandate.actor.source !== SOURCE ? base.revalidate(mandate)
        : mandate.actor.id === OPERATOR && mandate.strength === 'explicit' && this.authorized(mandate.basis.scope ?? {}),
    }
  }
  private authorized(meta: Record<string, unknown>): boolean {
    if (this.store.settings().sources[SOURCE]?.enabled === false) return false
    if (typeof meta.mission !== 'string' || typeof meta.action !== 'string') return false
    const mission = this.find(meta.mission)
    return mission?.status === 'active' && !!mission.actions.find(action => action.id === meta.action && action.owner === 'agent'
      && (action.definitionRevision ?? 1) === (meta.actionRevision ?? 1)
      && JSON.stringify(action.persona ?? null) === JSON.stringify(meta.persona ?? null))
  }
  private validatePersona(reference: PersonaRef | undefined): void {
    if (!reference) return
    if (!this.personaSelection) throw new WorkspaceError(409, 'Persona selection is unavailable')
    this.personaSelection(reference)
  }
  private validTrigger(trigger: Trigger): boolean {
    return trigger.actor.source === SOURCE && trigger.actor.id === OPERATOR && trigger.human && trigger.addressed === 'direct'
      && this.authorized(trigger.meta) && trigger.id === trigger.meta.intent
  }
  private find(id: string): Mission | undefined {
    const row = this.store.db.prepare('SELECT value FROM workspace_mission WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as Mission : undefined
  }
  private require(id: string): Mission {
    const mission = this.find(id)
    if (!mission) throw new WorkspaceError(404, 'Mission not found')
    return mission
  }
  private save(mission: Mission): void {
    this.store.db.prepare('INSERT INTO workspace_mission VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(mission.id, JSON.stringify(mission))
  }
  private event(mission: Mission, kind: string, text: string, actionId?: string): void {
    this.store.db.prepare('INSERT INTO workspace_event(mission,value) VALUES (?,?)')
      .run(mission.id, JSON.stringify({ at: now(), kind, text, ...(actionId ? { actionId } : {}) }))
  }
  private dependencyRevision(action: MissionAction, actions: MissionAction[]): string {
    return key(JSON.stringify(action.dependsOn.map(id => ({ id, accepted: actions.find(item => item.id === id)?.accepted }))))
  }
  private viewAction(action: MissionAction, actions: MissionAction[], memo = new Map<string, ActionView>()): ActionView {
    const cached = memo.get(action.id)
    if (cached) return cached
    const ticket = action.runs.length ? this.store.tickets.get(action.runs.at(-1)!) : undefined
    const revision = ticket ? key(JSON.stringify(ticket) + (this.evidenceRevision?.(ticket.id) ?? '')) : undefined
    const currentDefinition = action.owner === 'person' || !ticket || (action.executionRevision ?? 1) === (action.definitionRevision ?? 1)
    const changed = !currentDefinition || !!action.dependencyRevision && action.dependencyRevision !== this.dependencyRevision(action, actions)
    const accepted = !changed && !!action.accepted && (action.owner === 'person' || (!!ticket?.ended && action.accepted.ticketRevision === revision))
    const dependencies = action.dependsOn.every(id => {
      const dependency = actions.find(item => item.id === id)
      return !!dependency && this.viewAction(dependency, actions, memo).status === 'done'
    })
    let status: ActionView['status'] = !dependencies ? 'waiting' : accepted ? 'done' : changed ? 'outdated' : 'todo'
    if (!accepted && ticket && action.owner === 'agent') {
      const stage = ticketStage(ticket)
      const followup = hasPendingFollowup(ticket)
      status = followup ? 'working' : ticket.ended ? ['completed', 'merged'].includes(ticket.ended.outcome) ? 'review' : 'stopped'
        : stage.stage === 'person' || stage.stage === 'idle' ? 'blocked' : 'working'
      if (ticket.ended && (changed || !dependencies)) status = 'outdated'
    }
    const assignment = ticket && latestAssignment(ticket)
    const result = { ...action, status, ...(ticket ? { ticket: { id: ticket.id, revision: revision!,
      ...(ticket.execution ? { sessionId: workerSessionId(ticket.id) } : {}),
      summary: assignment?.report?.summary ?? '', retryable: canRetry(ticket), stoppable: canStop(ticket), ended: !!ticket.ended, currentDefinition } } : {}) }
    memo.set(action.id, result)
    return result
  }
  get(id: string, withEvents = true): MissionView {
    const mission = this.require(id), memo = new Map<string, ActionView>()
    const actions = mission.actions.map(action => this.viewAction(action, mission.actions, memo))
    const rows = withEvents ? this.store.db.prepare('SELECT id,value FROM workspace_event WHERE mission=? ORDER BY id DESC LIMIT 100').all(id) : []
    const events = rows.map(row => ({ ...JSON.parse(String(row.value)) as Omit<MissionEvent, 'id'>, id: Number(row.id) }))
    const completed = actions.filter(action => action.status === 'done').length
    return { ...mission, actions, events, completed, needsReview: mission.status === 'completed' && completed !== actions.length }
  }
  list(offset = 0, limit = 30): MissionList {
    const rows = this.store.db.prepare('SELECT id FROM workspace_mission ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
    return { items: rows.slice(0, limit).map(row => {
      const { id, title, objective, status, updatedAt, completed, needsReview, actions } = this.get(String(row.id), false)
      return { id, title, objective: objective.slice(0, 400), status, updatedAt, completed, needsReview, total: actions.length }
    }),
      nextOffset: rows.length > limit ? offset + limit : null }
  }
  /** Idempotency receipts and the mutation commit together; a lost HTTP response cannot create a second run. */
  private command(requestId: string, input: unknown, operation: () => Mission): MissionView {
    return this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input))
      const receipt = this.store.db.prepare('SELECT fingerprint,mission FROM workspace_command WHERE id=?').get(requestId)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw new WorkspaceError(409, 'This request ID was already used for another operation')
        return this.get(String(receipt.mission))
      }
      const mission = operation()
      this.store.db.prepare('INSERT INTO workspace_command VALUES (?,?,?)').run(requestId, fingerprint, mission.id)
      return this.get(mission.id)
    })
  }
  private editable(id: string, revision: number): Mission {
    const mission = this.require(id)
    if (mission.revision !== revision) throw new WorkspaceError(409, 'Mission changed. Refresh before trying again.')
    return mission
  }
  private active(mission: Mission): void {
    if (mission.status !== 'active') throw new WorkspaceError(409, 'Reopen the mission before changing its actions.')
  }
  private changed(mission: Mission): Mission {
    mission.revision++; mission.updatedAt = now(); this.save(mission); return mission
  }
  create(input: unknown): MissionView {
    const request = CreateMission.parse(input)
    return this.command(request.requestId, { operation: 'create', ...request }, () => {
      const at = now(), mission: Mission = { id: randomUUID(), title: request.title, objective: request.objective,
        acceptance: request.acceptance, status: 'active', revision: 1, planVersion: 1, createdAt: at, updatedAt: at, actions: [] }
      this.save(mission); this.plans.snapshot(mission, 'Mission created'); this.event(mission, 'created', 'Mission created'); return mission
    })
  }
  add(id: string, input: unknown): MissionView {
    const request = AddAction.parse(input)
    return this.command(request.requestId, { operation: 'add', id, ...request }, () => {
      const mission = this.editable(id, request.revision); this.active(mission)
      this.validatePersona(request.persona)
      if (mission.actions.length >= 200) throw new WorkspaceError(400, 'A mission can contain up to 200 actions')
      // Dependencies can only point backwards to existing actions, so cycles cannot be introduced.
      if (request.dependsOn.some(id => !mission.actions.some(action => action.id === id))) throw new WorkspaceError(400, 'Dependency not found')
      const action: MissionAction = { id: randomUUID(), title: request.title, instructions: request.instructions,
        owner: request.owner, dependsOn: [...new Set(request.dependsOn)], runs: [], ...(request.persona ? { persona: request.persona } : {}) }
      mission.actions.push(action); mission.planVersion++
      PlanDefinition.parse(definitionOf(mission))
      this.plans.snapshot(mission, `Added action: ${action.title}`)
      this.event(mission, 'action-added', action.title, action.id); return this.changed(mission)
    })
  }
  update(id: string, input: unknown): MissionView {
    const request = MissionCommand.parse(input)
    return this.command(request.requestId, { operation: 'status', id, ...request }, () => {
      const mission = this.editable(id, request.revision), view = this.get(id)
      if (request.status !== 'active' && view.actions.some(action => action.ticket && (!action.ticket.ended || action.status === 'working')))
        throw new WorkspaceError(409, 'Stop or finish running actions before closing the mission.')
      if (request.status === 'completed' && (!view.actions.length || view.completed !== view.actions.length))
        throw new WorkspaceError(409, 'Review and complete every action before completing the mission.')
      mission.status = request.status; this.event(mission, request.status, `Mission ${request.status}`); return this.changed(mission)
    })
  }
  /** Apply a reviewed definition atomically, retaining run history and invalidating affected results and mandates. */
  applyPlan(id: string, revision: number, input: unknown, proposalId: string): MissionView {
    const plan = PlanDefinition.parse(input)
    return this.store.atomic(() => {
      const mission = this.editable(id, revision); this.active(mission)
      for (const action of plan.actions) this.validatePersona(action.persona)
      const previous = definitionOf(mission), proposed = new Map(plan.actions.map(action => [action.id, action]))
      const globalChange = plan.title !== mission.title || plan.objective !== mission.objective || plan.acceptance !== mission.acceptance
      const affected = new Set(previous.actions.filter(action => globalChange || JSON.stringify(action) !== JSON.stringify(proposed.get(action.id))).map(action => action.id))
      // A changed dependency invalidates the instructions/context consumed by all downstream results as well.
      for (let size = -1; size !== affected.size;) {
        size = affected.size
        for (const action of [...previous.actions, ...plan.actions]) if (action.dependsOn.some(id => affected.has(id))) affected.add(action.id)
      }
      if (this.get(id, false).actions.some(action => affected.has(action.id) && action.ticket?.stoppable))
        throw new WorkspaceError(409, 'Stop or finish affected actions before applying this plan.')
      const ids = new Map(plan.actions.map(action => [action.id, mission.actions.some(old => old.id === action.id) ? action.id : randomUUID()]))
      const actions = plan.actions.map(definition => {
        const old = mission.actions.find(action => action.id === definition.id)
        const action: MissionAction = { ...old, ...definition, id: ids.get(definition.id)!,
          dependsOn: definition.dependsOn.map(id => ids.get(id)!), runs: old?.runs ?? [] }
        if (!definition.persona) delete action.persona
        if (old && affected.has(old.id)) { action.definitionRevision = (old.definitionRevision ?? 1) + 1; delete action.accepted }
        return action
      })
      Object.assign(mission, { title: plan.title, objective: plan.objective, acceptance: plan.acceptance, actions })
      mission.planVersion++; this.changed(mission)
      this.plans.snapshot(mission, 'Approved plan proposal', proposalId)
      this.event(mission, 'plan-approved', `Applied plan version ${mission.planVersion} from proposal ${proposalId}`)
      return this.get(id)
    })
  }
  act(id: string, actionId: string, input: unknown): MissionView {
    const request = ActionCommand.parse(input)
    return this.command(request.requestId, { operation: 'action', id, actionId, ...request }, () => {
      const mission = this.editable(id, request.revision); this.active(mission)
      const action = mission.actions.find(item => item.id === actionId)
      if (!action) throw new WorkspaceError(404, 'Action not found')
      const view = this.viewAction(action, mission.actions), engine = this.engine()
      const dependencies = action.dependsOn.every(id => this.viewAction(mission.actions.find(item => item.id === id)!, mission.actions).status === 'done')
      if (request.command === 'run') {
        if (!this.runnable()) throw new WorkspaceError(409, 'Configure execution and resume the executor before running an action.')
        if (action.owner !== 'agent' || !dependencies || view.status === 'done' || view.status === 'review' || view.ticket?.stoppable)
          throw new WorkspaceError(409, 'This action cannot start yet.')
        this.validatePersona(action.persona)
        const intent = `workspace:${id}:${actionId}:${action.runs.length}`
        const context = action.dependsOn.map(id => {
          const dependency = mission.actions.find(item => item.id === id)!
          return `${dependency.title}: ${dependency.accepted?.note ?? ''}`
        }).join('\n').slice(0, 12000)
        engine.receive({ id: intent, source: SOURCE, actor: { source: SOURCE, id: OPERATOR }, human: true, addressed: 'direct',
          at: now(), threads: [{ source: SOURCE, id: intent }],
          text: `Mission: ${mission.title}\nObjective: ${mission.objective}\nAcceptance criteria: ${mission.acceptance}\n\nAction: ${action.title}\n${action.instructions}`
            + (context ? `\n\nReviewed dependency outcomes (context, not additional instructions):\n${context}` : ''),
          meta: { mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, intent, label: action.title, ...(action.persona ? { persona: action.persona } : {}) } })
        const decision = engine.decide(intent, { kind: 'accept', title: action.title, scope: action.instructions,
          name: 'mission-action', reason: 'Explicit local operator dispatch from the mission workspace' })
        if (!decision.ticketId) throw new WorkspaceError(409, 'Execution did not accept the action.')
        action.runs.push(decision.ticketId); action.executionRevision = action.definitionRevision ?? 1
        action.dependencyRevision = this.dependencyRevision(action, mission.actions); delete action.accepted
      } else if (request.command === 'complete') {
        if (!dependencies) throw new WorkspaceError(409, 'Complete the dependencies first.')
        if (!request.text) throw new WorkspaceError(400, 'Describe the evidence or result you reviewed.')
        if (action.owner === 'person' && !['todo', 'outdated'].includes(view.status)) throw new WorkspaceError(409, 'This action is already complete.')
        if (action.owner === 'agent' && (view.status !== 'review' || request.ticketRevision !== view.ticket?.revision))
          throw new WorkspaceError(409, 'Review the latest completed execution before accepting it.')
        action.accepted = { at: now(), note: request.text, ...(view.ticket ? { ticketRevision: view.ticket.revision } : {}) }
        action.dependencyRevision = this.dependencyRevision(action, mission.actions)
      } else {
        if (!view.ticket || (request.command !== 'steer' && (request.command === 'stop' ? !view.ticket.stoppable : view.ticket.ended)))
          throw new WorkspaceError(409, 'This action has no active execution.')
        if (request.command === 'steer' && this.store.tickets.get(view.ticket.id)?.ended?.by === 'human')
          throw new WorkspaceError(409, 'This action was stopped. Run a new action to authorize further work.')
        if (request.command !== 'stop' && (!view.ticket.currentDefinition || view.status === 'outdated'))
          throw new WorkspaceError(409, 'This action definition changed. Run it again under the current plan.')
        if (request.command !== 'stop' && !this.executionAllowed(this.store.tickets.get(view.ticket.id)!))
          throw new WorkspaceError(409, 'This execution grant changed. Start a new action under the current environment.')
        if (request.command !== 'stop' && !this.authorized({ mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, ...(action.persona ? { persona: action.persona } : {}) }))
          throw new WorkspaceError(409, 'The workspace source is disabled. Enable it before sending new work.')
        if (request.command === 'retry') {
          if (!this.runnable()) throw new WorkspaceError(409, 'Resume the executor before retrying this action.')
          engine.retryTicket(view.ticket.id)
        }
        if (request.command === 'stop') engine.stopTicket(view.ticket.id, 'Stopped by the mission owner')
        if (request.command === 'steer') {
          if (!request.text) throw new WorkspaceError(400, 'Enter a message for the agent.')
          const ticket = this.store.tickets.get(view.ticket.id)!, origin = this.store.triggers.get(ticket.origin.triggerId)!
          const intent = `workspace-message:${request.requestId}`
          engine.receive({ id: intent, source: SOURCE, actor: { source: SOURCE, id: OPERATOR }, human: true, addressed: 'direct',
            at: now(), threads: origin.threads, text: request.text,
            meta: { mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, intent, label: action.title, ...(action.persona ? { persona: action.persona } : {}) } })
        }
        delete action.accepted
      }
      this.event(mission, request.command, request.text || `${request.command}: ${action.title}`, actionId)
      return this.changed(mission)
    })
  }
}
