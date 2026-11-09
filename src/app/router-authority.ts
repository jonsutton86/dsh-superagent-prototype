import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import { killJobs, runningJobs, stopSubagents, until } from '../executor/background.ts'

export const ROUTER_ONLY = 'The coordinator has routing authority only. Use orchestrator_read, orchestrator_eval_read and workspace recall for context; dispatch authorized work to a ticket worker.'
export const ROUTER_CHILD = 'Coordinator descendants cannot execute work. Start an authorized ticket; worker-local teams remain available.'
type Subagents = { listChildren(id: string): Promise<readonly { id: string }[]> }

/** Session identity, rather than a selectable preset or prompt, determines the coordinator's execution boundary. */
export class RouterAuthority {
  private ready = false
  private problem = 'The coordinator is preparing its routing-only authority'
  readonly dispose: () => void
  constructor(private readonly ctx: Context, private readonly agent: Agent, names: readonly string[],
    private readonly store: Pick<Store, 'set'>, private readonly lifetime: AbortSignal) {
    // run_code is Harness's sandboxed tool-composition transport; each nested tool still passes this guard.
    const allowed = new Set(['skill', 'run_code', ...names])
    const restrictions = agent.ctx.tools.restrict({ allow: ['skill'] })
    const guard = agent.ctx.tools.guard(execution => !allowed.has(execution.name) ? ROUTER_ONLY : this.ready ? undefined : this.problem)
    this.dispose = () => { guard(); restrictions() }
  }
  assertReady(): void { if (!this.ready) throw new Error(this.problem) }
  /** Retire known legacy router jobs/children before routing resumes; a timeout never proves quiescence. */
  async prepare(): Promise<void> {
    try {
      const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000)])
      if (this.agent.status !== 'idle') this.agent.cancel({ kind: 'user' }, { keepInbox: true })
      if (await until(this.agent.whenIdle(), signal) === false || this.agent.status !== 'idle')
        throw new Error('Legacy coordinator turn has not quiesced; inspect it before resuming')
      const subagents = this.ctx.get('subagents') as Subagents | undefined, owners: string[] = [this.agent.id], seen = new Set(owners)
      for (let position = 0; position < owners.length; position++) {
        signal.throwIfAborted()
        const owner = this.ctx.agents.get(owners[position]! as SessionId)
        if (owner && (await until(owner.whenIdle(), signal) === false || owner.status !== 'idle'))
          throw new Error('Legacy coordinator descendant turn has not quiesced; inspect it before resuming')
        const children = await until(subagents?.listChildren(owners[position]!) ?? Promise.resolve([]), signal)
        if (children === false) throw new Error('Legacy coordinator descendant inventory is unavailable; inspect it before resuming')
        for (const child of children) if (!seen.has(child.id)) {
          if (owners.length >= 1024) throw new Error('Legacy coordinator descendant inventory exceeds 1,024 Sessions; inspect it before resuming')
          seen.add(child.id); owners.push(child.id)
          this.store.set(KV.sessions.routerOwner(child.id), this.agent.id)
          const agent = this.ctx.agents.get(child.id as SessionId)
          if (agent) { agent.ctx.effect(() => agent.ctx.tools.guard(() => ROUTER_CHILD)); agent.cancel({ kind: 'user' }, { keepInbox: true }) }
        }
      }
      signal.throwIfAborted()
      const stopped = await until((async () => {
        await Promise.all(owners.map(id => killJobs(this.ctx, id, 'Coordinator execution authority retired')))
        await stopSubagents(this.ctx, this.agent, true)
        await this.agent.whenIdle()
      })(), signal)
      if (stopped === false || this.agent.status !== 'idle' || owners.some(id => runningJobs(this.ctx, id).length)
        || owners.slice(1).some(id => { const agent = this.ctx.agents.get(id as SessionId); return agent && agent.status !== 'idle' }))
        throw new Error('Legacy coordinator execution has not quiesced; inspect its original jobs and descendants before resuming')
      signal.throwIfAborted(); this.ready = true
    } catch (error) { this.problem = String(error); throw error }
  }
}
