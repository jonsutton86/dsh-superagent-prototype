/** Durable managed-model accounting and atomic admission reservations. Currency values are integer micro-USD. */
import { randomUUID } from 'node:crypto'
import type { SQLInputValue } from 'node:sqlite'
import { key } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { SaveUsage, ReconcileUsage, UsageTokens, UsageError, type UsageScope, type UsageOwner, type UsageCall,
  type UsageConfiguration, type UsageBudget, type ModelPrice, type UsageTotals, type UsagePage, type BudgetView } from './model.ts'

const valid = (value: number): number => { if (!Number.isSafeInteger(value) || value < 0) throw new UsageError(409, 'Usage totals exceed the supported range'); return value }
const sumTokens = (usage: UsageTokens): number => valid(Math.max(usage.totalTokens ?? 0,
  usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)))
const micros = (amount: bigint): number => valid(Number((amount + 999999n) / 1000000n))
/** Cache input counters are disjoint; reasoning is already part of output and is not counted twice. */
export function pricedUsage(usage: UsageTokens, price: ModelPrice): number {
  const classified = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  const extra = Math.max(0, (usage.totalTokens ?? 0) - classified)
  return micros(BigInt(usage.inputTokens) * BigInt(price.input) + BigInt(usage.outputTokens) * BigInt(price.output)
    + BigInt(usage.cacheReadTokens ?? 0) * BigInt(price.cacheRead) + BigInt(usage.cacheWriteTokens ?? 0) * BigInt(price.cacheWrite)
    + BigInt(extra) * BigInt(Math.max(price.input, price.output, price.cacheRead, price.cacheWrite)))
}
export function budgetFrom(period: UsageBudget['period'], at: number): string {
  const date = new Date(at)
  return period === 'lifetime' ? '0000-01-01T00:00:00.000Z' : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), period === 'month' ? 1 : date.getUTCDate())).toISOString()
}
const matches = (scope: UsageScope, owner: UsageOwner): boolean => scope.kind === 'workspace'
  || owner[scope.kind === 'mission' ? 'missionId' : scope.kind === 'schedule' ? 'scheduleId' : 'personaId'] === scope.id

