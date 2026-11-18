/** Bounded recovery inference through the selected Harness host, without creating an Agent or sending Session history. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader, SessionLogOffset, type EpochHeader } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import { RoleModelSchema, SettingsSchema, type RoleModel } from '../policy.ts'
import { fingerprint } from '../remote/journal.ts'
import { ConfigurationMismatch } from './configuration.ts'
import { scanSession, type SessionArchive } from './sessions.ts'

export interface RecoveryInferenceHost {
  llm: Pick<LlmRuntime, 'prepareCall'>
  projections: Pick<Context['sessionProjections'], 'restore'>
  currentSelection(): unknown
}
export interface InferenceConfigurationVerification { routes: number; sessions: number; selections: string; resolved: string }
export interface InferenceConfigurationCheck { verify(): Promise<InferenceConfigurationVerification> }
/** Optional services are looked up lazily through Cordis's public get API, so offline modes and historical retries need no inference dependency. */
export function recoveryInferenceHost(ctx: Context): RecoveryInferenceHost {
  return { get llm() { return ctx.get('llm') as Context['llm'] },
    get projections() { return ctx.get('sessionProjections') as Context['sessionProjections'] },
    currentSelection: () => {
      const defaults = ctx.get('agentDefaultModel') as { currentSelection(): unknown } | undefined
      if (!defaults) throw new ConfigurationMismatch('configuration_missing')
      return defaults.currentSelection()
    } }
}
const selectionState = z.object({ pending: RoleModelSchema.nullable() })
const get = (db: DatabaseSync, key: string): unknown => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key)
  return row ? JSON.parse(String(row.value)) : undefined
}
const model = (value: unknown): RoleModel => RoleModelSchema.parse(value)
const selectedHeader = (header: EpochHeader): RoleModel => model({ provider: header.config.provider, model: header.config.model,
  ...(header.config.reasoningEffort && !header.adapterDefaults?.reasoningEffort ? { reasoningEffort: header.config.reasoningEffort } : {}) })

/** Derive current routes from authenticated state using Harness's public cold projection fold, never its private adapter configuration. */
export async function inferenceConfigurationCheck(host: RecoveryInferenceHost, db: DatabaseSync, archive: string,
  sessions: readonly SessionArchive[], masterId: string, signal: AbortSignal): Promise<InferenceConfigurationCheck> {
  const stage = { value: 'host-services' }
  try { return await deriveInferenceCheck(host, db, archive, sessions, masterId, signal, stage) }
  catch (error) {
    if (error instanceof ConfigurationMismatch) throw error
    const failure = new ConfigurationMismatch('configuration_unavailable')
    failure.message += ': inference/' + stage.value
    throw failure
  }
}

