import { randomUUID } from 'node:crypto'
import { key, latestAssignment, ticketStage, canRetry, canStop, hasPendingFollowup, type Engine, type Policy, type Trigger, type Ticket, type ChannelRef } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import type { SourceKind } from '../sources/kind.ts'
import { workspaceContract } from '../sources/contracts.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { ActionCommand, AddAction, CreateMission, MissionCommand, WorkspaceError,
  type ActionView, type Mission, type MissionAction, type PreparedMissionCompletion, type MissionEvent, type MissionList, type MissionView, type WorkspaceReview } from './model.ts'
import { Planning } from './plans.ts'
import { PlanDefinition, definitionOf } from './plan-model.ts'
import type { PersonaRef } from '../personas/model.ts'
import type { ScheduleOrigin } from './schedule-model.ts'
import { fingerprint } from '../remote/journal.ts'
import type { EvidenceSeal } from '../verification/review-model.ts'
import { ConfigureMissionPull, type MissionPullAcceptance } from './pull-model.ts'
import type { MissionPulls } from './pulls.ts'
import { MissionCompletions, type CompletionAttempt } from './completion.ts'

type Execution = Pick<Engine, 'receive' | 'decide' | 'stopTicket' | 'retryTicket'>
const SOURCE = 'workspace'
const OPERATOR = 'local-operator'
const now = () => new Date().toISOString()