/** Keeps accounting facts, in-flight reservations and configuration history in the coordinator Store, across process restarts. */
export class Usage {
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS usage_configuration (revision INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_call (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT AS (value ->> '$.startedAt'),
        phase TEXT AS (value ->> '$.phase'), mission TEXT AS (value ->> '$.owner.missionId'), schedule TEXT AS (value ->> '$.owner.scheduleId'), persona TEXT AS (value ->> '$.owner.personaId'));
      CREATE INDEX IF NOT EXISTS usage_call_at ON usage_call(at);
      CREATE INDEX IF NOT EXISTS usage_call_mission ON usage_call(mission,at);
      CREATE INDEX IF NOT EXISTS usage_call_schedule ON usage_call(schedule,at);
      CREATE INDEX IF NOT EXISTS usage_call_persona ON usage_call(persona,at);
      CREATE TABLE IF NOT EXISTS usage_command (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_session (id TEXT PRIMARY KEY, root TEXT NOT NULL);`)
    if (!store.db.prepare('SELECT 1 FROM usage_configuration LIMIT 1').get()) {
      const at = this.now(); this.store.db.prepare('INSERT INTO usage_configuration VALUES (0,?)')
        .run(JSON.stringify({ revision: 0, at, trackingSince: at, prices: [], budgets: [] } satisfies UsageConfiguration))
    }
    this.interrupted()
  }
  private now(): string { return new Date(this.clock()).toISOString() }
  /** No provider settlement may be inferred for a call interrupted by coordinator loss. */
  interrupted(): void {
    this.store.db.prepare(`UPDATE usage_call SET value=json_set(value,'$.phase','unknown','$.outcome','interrupted') WHERE phase='pending'`).run()
  }
  configuration(revision?: number): UsageConfiguration {
    const row = revision === undefined ? this.store.db.prepare('SELECT value FROM usage_configuration ORDER BY revision DESC LIMIT 1').get()
      : this.store.db.prepare('SELECT value FROM usage_configuration WHERE revision=?').get(revision)
    if (!row) throw new UsageError(404, 'Usage configuration not found')
    return JSON.parse(String(row.value)) as UsageConfiguration
  }
  binding(sessionId: string): string | undefined { return this.store.db.prepare('SELECT root FROM usage_session WHERE id=?').get(sessionId)?.root as string | undefined }
  bind(sessionId: string, root: string): void {
    const previous = this.binding(sessionId)
    if (previous !== undefined && previous !== root) throw new UsageError(409, 'Session accounting lineage changed')
    this.store.db.prepare('INSERT OR IGNORE INTO usage_session VALUES (?,?)').run(sessionId, root)
  }
  private command(requestId: string, input: unknown, operation: () => void): void {
    this.store.atomic(() => {
      const fingerprint = key(JSON.stringify(input)), receipt = this.store.db.prepare('SELECT fingerprint FROM usage_command WHERE id=?').get(requestId)
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new UsageError(409, 'This request ID was already used for another operation'); return }
      operation(); this.store.db.prepare('INSERT INTO usage_command VALUES (?,?)').run(requestId, fingerprint)
    })
  }
  configure(input: unknown): UsageConfiguration {
    const request = SaveUsage.parse(input)
    this.command(request.requestId, { operation: 'configure', ...request }, () => {
      const previous = this.configuration()
      if (request.revision !== previous.revision) throw new UsageError(409, 'Usage configuration changed; reload before editing')
      const value: UsageConfiguration = { revision: previous.revision + 1, at: this.now(), trackingSince: previous.trackingSince,
        prices: request.prices, budgets: request.budgets }
      this.store.db.prepare('INSERT INTO usage_configuration VALUES (?,?)').run(value.revision, JSON.stringify(value))
    })
    return this.configuration()
  }
  private filter(scope: UsageScope, from: string): { sql: string; args: SQLInputValue[] } {
    return scope.kind === 'workspace' ? { sql: 'at>=?', args: [from] }
      : { sql: `${scope.kind}=? AND at>=?`, args: [scope.id, from] }
  }
  totals(scope: UsageScope, from: string): UsageTotals {
    const filter = this.filter(scope, from)
    const row = this.store.db.prepare(`SELECT count(*) AS calls,
      coalesce(sum(value ->> '$.totalTokens'),0) AS tokens, coalesce(sum(value ->> '$.cost'),0) AS cost,
      coalesce(sum(CASE WHEN phase IN ('pending','unknown') THEN coalesce(value ->> '$.reservedTokens',0) ELSE 0 END),0) AS reservedTokens,
      coalesce(sum(CASE WHEN value ->> '$.cost' IS NULL THEN coalesce(value ->> '$.reservedCost',0) ELSE 0 END),0) AS reservedCost,
      count(CASE WHEN value ->> '$.totalTokens' IS NULL AND value ->> '$.reservedTokens' IS NULL THEN 1 END) AS unknownTokens,
      count(CASE WHEN value ->> '$.cost' IS NULL AND value ->> '$.reservedCost' IS NULL THEN 1 END) AS unknownCost,
      count(CASE WHEN phase='pending' THEN 1 END) AS pending FROM usage_call WHERE ${filter.sql}`).get(...filter.args)!
    return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, valid(Number(value))])) as unknown as UsageTotals
  }
  private budgetView(budget: UsageBudget): BudgetView {
    const from = budgetFrom(budget.period, this.clock()), totals = this.totals(budget.scope, from)
    return { ...budget, from, totals, exhausted: budget.enabled && (budget.calls !== undefined && totals.calls >= budget.calls
      || budget.tokens !== undefined && (totals.unknownTokens > 0 || totals.tokens + totals.reservedTokens >= budget.tokens)
      || budget.cost !== undefined && (totals.unknownCost > 0 || totals.cost + totals.reservedCost >= budget.cost)) }
  }
  page(scope: UsageScope = { kind: 'workspace' }, from = budgetFrom('month', this.clock()), offset = 0, limit = 30): UsagePage {
    const configuration = this.configuration(), filter = this.filter(scope, from)
    const rows = this.store.db.prepare(`SELECT value FROM usage_call WHERE ${filter.sql} ORDER BY at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...filter.args, limit + 1, offset)
    return { configuration, scope, from, totals: this.totals(scope, from), budgets: configuration.budgets.map(budget => this.budgetView(budget)),
      calls: rows.slice(0, limit).map(row => JSON.parse(String(row.value)) as UsageCall), nextOffset: rows.length > limit ? offset + limit : null }
  }
  /** Reserve the model's declared combined context ceiling at its most expensive configured token rate before dispatch. */
  begin(owner: UsageOwner, provider: string, model: string, purpose: string, ceiling?: number): UsageCall {
    return this.store.atomic(() => {
      const config = this.configuration(), price = config.prices.find(value => value.provider === provider && value.model === model)
      const reservedTokens = ceiling !== undefined && Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling <= 1e9 ? ceiling : undefined
      const reservedCost = reservedTokens !== undefined && price ? micros(BigInt(reservedTokens) * BigInt(Math.max(price.input, price.output, price.cacheRead, price.cacheWrite))) : undefined
      for (const budget of config.budgets.filter(value => value.enabled && matches(value.scope, owner))) {
        const totals = this.totals(budget.scope, budgetFrom(budget.period, this.clock()))
        if (budget.calls !== undefined && totals.calls + 1 > budget.calls) throw new UsageError(409, `Model call limit reached: ${budget.title}`)
        if (budget.tokens !== undefined && (reservedTokens === undefined || totals.unknownTokens || totals.tokens + totals.reservedTokens + reservedTokens > budget.tokens))
          throw new UsageError(409, `Token reservation unavailable: ${budget.title}. Resolve unknown calls or allow the model's context ceiling.`)
        if (budget.cost !== undefined && (reservedCost === undefined || totals.unknownCost || totals.cost + totals.reservedCost + reservedCost > budget.cost))
          throw new UsageError(409, `Estimated spend reservation unavailable: ${budget.title}. Check prices, unresolved calls and remaining allowance.`)
      }
      const value: UsageCall = { id: randomUUID(), owner, provider, model, purpose, startedAt: this.now(), phase: 'pending',
        configRevision: config.revision, ...(reservedTokens !== undefined ? { reservedTokens } : {}), ...(reservedCost !== undefined ? { reservedCost } : {}), ...(price ? { price } : {}) }
      this.store.db.prepare('INSERT INTO usage_call(id,value) VALUES (?,?)').run(value.id, JSON.stringify(value)); return value
    })
  }
  get(id: string): UsageCall {
    const row = this.store.db.prepare('SELECT value FROM usage_call WHERE id=?').get(id)
    if (!row) throw new UsageError(404, 'Model call not found')
    return JSON.parse(String(row.value)) as UsageCall
  }
  private save(call: UsageCall): void { this.store.db.prepare('UPDATE usage_call SET value=? WHERE id=?').run(JSON.stringify(call), call.id) }
  settle(id: string, outcome: string, reported?: unknown): void {
    this.store.atomic(() => {
      const call = this.get(id)
      if (call.phase !== 'pending') return
      const parsed = UsageTokens.safeParse(reported)
      if (parsed.success) {
        try {
          const total = sumTokens(parsed.data), cost = call.price ? pricedUsage(parsed.data, call.price) : undefined
          call.tokens = parsed.data; call.totalTokens = total; call.cost = cost; call.phase = 'reported'
        } catch { call.phase = 'unknown' }
      } else call.phase = 'unknown'
      call.outcome = outcome; call.settledAt = this.now(); this.save(call)
    })
  }
  /** An operator can reconcile an uncertain call using provider records; the original facts and price snapshot remain intact. */
  reconcile(id: string, input: unknown): UsageCall {
    const request = ReconcileUsage.parse(input)
    this.command(request.requestId, { operation: 'reconcile', id, ...request }, () => {
      const call = this.get(id)
      if (call.phase === 'pending' || call.phase === 'reconciled' || call.phase === 'reported' && call.cost !== undefined)
        throw new UsageError(409, 'This call is not awaiting reconciliation')
      if (!call.price && request.cost === undefined) throw new UsageError(400, 'Record a verified USD cost for a call without a captured price')
      call.reconciliation = { at: this.now(), note: request.note, tokens: request.tokens, ...(request.cost !== undefined ? { cost: request.cost } : {}) }
      call.totalTokens = sumTokens(request.tokens)
      call.cost = request.cost ?? (call.price ? pricedUsage(request.tokens, call.price) : undefined)
      call.phase = 'reconciled'; this.save(call)
    })
    return this.get(id)
  }
}