async function deriveInferenceCheck(host: RecoveryInferenceHost, db: DatabaseSync, archive: string,
  sessions: readonly SessionArchive[], masterId: string, signal: AbortSignal, stage: { value: string }): Promise<InferenceConfigurationCheck> {
  if (!host?.llm || !host.projections || !host.currentSelection) throw new ConfigurationMismatch('configuration_missing')
  stage.value = 'settings'
  let defaultModel: RoleModel | undefined
  const defaults = () => defaultModel ??= model(host.currentSelection())
  const revision = get(db, KV.settings.revision)
  const version = revision === undefined ? undefined : get(db, KV.settings.version(z.number().int().nonnegative().parse(revision)))
  if (revision !== undefined && (!version || typeof version !== 'object' || !('settings' in version))) throw new ConfigurationMismatch('configuration_missing')
  const settings = SettingsSchema.parse(version ? (version as { settings: unknown }).settings : {})
  stage.value = 'ticket-catalog'
  const tickets = [...db.prepare('SELECT value FROM ticket ORDER BY id').iterate()].map(row => JSON.parse(String(row.value)) as Ticket)
    .filter(ticket => !ticket.ended || ticket.ended.by !== 'human' && ticket.undelivered.length > 0)
  const roots = new Map<string, RoleModel | null>([[masterId, settings.eval.model],
    ...tickets.map(ticket => [`worker-${ticket.id}`, ticket.execution?.persona?.definition.model ?? settings.executor.model] as const)])
  const selected = new Set(roots.keys())
  for (let changed = true; changed;) {
    changed = false
    for (const session of sessions) if (session.header.parentSession && selected.has(session.header.parentSession) && !selected.has(session.id)) {
      selected.add(session.id); changed = true
    }
  }
  if (!sessions.some(session => session.id === masterId)) throw new ConfigurationMismatch('configuration_missing')
  const routes = new Map<string, RoleModel>(), selections: { id: string; route: string }[] = []
  const add = (id: string, value: RoleModel) => {
    const route = model(value), hash = fingerprint(route); routes.set(hash, route); selections.push({ id, route: hash })
    if (routes.size > 256) throw new ConfigurationMismatch('configuration_unavailable')
  }
  // New work uses the current role setting. Existing Sessions below retain their own durable selection.
  stage.value = 'role-selection'
  add('role:orchestrator', settings.eval.model ?? defaults())
  add('role:worker', settings.executor.model ?? defaults())
  let count = 0
  for (const session of sessions.filter(session => selected.has(session.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    signal.throwIfAborted()
    let header: EpochHeader | undefined
    stage.value = 'projection-initialization'
    let projected = host.projections.restore({}, [], SessionLogOffset(0), session.header, SessionLogOffset(session.inheritedEventCount))
    stage.value = 'archive'
    await scanSession(join(archive, session.member), session, signal, async (events, offset) => {
      stage.value = 'projection-page'
      projected = host.projections.restore(projected.checkpoint, events, SessionLogOffset(offset), session.header, SessionLogOffset(session.inheritedEventCount))
      header = foldRequestHeader(events, header)
      stage.value = 'archive'
    })
    stage.value = 'session-selection'
    const state = selectionState.safeParse(projected.checkpoint.modelSelection?.val)
    if (!state.success) throw new ConfigurationMismatch('configuration_missing')
    add('session:' + session.id, state.data.pending ?? (header ? selectedHeader(header) : roots.get(session.id) ?? defaults()))
    roots.delete(session.id); count++
  }
  // A queued ticket may not have created its worker Session yet. Its immutable persona still controls that first call.
  stage.value = 'queued-selection'
  for (const [id, route] of roots) add('queued:' + id, route ?? defaults())
  const selectionsDigest = fingerprint(selections.sort((a, b) => a.id.localeCompare(b.id)))
  let resolvedDigest: string | undefined
  const checkDefault = () => {
    if (defaultModel && fingerprint(model(host.currentSelection())) !== fingerprint(defaultModel)) throw new ConfigurationMismatch('configuration_mismatch')
  }
  return { verify: async () => {
    try {
      signal.throwIfAborted(); checkDefault()
      const resolved: { route: string; config: unknown }[] = []
      for (const [route, value] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
        const config = await probe(host.llm, value, signal)
        resolved.push({ route, config }); checkDefault()
      }
      const digest = fingerprint(resolved)
      if (resolvedDigest && digest !== resolvedDigest) throw new ConfigurationMismatch('configuration_mismatch')
      resolvedDigest = digest; signal.throwIfAborted()
      return { routes: routes.size, sessions: count, selections: selectionsDigest, resolved: digest }
    } catch (error) {
      if (error instanceof ConfigurationMismatch) throw error
      // Provider diagnostics may contain headers, keys, URLs or response bodies. None enter recovery receipts or logs.
      throw new ConfigurationMismatch('configuration_unavailable')
    }
  } }
}

/** A one-shot, tool-free, history-free probe; timeout also bounds adapters that fail to cooperate with cancellation. */
async function probe(llm: RecoveryInferenceHost['llm'], route: RoleModel, parent: AbortSignal): Promise<unknown> {
  const abort = new AbortController(), signal = AbortSignal.any([parent, abort.signal, AbortSignal.timeout(30_000)])
  let rejectAbort: () => void = () => {}
  const canceled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new ConfigurationMismatch('configuration_unavailable')); signal.addEventListener('abort', rejectAbort, { once: true }) })
  const operation = async () => {
    signal.throwIfAborted()
    const call = await llm.prepareCall({ provider: route.provider, model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } : {}), maxTokens: 64 }, signal)
    if (call.config.provider !== route.provider || call.config.model !== route.model || call.config.maxTokens !== 64) throw new ConfigurationMismatch('configuration_mismatch')
    let finished = false, content = false, chunks = 0, characters = 0
    for await (const chunk of call.stream({ ...call.config, signal, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply OK.' }] }] })) {
      signal.throwIfAborted()
      if (finished || ++chunks > 4096) throw new ConfigurationMismatch('configuration_unavailable')
      if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call'
        || chunk.type === 'block-end' && chunk.block.type === 'tool-call') throw new ConfigurationMismatch('configuration_unavailable')
      const text = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? chunk.text
        : chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning') ? chunk.block.text : undefined
      if (text !== undefined) {
        characters += text.length; content ||= text.trim().length > 0
        if (characters > 262144) throw new ConfigurationMismatch('configuration_unavailable')
      }
      if (chunk.type === 'finish') {
        if (!['stop', 'max-tokens'].includes(chunk.reason.kind) || !content) throw new ConfigurationMismatch('configuration_unavailable')
        finished = true
      }
    }
    if (!finished) throw new ConfigurationMismatch('configuration_unavailable')
    return { config: call.config, adapterDefaults: call.adapterDefaults }
  }
  try { return await Promise.race([operation(), canceled]) }
  finally { signal.removeEventListener('abort', rejectAbort); abort.abort() }
}