/** Single-owner local workspace, sharing the Engine's database transaction and crash-safe effect queue. */
export class Workspace {
  readonly plans: Planning
  readonly completions: MissionCompletions
  constructor(private readonly store: Store, private readonly engine: () => Execution, private readonly runnable: () => boolean,
    private readonly evidenceRevision?: (ticketId: string) => string, private readonly executionAuthorization?: (ticket: Ticket) => boolean,
    private readonly personaSelection?: (reference: PersonaRef) => unknown, private readonly environmentSelection?: (reference: string) => unknown,
    private readonly deliveryChannel?: (mission: Mission, action: MissionAction) => ChannelRef | undefined,
    private readonly review?: WorkspaceReview, readonly pulls?: MissionPulls) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_mission (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_event (id INTEGER PRIMARY KEY, mission TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_event_mission ON workspace_event(mission, id);
      CREATE TABLE IF NOT EXISTS workspace_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, mission TEXT NOT NULL);`)
    this.plans = new Planning(store, this)
    this.completions = new MissionCompletions(store)
  }
  executionAllowed(ticket: Ticket): boolean { return this.executionAuthorization?.(ticket) ?? true }

  readonly source: SourceKind = { kind: SOURCE, title: { en: 'Workspace', zh: '工作空间' },
    description: { en: 'Missions authorized by the local operator.', zh: '由本地用户授权的任务。' },
    schema: workspaceContract.schema, fields: [], health: [],
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
      && JSON.stringify(action.persona ?? null) === JSON.stringify(meta.persona ?? null) && action.environment === meta.environment && action.pull === meta.pull)
  }
  private validatePersona(reference: PersonaRef | undefined): void {
    if (!reference) return
    if (!this.personaSelection) throw new WorkspaceError(409, 'Persona selection is unavailable')
    this.personaSelection(reference)
  }
  private validateEnvironment(reference: string | undefined): void {
    if (!reference) return
    if (!this.environmentSelection) throw new WorkspaceError(409, 'Environment selection is unavailable')
    this.environmentSelection(reference)
  }
  private validatePull(reference: string | undefined): void {
    if (!reference) return
    if (!this.pulls) throw new WorkspaceError(409, 'Mission PR targets are unavailable')
    this.pulls.state(reference)
  }
  private validTrigger(trigger: Trigger): boolean {
    const origin = typeof trigger.meta.mission === 'string' ? this.find(trigger.meta.mission)?.schedule : undefined
    const scheduled = !!origin && trigger.meta.occurrence === origin.occurrence && trigger.meta.schedule === origin.id
      && trigger.meta.scheduleRevision === origin.revision && trigger.meta.scheduledFor === origin.due
    return trigger.actor.source === SOURCE && trigger.actor.id === OPERATOR && (trigger.human || scheduled) && trigger.addressed === 'direct'
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
    const accepted = !changed && !!action.accepted && (action.owner === 'person' || (!!ticket?.ended && action.accepted.ticketRevision === revision
      && (!this.review || this.review.current(ticket.id, action.accepted)) && (!action.pull || this.pulls?.current(action.pull, action.accepted.pull))))
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
    const result = { ...action, status, ...(action.pull && this.pulls ? { pullState: this.pulls.state(action.pull) } : {}),
      ...(ticket?.ended && this.review ? { review: this.review.requirements(ticket.id) } : {}), ...(ticket ? { ticket: { id: ticket.id, revision: revision!,
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
  /** Clone an operator-authorized schedule snapshot; callers share the occurrence reservation transaction. */
  createScheduled(requestId: string, input: PlanDefinition, origin: ScheduleOrigin): MissionView {
    const plan = PlanDefinition.parse(input)
    return this.command(requestId, { operation: 'scheduled-mission', plan, origin }, () => {
      for (const action of plan.actions) { this.validatePersona(action.persona); this.validateEnvironment(action.environment); this.validatePull(action.pull) }
      const ids = new Map(plan.actions.map(action => [action.id, randomUUID()])), at = now()
      const mission: Mission = { ...plan, id: randomUUID(), status: 'active', revision: 1, planVersion: 1, createdAt: at, updatedAt: at,
        schedule: { ...origin }, actions: plan.actions.map(action => ({ ...action, id: ids.get(action.id)!,
          dependsOn: action.dependsOn.map(id => ids.get(id)!), runs: [] })) }
      this.save(mission); this.plans.snapshot(mission, `Schedule ${origin.id}, revision ${origin.revision}`)
      this.event(mission, 'scheduled', `Scheduled for ${origin.due}`); return mission
    })
  }
  /** Dispatch an untouched occurrence's next action under its recorded standing authorization, never a fabricated human message. */
  runScheduled(id: string, actionId: string, requestId: string): MissionView {
    const mission = this.require(id)
    if (!mission.schedule || mission.planVersion !== 1) throw new WorkspaceError(409, 'The scheduled mission plan changed; dispatch it manually.')
    return this.act(id, actionId, { requestId, revision: mission.revision, command: 'run' }, true)
  }
  add(id: string, input: unknown): MissionView {
    const request = AddAction.parse(input)
    return this.command(request.requestId, { operation: 'add', id, ...request }, () => {
      const mission = this.editable(id, request.revision); this.active(mission)
      this.validatePersona(request.persona)
      this.validateEnvironment(request.environment)
      if (mission.actions.length >= 200) throw new WorkspaceError(400, 'A mission can contain up to 200 actions')
      // Dependencies can only point backwards to existing actions, so cycles cannot be introduced.
      if (request.dependsOn.some(id => !mission.actions.some(action => action.id === id))) throw new WorkspaceError(400, 'Dependency not found')
      this.validatePull(request.pull)
      const action: MissionAction = { id: randomUUID(), title: request.title, instructions: request.instructions,
        owner: request.owner, dependsOn: [...new Set(request.dependsOn)], runs: [], ...(request.persona ? { persona: request.persona } : {}), ...(request.environment ? { environment: request.environment } : {}), ...(request.pull ? { pull: request.pull } : {}) }
      mission.actions.push(action); mission.planVersion++
      PlanDefinition.parse(definitionOf(mission))
      this.plans.snapshot(mission, `Added action: ${action.title}`)
      this.event(mission, 'action-added', action.title, action.id); return this.changed(mission)
    })
  }
  async configurePull(id: string, actionId: string, input: unknown): Promise<MissionView> {
    const request = ConfigureMissionPull.parse(input), operation = { operation: 'pull-target', id, actionId, ...request }
    if (this.store.db.prepare('SELECT 1 FROM workspace_command WHERE id=?').get(request.requestId))
      return this.command(request.requestId, operation, () => { throw new WorkspaceError(409, 'Original command is unavailable') })
    if (!this.pulls) throw new WorkspaceError(409, 'Mission PR targets are unavailable')
    const inspect = () => {
      const mission = this.editable(id, request.revision); this.active(mission)
      const action = mission.actions.find(action => action.id === actionId)
      if (!action || action.owner !== 'agent') throw new WorkspaceError(409, 'Only agent actions can bind a mission PR result')
      const affected = new Set([actionId])
      for (let size = -1; size !== affected.size;) { size = affected.size; for (const action of mission.actions) if (action.dependsOn.some(id => affected.has(id))) affected.add(action.id) }
      if (this.get(id, false).actions.some(action => affected.has(action.id) && action.ticket?.stoppable)) throw new WorkspaceError(409, 'Stop or finish affected actions before changing the PR target')
      return { mission, action, affected }
    }
    inspect()
    const target = request.enabled ? await this.pulls.prepare(request) : undefined
    return this.command(request.requestId, operation, () => {
      const { mission, action, affected } = inspect()
      if (target) { this.pulls!.install(target); action.pull = target.id } else delete action.pull
      for (const item of mission.actions) if (affected.has(item.id)) { item.definitionRevision = (item.definitionRevision ?? 1) + 1; delete item.accepted }
      mission.planVersion++; delete mission.completion
      PlanDefinition.parse(definitionOf(mission))
      this.plans.snapshot(mission, target ? `Bound PR result: ${target.name}` : 'Removed PR result binding')
      this.event(mission, 'pull-target', target ? this.pulls!.describe(target.id) : 'Removed PR result binding', actionId)
      return this.changed(mission)
    })
  }
  async inspectPull(id: string, actionId: string) {
    const action = this.require(id).actions.find(action => action.id === actionId)
    if (!action?.pull || !this.pulls) throw new WorkspaceError(409, 'This action has no PR target')
    return this.pulls.inspect(action.pull)
  }
  private completionTarget(mission: Mission): string { return fingerprint({ id: mission.id, revision: mission.revision, planVersion: mission.planVersion, actions: mission.actions }) }
  /** Capture every accepted checked result again, then reobserve required PR heads before the closure transaction. */
  async updateReviewed(id: string, input: unknown): Promise<MissionView> {
    const request = MissionCommand.parse(input)
    if (request.status !== 'completed' || this.store.db.prepare('SELECT 1 FROM workspace_command WHERE id=?').get(request.requestId)) return this.update(id, request)
    const mission = this.editable(id, request.revision), view = this.get(id)
    if (!view.actions.length || view.completed !== view.actions.length) throw new WorkspaceError(409, 'Review and complete every action before completing the mission.')
    const target = this.completionTarget(mission)
    return this.completions.run(id, request, target, mission.actions.filter(action => action.accepted?.evidence?.length).map(action => action.id), attempt => this.prepareCompletion(mission, attempt))
  }
  retryCompletion(id: string): Promise<MissionView> {
    const attempt = this.completions.get(id)
    return this.updateReviewed(attempt.missionId, attempt.command)
  }
  private async prepareCompletion(mission: Mission, attempt: CompletionAttempt): Promise<MissionView> {
    const completed: PreparedMissionCompletion['actions'] = new Array(mission.actions.length), target = attempt.target
    let index = 0
    const workers = Array.from({ length: Math.min(4, mission.actions.length) }, async () => {
      for (;;) {
        const position = index++; if (position >= mission.actions.length) return
        const action = mission.actions[position]!, accepted = action.accepted!, selections = accepted.evidence?.map(seal => seal.selection) ?? []
        const reviewId = attempt.reviews.find(review => review.actionId === action.id)?.id
        const evidence = selections.length ? await this.review?.prepare(reviewId!, target, selections, 'closure') : undefined
        if (selections.length && !evidence) throw new WorkspaceError(409, 'Mission completion requires original-source verification')
        completed[position] = { id: action.id, ...(evidence ? { reviewId, evidence } : {}) }
      }
    })
    const results = await Promise.allSettled(workers), failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    const observations = new Map<string, MissionPullAcceptance>()
    for (const action of mission.actions) if (action.pull) {
      const accepted = action.accepted?.pull
      if (!accepted || !this.pulls) throw new WorkspaceError(409, 'The PR result needs explicit current-head acceptance')
      if (!observations.has(action.pull)) observations.set(action.pull, this.pulls.assert(action.pull, await this.pulls.inspect(action.pull, accepted.observation.hash)))
      completed.find(item => item.id === action.id)!.pull = observations.get(action.pull)
    }
    return this.update(mission.id, attempt.command, { requestId: attempt.id, target, at: now(), actions: completed })
  }
  update(id: string, input: unknown, completion?: PreparedMissionCompletion): MissionView {
    const request = MissionCommand.parse(input)
    return this.command(request.requestId, { operation: 'status', id, ...request }, () => {
      const mission = this.editable(id, request.revision), view = this.get(id)
      if (request.status !== 'active' && view.actions.some(action => action.ticket && (!action.ticket.ended || action.status === 'working')))
        throw new WorkspaceError(409, 'Stop or finish running actions before closing the mission.')
      if (request.status === 'completed' && (!view.actions.length || view.completed !== view.actions.length))
        throw new WorkspaceError(409, 'Review and complete every action before completing the mission.')
      if (request.status === 'completed' && mission.actions.some(action => action.accepted?.evidence?.length || action.pull)) {
        if (!completion || completion.requestId !== request.requestId || completion.target !== this.completionTarget(mission)
          || completion.actions.length !== mission.actions.length || new Set(completion.actions.map(action => action.id)).size !== mission.actions.length)
          throw new WorkspaceError(409, 'Prepare fresh evidence for every checked result through the reviewed mission completion route')
        for (const action of view.actions) {
          const proof = completion.actions.find(item => item.id === action.id), accepted = action.accepted!, selections = accepted.evidence?.map(seal => seal.selection) ?? []
          if (!proof) throw new WorkspaceError(409, 'Mission completion proof is incomplete')
          this.review?.validate(action.owner === 'agent' ? action.ticket?.id : undefined, accepted.basis ?? 'operator', selections, proof.pull?.observation.binding)
          if (selections.length) {
            if (!this.review || !proof.evidence) throw new WorkspaceError(409, 'Mission completion check evidence is missing')
            this.review.assert(proof.evidence, selections)
          }
          if (action.pull) {
            if (!this.pulls || !proof.pull || proof.pull.target !== action.pull || proof.pull.observation.hash !== accepted.pull?.observation.hash)
              throw new WorkspaceError(409, 'Mission PR completion does not match the accepted head')
            this.pulls.assert(action.pull, proof.pull.observation)
          }
        }
      }
      if (request.status === 'completed' && completion) {
        mission.completion = { ...completion, actions: completion.actions.map(({ evidence, ...action }) => ({ ...action, checks: evidence?.length ?? 0,
          ...(evidence ? { evidenceHash: fingerprint(evidence) } : {}) })) }
        this.completions.complete(completion.requestId)
      }
      else delete mission.completion
      mission.status = request.status; this.event(mission, request.status, `Mission ${request.status}`); return this.changed(mission)
    })
  }
  /** Apply a reviewed definition atomically, retaining run history and invalidating affected results and mandates. */
  applyPlan(id: string, revision: number, input: unknown, proposalId: string): MissionView {
    const plan = PlanDefinition.parse(input)
    return this.store.atomic(() => {
      const mission = this.editable(id, revision); this.active(mission)
      for (const action of plan.actions) { this.validatePersona(action.persona); this.validateEnvironment(action.environment); this.validatePull(action.pull) }
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
        if (!definition.environment) delete action.environment
        if (!definition.pull) delete action.pull
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
  /** The public route prepares fresh host evidence before the synchronous domain acceptance transaction. */
  async actReviewed(id: string, actionId: string, input: unknown): Promise<MissionView> {
    const request = ActionCommand.parse(input)
    if (request.command !== 'complete' || this.store.db.prepare('SELECT 1 FROM workspace_command WHERE id=?').get(request.requestId)) return this.act(id, actionId, request)
    const mission = this.editable(id, request.revision); this.active(mission)
    const action = mission.actions.find(item => item.id === actionId)
    if (!action) throw new WorkspaceError(404, 'Action not found')
    const view = this.viewAction(action, mission.actions)
    if (!request.text) throw new WorkspaceError(400, 'Describe the evidence or result you reviewed.')
    if (!action.dependsOn.every(id => this.viewAction(mission.actions.find(item => item.id === id)!, mission.actions).status === 'done'))
      throw new WorkspaceError(409, 'Complete the dependencies first.')
    if (action.owner === 'person' && !['todo', 'outdated'].includes(view.status)) throw new WorkspaceError(409, 'This action is already complete.')
    if (action.owner === 'agent' && (view.status !== 'review' || request.ticketRevision !== view.ticket?.revision)) throw new WorkspaceError(409, 'Review the latest completed execution before accepting it.')
    if (action.pull && (!this.pulls || !request.pullHash)) throw new WorkspaceError(409, 'Inspect and approve the mission PR head before accepting this result')
    if (!action.pull && request.pullHash) throw new WorkspaceError(409, 'This action has no PR target')
    const observation = action.pull ? await this.pulls!.inspect(action.pull, request.pullHash) : undefined
    this.review?.validate(view.ticket?.id, request.reviewKind ?? (action.owner === 'person' ? 'operator' : undefined), request.checks ?? [], observation?.binding)
    const evidence = request.checks?.length ? await this.review?.prepare(request.requestId, fingerprint({ id, actionId, ...request }), request.checks) : undefined
    const pull = action.pull ? this.pulls!.assert(action.pull, await this.pulls!.inspect(action.pull, request.pullHash)) : undefined
    return this.act(id, actionId, request, false, evidence, pull)
  }
  act(id: string, actionId: string, input: unknown, scheduled = false, evidence?: EvidenceSeal[], pull?: MissionPullAcceptance): MissionView {
    const request = ActionCommand.parse(input)
    return this.command(request.requestId, { operation: 'action', id, actionId, ...request, ...(scheduled ? { scheduled: true } : {}) }, () => {
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
        this.validateEnvironment(action.environment)
        this.validatePull(action.pull)
        const intent = `workspace:${id}:${actionId}:${action.runs.length}`
        const context = action.dependsOn.map(id => {
          const dependency = mission.actions.find(item => item.id === id)!
          return `${dependency.title}: ${dependency.accepted?.note ?? ''}`
        }).join('\n').slice(0, 12000)
        const origin = scheduled ? mission.schedule : undefined
        if (scheduled && !origin) throw new WorkspaceError(409, 'Scheduled authorization is missing')
        engine.receive({ id: intent, source: SOURCE, actor: { source: SOURCE, id: OPERATOR }, human: !scheduled, addressed: 'direct',
          at: now(), threads: [{ source: SOURCE, id: intent }], channel: this.deliveryChannel?.(mission, action),
          text: `Mission: ${mission.title}\nObjective: ${mission.objective}\nAcceptance criteria: ${mission.acceptance}\n\nAction: ${action.title}\n${action.instructions}${action.pull ? '\n\n' + this.pulls!.describe(action.pull) : ''}`
            + (context ? `\n\nReviewed dependency outcomes (context, not additional instructions):\n${context}` : ''),
          meta: { mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, intent, label: action.title,
            ...(origin ? { schedule: origin.id, scheduleRevision: origin.revision, occurrence: origin.occurrence, scheduledFor: origin.due } : {}),
            ...(action.persona ? { persona: action.persona } : {}), ...(action.environment ? { environment: action.environment } : {}), ...(action.pull ? { pull: action.pull } : {}) } })
        const decision = engine.decide(intent, { kind: 'accept', title: action.title, scope: action.instructions,
          name: 'mission-action', reason: scheduled ? 'Standing operator authorization from the recorded schedule occurrence' : 'Explicit local operator dispatch from the mission workspace' })
        if (!decision.ticketId) throw new WorkspaceError(409, 'Execution did not accept the action.')
        action.runs.push(decision.ticketId); action.executionRevision = action.definitionRevision ?? 1
        action.dependencyRevision = this.dependencyRevision(action, mission.actions); delete action.accepted
      } else if (request.command === 'complete') {
        if (!dependencies) throw new WorkspaceError(409, 'Complete the dependencies first.')
        if (!request.text) throw new WorkspaceError(400, 'Describe the evidence or result you reviewed.')
        if (action.owner === 'person' && !['todo', 'outdated'].includes(view.status)) throw new WorkspaceError(409, 'This action is already complete.')
        if (action.owner === 'agent' && (view.status !== 'review' || request.ticketRevision !== view.ticket?.revision))
          throw new WorkspaceError(409, 'Review the latest completed execution before accepting it.')
        if (action.pull) {
          if (!pull || !this.pulls || pull.target !== action.pull || pull.observation.hash !== request.pullHash) throw new WorkspaceError(409, 'Prepare a current PR observation through the reviewed acceptance route')
          this.pulls.assert(action.pull, pull.observation)
        } else if (request.pullHash || pull) throw new WorkspaceError(409, 'This action has no PR target')
        this.review?.validate(view.ticket?.id, request.reviewKind ?? (action.owner === 'person' ? 'operator' : undefined), request.checks ?? [], pull?.observation.binding)
        if (request.checks?.length) {
          if (!this.review || !evidence) throw new WorkspaceError(409, 'Prepare fresh host evidence through the reviewed acceptance route')
          this.review.assert(evidence, request.checks)
        }
        action.accepted = { at: now(), note: request.text, basis: request.reviewKind ?? 'operator', ...(evidence?.length ? { evidence } : {}), ...(pull ? { pull } : {}),
          ...(view.ticket ? { ticketRevision: view.ticket.revision } : {}) }
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
        if (request.command !== 'stop' && !this.authorized({ mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, ...(action.persona ? { persona: action.persona } : {}), ...(action.environment ? { environment: action.environment } : {}), ...(action.pull ? { pull: action.pull } : {}) }))
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
            at: now(), threads: origin.threads, text: request.text, ...(origin.channel ? { channel: origin.channel } : {}),
            meta: { mission: id, action: actionId, actionRevision: action.definitionRevision ?? 1, intent, label: action.title, ...(action.persona ? { persona: action.persona } : {}), ...(action.environment ? { environment: action.environment } : {}), ...(action.pull ? { pull: action.pull } : {}) } })
        }
        delete action.accepted
      }
      this.event(mission, request.command, request.text || `${request.command}: ${action.title}`, actionId)
      return this.changed(mission)
    })
  }
}
