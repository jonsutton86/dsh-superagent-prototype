/** Durable global emergency stop: halts original work, blocks new dispatch, and requires an explicit release. */
import { z } from 'zod'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { AuditLog } from '../security/audit.ts'

export const EmergencyRecord = z.object({
  version: z.literal(1),
  engaged: z.boolean(),
  reason: z.string().max(500),
  actor: z.string().max(120),
  at: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  /** Replay identity of the last accepted action, so a retried request is idempotent. */
  requestId: z.string().max(200).nullable(),
  action: z.enum(['engage', 'release']).nullable(),
}).strict()
export type EmergencyRecord = z.infer<typeof EmergencyRecord>

export const EmergencyRequest = z.object({
  requestId: z.string().trim().min(1).max(200),
  action: z.enum(['engage', 'release']),
  reason: z.string().trim().min(1).max(500),
  actor: z.string().trim().min(1).max(120),
}).strict()
export type EmergencyRequest = z.infer<typeof EmergencyRequest>

export interface EmergencyHooks {
  /** Halts original work and settles stop receipts; must not start replacement work. */
  haltAll(reason: string): Promise<{ total: number; failed: number }>
  /** Wakes held dispatch after release; the ordinary pause remains a separate condition. */
  resume(): void
}

const initial = (): EmergencyRecord => ({ version: 1, engaged: false, reason: '', actor: '', at: null, revision: 0, requestId: null, action: null })

/**
 * State lives in the existing Store KV record, so an engaged stop survives restart and is visible before any worker
 * service is constructed. Engage persists first, then halts: a crash mid-halt leaves the stop engaged, never silent.
 */
export class Emergency {
  constructor(private readonly host: { store: Pick<Store, 'get' | 'set' | 'atomic'>; audit: Pick<AuditLog, 'append'>; hooks: EmergencyHooks },
    private readonly now: () => string = () => new Date().toISOString()) {}

  state(): EmergencyRecord {
    const stored = this.host.store.get(KV.runtime.emergency)
    const parsed = stored === undefined ? undefined : EmergencyRecord.safeParse(stored)
    return parsed?.success ? parsed.data : initial()
  }

  engaged(): boolean { return this.state().engaged }

  /** Engages idempotently: a replayed request returns the current state without a second halt or audit entry. */
  async engage(input: EmergencyRequest): Promise<EmergencyRecord> {
    const current = this.state()
    if (current.engaged) return current
    const next: EmergencyRecord = { version: 1, engaged: true, reason: input.reason, actor: input.actor, at: this.now(),
      revision: current.revision + 1, requestId: input.requestId, action: 'engage' }
    this.host.store.atomic(() => { this.host.store.set(KV.runtime.emergency, next) })
    this.audit('emergency.engage', input, 'completed', { revision: next.revision, reason: input.reason })
    const halt = await this.host.hooks.haltAll(input.reason)
    if (halt.failed) this.audit('emergency.halt', input, 'failed', { total: halt.total, failed: halt.failed })
    return this.state()
  }

  /** Releases idempotently. A replayed release returns the current state; an independent pause is not cleared. */
  async release(input: EmergencyRequest): Promise<EmergencyRecord> {
    const current = this.state()
    if (!current.engaged) return current
    if (current.requestId === input.requestId && current.action === 'release') return current
    const next: EmergencyRecord = { ...current, engaged: false, reason: input.reason, actor: input.actor, at: this.now(),
      revision: current.revision + 1, requestId: input.requestId, action: 'release' }
    this.host.store.atomic(() => { this.host.store.set(KV.runtime.emergency, next) })
    this.audit('emergency.release', input, 'completed', { revision: next.revision, reason: input.reason })
    this.host.hooks.resume()
    return this.state()
  }

  private audit(action: string, input: EmergencyRequest, outcome: 'completed' | 'failed', detail: Record<string, unknown>): void {
    try { this.host.audit.append({ actor: input.actor, action, resource: 'runtime', outcome, detail }) }
    catch { /* The stop state is authoritative; audit failure must not silently unlatch or block the emergency. */ }
  }
}
