/** Attribute managed Harness model streams and account at the public llm/stream boundary without rewriting requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Store } from '../app/store.ts'
import type { HealthEntry } from '../infra/health.ts'
import { ticketOfSession, workerSessionId } from '../executor/dsh.ts'
import type { Mission } from '../workspace/model.ts'
import { UsageError, type UsageOwner } from './model.ts'
import { Usage } from './service.ts'

/** One coordinator's accounting hook; immutable Session ancestry attributes worker descendants to the same mission budgets. */
export class UsageRuntime {
  private closed = false
  private readonly off: () => void
  constructor(private readonly ctx: Context, private readonly store: Store, readonly usage: Usage, private readonly masterId: string,
    private readonly lifetime: AbortSignal, private readonly health: HealthEntry) {
    this.off = ctx.on('llm/stream', (options, next) => this.stream(options, next), { prepend: true })
    health.set({ state: 'ready', detail: 'Managed model usage is recorded before dispatch' })
  }
  private root(id: string): boolean { return id === this.masterId || !!this.store.tickets.get(ticketOfSession(id) ?? '') }
  private active(): void {
    if (this.closed) throw new UsageError(409, 'Model accounting has stopped')
    this.lifetime.throwIfAborted()
  }
  private async owner(sessionId: string): Promise<UsageOwner | undefined> {
    let root = this.usage.binding(sessionId)
    if (!root) {
      let current: string | undefined = sessionId
      const seen = new Set<string>()
      for (let depth = 0; current !== undefined && depth < 128; depth++) {
        this.active()
        if (seen.has(current)) throw new UsageError(409, 'Session accounting lineage contains a cycle')
        seen.add(current)
        if (this.root(current)) { root = current; break }
        const bound = this.usage.binding(current)
        if (bound) { root = bound; break }
        let header: SessionHeader | undefined = this.ctx.agents.get(current as SessionId)?.session.header
        if (!header) {
          try { header = (await this.ctx.sessionController.inspect(current as SessionId, AbortSignal.any([this.lifetime, AbortSignal.timeout(10000)]))).meta }
          catch { throw new UsageError(409, 'Cannot establish Session ancestry for model accounting') }
        }
        this.active(); current = header.parentSession
        if (depth === 127 && current !== undefined) throw new UsageError(409, 'Session accounting lineage exceeds the traversal limit')
      }
      if (!root) return
      this.usage.bind(sessionId, root)
    }
    if (root === this.masterId) return { sessionId, root, role: 'orchestrator' }
    const ticket = this.store.tickets.get(ticketOfSession(root) ?? '')
    if (!ticket) throw new UsageError(409, 'The owning task for model accounting is missing')
    const owner: UsageOwner = { sessionId, root: workerSessionId(ticket.id), role: 'worker', ticketId: ticket.id,
      ...(ticket.execution?.persona ? { personaId: ticket.execution.persona.id } : {}) }
    const trigger = this.store.triggers.get(ticket.origin.triggerId)
    if (trigger?.source === 'workspace' && typeof trigger.meta.mission === 'string') {
      const row = this.store.db.prepare('SELECT value FROM workspace_mission WHERE id=?').get(trigger.meta.mission)
      const mission = row && JSON.parse(String(row.value)) as Mission | undefined
      if (!mission || !mission.actions.some(action => action.runs.includes(ticket.id))) throw new UsageError(409, 'The owning mission for model accounting is missing')
      owner.missionId = mission.id
      if (mission.schedule) owner.scheduleId = mission.schedule.id
    }
    return owner
  }
  private async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    this.active()
    if (!options.sessionId) { yield* next(); return }
    let owner: UsageOwner | undefined
    try { owner = await this.owner(options.sessionId) }
    catch (error) { this.denied(error); throw error }
    if (!owner) { yield* next(); return }
    this.lifetime.throwIfAborted(); options.signal?.throwIfAborted()
    let ceiling: number | undefined
    try {
      ceiling = (await this.ctx.llm.resolveModelInfo(options.provider, options.model,
        AbortSignal.any([this.lifetime, AbortSignal.timeout(10000), ...options.signal ? [options.signal] : []]))).context?.contextWindow
    } catch { /* Without metadata, call-count limits still work; token/spend limits refuse the unbounded reservation. */ }
    this.lifetime.throwIfAborted(); options.signal?.throwIfAborted()
    let call
    if (this.closed) throw new UsageError(409, 'Model accounting has stopped')
    try { call = this.usage.begin(owner, options.provider, options.model, options.purpose ?? 'conversation', ceiling) }
    catch (error) { this.denied(error); throw error }
    let usage: unknown, outcome = 'interrupted', terminal = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish') { terminal = true; outcome = chunk.reason.kind }
        yield chunk
      }
    } finally {
      if (!this.closed) {
        this.usage.settle(call.id, outcome, terminal ? usage : undefined)
        this.health.set({ state: 'ready', detail: 'Managed model usage is recorded; unresolved calls retain their reservations', at: new Date().toISOString() })
      }
    }
  }
  private denied(error: unknown): void {
    this.health.set({ state: 'error', detail: error instanceof UsageError ? error.message : 'Model accounting is unavailable; no call was dispatched', at: new Date().toISOString() })
  }
  dispose(): void { this.closed = true; this.off(); this.usage.interrupted() }
}
