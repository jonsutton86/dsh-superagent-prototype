/** Loopback listener with same-origin enforcement and optional authenticated Tailscale ingress. */
import { readTrustedOrigin } from '../security/trusted-origin.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Supervision } from '../supervision/service.ts'
import { InterventionSchema } from '../supervision/protocol.ts'
import { SupervisionSnapshotError } from '../supervision/service.ts'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { briefing } from './views/briefing.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import type { Workspace } from '../workspace/service.ts'
import type { Schedules } from '../workspace/schedules.ts'
import type { Reflections } from '../workspace/reflection.ts'
import type { Usage } from '../usage/service.ts'
import type { Speculation } from '../speculation/service.ts'
import { UsageScope, UsageError } from '../usage/model.ts'
import { WorkspaceError } from '../workspace/model.ts'
import type { Library } from '../workspace/library.ts'
import type { Inbox } from '../workspace/inbox.ts'
import type { Environments } from '../environments/service.ts'
import { EnvironmentError } from '../environments/model.ts'
import { RemoteError } from '../remote/protocol.ts'
import type { RemoteWorld } from '../remote/world.ts'
import type { Endpoints } from '../environments/endpoints.ts'
import type { Personas } from '../personas/service.ts'
import type { WorldPool } from '../environments/pool.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import { OwnershipError } from '../ownership/protocol.ts'
import type { Publications } from '../publication/runtime.ts'
import type { RepositoryExports } from '../publication/repository-exports.ts'
import type { RepositoryPublications } from '../publication/repository-runtime.ts'
import { PublicationError } from '../publication/protocol.ts'
import type { ChannelPublications } from '../publication/channels.ts'
import type { ConversationInbox } from '../publication/inbound.ts'
import type { Verification } from '../verification/service.ts'
import type { VerificationReviews } from '../verification/reviews.ts'
import { CheckCommandId } from '../verification/contracts.ts'
import type { Voice } from '../voice/service.ts'
import { VoiceError } from '../voice/model.ts'
import type { Attachments } from '../attachments/service.ts'
import { UploadError, UPLOAD_LIMITS } from '../attachments/model.ts'
import type { ExecutorStops } from '../executor/stops.ts'
import { EmergencyRequest, type Emergency } from './emergency.ts'
import type { Access, Capability } from '../security/access.ts'
import type { AuditLog } from '../security/audit.ts'
import { CREDENTIAL_NAME, type CredentialVault } from '../security/credentials.ts'
import type { ProviderRegistry } from '../security/providers.ts'
import { TaskKind } from '../security/model-routing.ts'
import { budgetFrom } from '../usage/service.ts'
import { MEMORY_KINDS, MemoryAccess, MemoryError, MemoryInputSchema, parseScopeKey, type Memory } from '../memory/service.ts'
import { ImportInputSchema, importMemory } from '../memory/import.ts'

export interface HttpHost {
  readonly voice?: Voice
  readonly attachments?: Attachments
  readonly ownership?: Pick<CoordinatorOwnership, 'status'>
  readonly publications?: Publications
  readonly repositoryExports?: RepositoryExports
  readonly repositoryPublications?: RepositoryPublications
  readonly channelPublications?: ChannelPublications
  readonly conversations?: ConversationInbox
  authorizeMutation?(): void
  readonly remoteRoot?: string
  readonly remoteEffects?: Pick<RemoteWorld, 'effects' | 'refreshEffects' | 'cancelEffect' | 'status'>
  readonly environments: Environments
  readonly endpoints: Pick<Endpoints, 'list' | 'register' | 'catalog' | 'commands' | 'submit' | 'retry' | 'profile'>
  readonly personas: Pick<Personas, 'list' | 'get' | 'version' | 'create' | 'update' | 'archive'>
  readonly worlds: Pick<WorldPool, 'list' | 'activate' | 'refresh' | 'revoke' | 'lookup'>
  readonly inbox: Inbox
  readonly library: Library
  readonly verification?: Verification
  readonly verificationReviews?: VerificationReviews
  readonly workspace: Workspace
  readonly schedules?: Schedules
  readonly reflections?: Reflections
  readonly usage?: Usage
  readonly speculation?: Speculation
  readonly supervision?: Supervision
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'> & { stops?: Pick<ExecutorStops, 'list' | 'detail' | 'recheck' | 'attest' | 'attestation' | 'attestations'> }
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly emergency?: Pick<Emergency, 'state' | 'engage' | 'release'>
  readonly access?: Access
  readonly audit?: Pick<AuditLog, 'append' | 'list'>
  readonly credentials?: Pick<CredentialVault, 'list' | 'set' | 'delete'>
  readonly providers?: Pick<ProviderRegistry, 'view' | 'route'>
  readonly memory?: Memory
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number, trustedOrigin?: string): boolean {
  const host = req.headers.host
  if (trustedOrigin && host === trustedOrigin.slice('https://'.length)) {
    // Browsers may omit Origin on same-origin GET/HEAD. Fetch Metadata supplies that provenance.
    return req.headers['x-orchestrator-request'] === '1'
      && (req.headers.origin === trustedOrigin || req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'same-origin')
  }
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof MemoryError) return [error.status, { error: error.message }]
  if (error instanceof SupervisionSnapshotError) return [error.status, { error: error.code }]
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof WorkspaceError) return [error.status, { error: error.message }]
  if (error instanceof VoiceError) return [error.status, { error: error.message }]
  if (error instanceof UploadError) return [error.status, { error: error.message }]
  if (error instanceof UsageError) return [error.status, { error: error.message }]
  if (error instanceof EnvironmentError) return [error.status, { error: error.message }]
  if (error instanceof RemoteError || error instanceof OwnershipError || error instanceof PublicationError) return [error.status, { error: error.message, code: error.code }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return { executionMode: runtime.machine.executionMode ?? 'repository',
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository ?? null, agent: resolved.github?.login ?? null, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, emergency: runtime.emergency?.state() ?? null, access: runtime.access?.view() ?? null,
    environment: { ready: runtime.environments.ready() }, health: runtime.health,
    ...(runtime.ownership ? { ownership: runtime.ownership.status() } : {}) }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(runtime.machine.executionMode === 'local'), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const allow = (capability: Capability) => {
    if (!runtime.access || runtime.access.allows(capability)) return
    try { runtime.audit?.append({ actor: `admin:${runtime.access.role()}`, action: 'access.capability', resource: capability, outcome: 'denied' }) } catch { /* Response remains authoritative. */ }
    throw new RouteError(403, 'This administration role does not allow that action')
  }
  const stops = () => { if (!runtime.executor?.stops) throw new WorkspaceError(409, 'Original stop recovery is unavailable'); return runtime.executor.stops }
  const originalStop = (params: { id: string; assignment: string; stop: string }) => {
    const current = stops().detail(params.stop)
    if (current.ticketId !== params.id || current.assignmentId !== params.assignment) throw new RouteError(404, 'Original stop target not found')
    return current
  }
  const stopPage = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict()
  const usage = () => { if (!runtime.usage) throw new UsageError(409, 'Model accounting is unavailable'); return runtime.usage }
  const schedules = () => { if (!runtime.schedules) throw new WorkspaceError(409, 'Schedules are unavailable'); return runtime.schedules }
  const reflections = () => { if (!runtime.reflections) throw new WorkspaceError(409, 'Reflection is unavailable'); return runtime.reflections }
  const speculation = () => { if (!runtime.speculation) throw new WorkspaceError(409, 'Speculation is unavailable'); return runtime.speculation }
  const verification = () => { if (!runtime.verification) throw new WorkspaceError(409, 'Verification is unavailable'); return runtime.verification }
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const execution = (id?: string, binding?: string) => {
    if (id !== undefined) ticket(id)
    const selected = binding ?? (id ? store.tickets.get(id)?.execution?.environment?.world : undefined)
    const world = selected ? runtime.worlds.lookup(selected)?.world ?? (runtime.remoteEffects?.status().binding === selected ? runtime.remoteEffects : undefined) : runtime.remoteEffects
    if (!world || id !== undefined && store.tickets.get(id)?.execution?.environment?.world !== world.status().binding)
      throw new RemoteError(409, 'world_mismatch', 'This task is not bound to the current remote execution world')
    return world
  }
  const receiptPage = (id: string | undefined, query: Record<string, string> = {}, binding?: string) => {
    const world = execution(id, binding)
    return { ...world.effects(id, offset.parse(query.offset), limit(20, 100).parse(query.limit)), blocked: world.status().effectsBlocked }
  }
  const refreshReceipts = async (id?: string, binding?: string) => { await execution(id, binding).refreshEffects(); return receiptPage(id, {}, binding) }
  const cancelReceipt = async (id: string | undefined, effect: string, body: unknown, binding?: string) => {
    const request = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict().parse(body)
    await execution(id, binding).cancelEffect(id, effect, request.requestId)
    return receiptPage(id, {}, binding)
  }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  const publications = () => {
    if (!runtime.publications) throw new PublicationError(409, 'not_configured', 'Publication service is unavailable')
    return runtime.publications
  }
  const channelPublications = () => {
    if (!runtime.channelPublications) throw new PublicationError(409, 'not_configured', 'Channel publication is unavailable')
    return runtime.channelPublications
  }
  const conversations = () => {
    if (!runtime.conversations) throw new PublicationError(409, 'not_configured', 'Conversation listeners are unavailable')
    return runtime.conversations
  }
  const repositoryExports = () => {
    if (!runtime.repositoryExports) throw new WorkspaceError(409, 'Repository export is unavailable')
    return runtime.repositoryExports
  }
  const repositoryPublications = () => {
    if (!runtime.repositoryPublications) throw new WorkspaceError(409, 'Repository publication is unavailable')
    return runtime.repositoryPublications
  }
  return {
    'GET repository-publication/destinations': () => runtime.repositoryPublications?.destinations() ?? { configured: false, items: [] },
    'GET repository-exports/:id/publications': ({ params }) => repositoryPublications().list(params.id),
    'POST repository-exports/:id/publications': async ({ params, body }) => repositoryPublications().prepare(params.id, await body()),
    'GET repository-publications/:id': ({ params }) => repositoryPublications().get(params.id),
    'POST repository-publications/:id/retry': ({ params }) => repositoryPublications().retry(params.id),
    'POST repository-publications/:id/publish': async ({ params, body }) => repositoryPublications().publish(params.id, await body()),
    'POST repository-publications/:id/refresh': ({ params }) => repositoryPublications().refresh(params.id),
    'POST repository-publications/:id/cancel': ({ params }) => repositoryPublications().cancel(params.id),
    'GET library/:id/repository-exports': ({ params }) => repositoryExports().list(params.id),
    'POST library/:id/repository-exports': async ({ params, body }) => repositoryExports().prepare(params.id, await body()),
    'GET repository-exports/:id': ({ params }) => repositoryExports().get(params.id),
    'POST repository-exports/:id/retry': ({ params }) => repositoryExports().retry(params.id),
    'POST repository-exports/:id/cancel': ({ params }) => repositoryExports().cancel(params.id),
    'GET recall': ({ query }) => runtime.library.recall.state(offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'PUT recall': async ({ body }) => runtime.library.recall.configure(await body()),
    'GET recall/versions/:version': ({ params }) => runtime.library.recall.configuration(z.coerce.number().int().nonnegative().parse(params.version)),
    'GET usage': ({ query }) => usage().page(UsageScope.parse({ kind: query.scope ?? 'workspace', ...(query.subject ? { id: query.subject } : {}) }),
      query.from === undefined ? undefined : new Date(z.iso.datetime({ offset: true }).parse(query.from)).toISOString(), offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'PUT usage': async ({ body }) => usage().configure(await body(256 * 1024)),
    'GET usage/versions/:version': ({ params }) => usage().configuration(z.coerce.number().int().nonnegative().parse(params.version)),
    'POST usage/calls/:id/reconcile': async ({ params, body }) => usage().reconcile(params.id, await body()),
    'GET missions/:id/inbound': ({ params }) => conversations().state(params.id),
    'PUT missions/:id/inbound': async ({ params, body }) => conversations().configure(params.id, await body()),
    'POST missions/:id/inbound/poll': async ({ params, body }) => conversations().poll(params.id, z.object({ rescan: z.boolean().default(false) }).strict().parse(await body()).rescan),
    'GET missions/:id/delivery': ({ params }) => channelPublications().state(params.id),
    'PUT missions/:id/delivery': async ({ params, body }) => channelPublications().configure(params.id, await body()),
    'POST deliveries/:id/refresh': ({ params }) => channelPublications().refresh(params.id),
    'POST deliveries/:id/retry': ({ params }) => channelPublications().retry(params.id),
    'GET publication/destinations': () => runtime.publications?.destinations() ?? { configured: false, items: [] },
    'GET publication/destinations/:id/pull': ({ params, query }) => publications().inspectPull(params.id, z.string().regex(/^[a-f0-9]{64}$/).parse(query.hash)),
    'GET library/:id/publications': ({ params }) => publications().list(params.id),
    'POST library/:id/publications': async ({ params, body }) => publications().publish(params.id, await body()),
    'POST publications/:id/refresh': ({ params }) => publications().refresh(params.id),
    'POST publications/:id/retry': ({ params }) => publications().retry(params.id),
    'GET execution': ({ query }) => receiptPage(undefined, query),
    'POST execution/refresh': () => refreshReceipts(),
    'POST execution/:effect/cancel': async ({ params, body }) => cancelReceipt(undefined, params.effect, await body()),
    'GET tickets/:id/execution': ({ params, query }) => receiptPage(params.id, query),
    'POST tickets/:id/execution/refresh': ({ params }) => refreshReceipts(params.id),
    'POST tickets/:id/execution/:effect/cancel': async ({ params, body }) => cancelReceipt(params.id, params.effect, await body()),
    'GET environments': () => runtime.environments.list(),
    'GET worlds': ({ query }) => runtime.worlds.list(query),
    'GET worlds/:id/execution': ({ params, query }) => receiptPage(undefined, query, params.id),
    'POST worlds/:id/execution/refresh': ({ params }) => refreshReceipts(undefined, params.id),
    'POST worlds/:id/execution/:effect/cancel': async ({ params, body }) => cancelReceipt(undefined, params.effect, await body(), params.id),
    'POST worlds': async ({ body }) => runtime.worlds.activate(await body()),
    'POST worlds/:id/refresh': ({ params }) => runtime.worlds.refresh(params.id),
    'POST worlds/:id/revoke': async ({ params, body }) => runtime.worlds.revoke(params.id, await body()),
    'GET personas': ({ query }) => runtime.personas.list(query),
    'GET personas/:id': ({ params }) => runtime.personas.get(params.id),
    'GET personas/:id/versions/:version': ({ params }) => runtime.personas.version(params.id, z.coerce.number().int().positive().parse(params.version)),
    'POST personas': async ({ body }) => runtime.personas.create(await body()),
    'PUT personas/:id': async ({ params, body }) => runtime.personas.update(params.id, await body()),
    'POST personas/:id/archive': async ({ params, body }) => runtime.personas.archive(params.id, await body()),
    'GET endpoints': ({ query }) => runtime.endpoints.list(query),
    'POST endpoints': async ({ body }) => runtime.endpoints.register(await body()),
    'GET endpoints/:id/catalog': ({ params, query }) => runtime.endpoints.catalog(params.id, query),
    'GET endpoints/:id/commands': ({ params, query }) => runtime.endpoints.commands(params.id, query),
    'POST endpoints/:id/commands': async ({ params, body }) => runtime.endpoints.submit(params.id, await body()),
    'POST endpoints/:id/commands/:command/retry': ({ params }) => runtime.endpoints.retry(params.id, params.command),
    'POST endpoints/:id/commands/:command/profile': async ({ params, body }) => runtime.endpoints.profile(params.id, params.command, await body()),
    'POST environments': async ({ body }) => runtime.environments.enroll(await body()),
    'PUT environments/:id': async ({ params, body }) => runtime.environments.update(params.id, await body()),
    'GET uploads': () => runtime.attachments?.capabilities() ?? { available: false, fileBytes: UPLOAD_LIMITS.fileBytes, chunkBytes: UPLOAD_LIMITS.chunkBytes, perMessage: UPLOAD_LIMITS.perMessage, messageBytes: UPLOAD_LIMITS.messageBytes },
    'POST uploads': async ({ body }) => { if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable'); return runtime.attachments.begin(await body()) },
    'GET uploads/:id': ({ params }) => { if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable'); return runtime.attachments.get(params.id) },
    'POST uploads/:id/chunks': async ({ params, body }) => { if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable'); return runtime.attachments.chunk(params.id, await body(512 * 1024)) },
    'POST uploads/:id/finish': ({ params }) => { if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable'); return runtime.attachments.finish(params.id) },
    'POST uploads/:id/cancel': ({ params }) => { if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable'); return runtime.attachments.cancel(params.id) },
    'GET voice': () => runtime.voice?.capabilities() ?? { input: null, output: null, recordingMs: 30000, inputBytes: 2097152, textChars: 2000, active: 0 },
    'POST voice/transcribe': async ({ body }) => { if (!runtime.voice) throw new VoiceError(503, 'Speech is unavailable'); return runtime.voice.transcribe(await body(3 * 1024 * 1024)) },
    'POST voice/speak': async ({ body }) => { if (!runtime.voice) throw new VoiceError(503, 'Speech is unavailable'); return runtime.voice.speak(await body()) },
    'GET voice/:id': ({ params }) => { if (!runtime.voice) throw new VoiceError(503, 'Speech is unavailable'); return runtime.voice.get(params.id) },
    'POST voice/:id/cancel': ({ params }) => { if (!runtime.voice) throw new VoiceError(503, 'Speech is unavailable'); return runtime.voice.cancel(params.id) },
    'GET inbox': ({ query }) => runtime.inbox.list(query),
    'GET inbox/setup': () => runtime.inbox.setup(),
    'POST inbox': async ({ body }) => runtime.inbox.start(await body()),
    'GET inbox/:id': ({ params, query }) => runtime.inbox.conversation(params.id, query),
    'POST inbox/:id/read': async ({ params, body }) => runtime.inbox.read(params.id, await body()),
    'POST inbox/:id/reply': async ({ params, body }) => runtime.inbox.reply(params.id, await body()),
    'GET library': ({ query }) => runtime.library.list(query),
    'POST library': async ({ body }) => runtime.library.publish(await body(1024 * 1024)),
    'GET library/:id': ({ params, query }) => runtime.library.read(params.id, query),
    'GET library/:id/content': ({ params }) => runtime.library.content(params.id),
    'GET checks': ({ query }) => verification().definitions.list(offset.parse(query.offset)),
    'POST checks': async ({ body }) => verification().definitions.create(await body()),
    'GET checks/:id': ({ params }) => verification().definitions.get(params.id),
    'PUT checks/:id': async ({ params, body }) => verification().definitions.update(params.id, await body()),
    'POST checks/:id/authority': async ({ params, body }) => verification().definitions.configure(params.id, await body()),
    'GET checks/:id/versions/:version': ({ params }) => verification().definitions.version(params.id, z.coerce.number().int().positive().parse(params.version)),
    'GET library/:id/checks': ({ params, query }) => verification().choices(params.id, offset.parse(query.offset)),
    'GET library/:id/review-checks': ({ params, query }) => verification().reviewChoices(params.id, offset.parse(query.offset)),
    'GET evidence-reviews/:id': ({ params }) => {
      if (!runtime.verificationReviews) throw new WorkspaceError(409, 'Evidence reviews are unavailable')
      return runtime.verificationReviews.get(params.id)
    },
    'GET library/:id/verification': ({ params, query }) => verification().list(params.id, offset.parse(query.offset)),
    'POST library/:id/verification': async ({ params, body }) => verification().request(params.id, await body()),
    'GET verification/:id': ({ params }) => verification().get(params.id),
    'GET verification/:id/output': ({ params, query }) => verification().output(params.id, query),
    'POST verification/:id/refresh': ({ params }) => verification().refresh(params.id),
    'POST verification/:id/cancel': async ({ params, body }) => verification().cancel(params.id, await body()),
    'POST verification/:id/reconcile': async ({ params, body }) => verification().reconcile(params.id, await body()),
    'POST verification/:id/freshness': async ({ params, body }) => verification().freshness(params.id,
      z.object({ requestId: CheckCommandId }).strict().parse(await body()).requestId),
    'PUT library/:id': async ({ params, body }) => runtime.library.archive(params.id, await body()),
    'GET schedules': ({ query }) => schedules().list(offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'GET speculation': ({ query }) => speculation().page(offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'PUT speculation': async ({ body }) => speculation().configure(await body()),
    'GET speculation/versions/:version': ({ params }) => speculation().configuration(z.coerce.number().int().nonnegative().parse(params.version)),
    'GET speculation/:id': ({ params }) => speculation().get(params.id),
    'POST speculation/:id/review': async ({ params, body }) => speculation().review(params.id, await body()),
    'POST speculation/:id/messages': async ({ params, body }) => speculation().approveMessage(params.id, await body()),
    'GET reflections': ({ query }) => reflections().list(offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'GET reflections/:id': ({ params }) => reflections().get(params.id),
    'POST reflections/:id/proposals/:proposal/review': async ({ params, body }) => reflections().review(params.id, params.proposal, await body()),
    'GET schedules/:id': ({ params, query }) => schedules().get(params.id, offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'GET schedules/:id/versions/:version': ({ params }) => schedules().version(params.id, z.coerce.number().int().positive().parse(params.version)),
    'POST schedules': async ({ body }) => schedules().create(await body(512 * 1024 + 8192)),
    'PUT schedules/:id': async ({ params, body }) => schedules().update(params.id, await body(512 * 1024 + 8192)),
    'POST schedules/:id/enabled': async ({ params, body }) => schedules().toggle(params.id, await body()),
    'POST schedules/:id/occurrences/:occurrence/retry': async ({ params, body }) => schedules().retry(params.id, params.occurrence, await body()),
    'GET missions': ({ query }) => runtime.workspace.list(offset.parse(query.offset), limit(30, 100).parse(query.limit)),
    'GET missions/:id': ({ params }) => runtime.workspace.get(params.id),
    'GET missions/:id/plans': ({ params, query }) => runtime.workspace.plans.list(params.id, offset.parse(query.offset), limit(20, 50).parse(query.limit)),
    'GET missions/:id/plans/:version': ({ params }) => runtime.workspace.plans.version(params.id, z.coerce.number().int().positive().parse(params.version)),
    'GET missions/:id/proposals/:proposal': ({ params }) => runtime.workspace.plans.proposal(params.id, params.proposal),
    'POST missions/:id/proposals': async ({ params, body }) => runtime.workspace.plans.propose(params.id, await body(512 * 1024 + 8192)),
    'POST missions/:id/proposals/:proposal': async ({ params, body }) => runtime.workspace.plans.review(params.id, params.proposal, await body()),
    'POST missions/:id/plan-request': async ({ params, body }) => runtime.workspace.plans.request(params.id, await body()),
    'POST missions': async ({ body }) => runtime.workspace.create(await body()),
    'POST missions/:id/actions': async ({ params, body }) => runtime.workspace.add(params.id, await body()),
    'POST missions/:id/actions/:action': async ({ params, body }) => runtime.workspace.actReviewed(params.id, params.action, await body()),
    'PUT missions/:id': async ({ params, body }) => runtime.workspace.updateReviewed(params.id, await body()),
    'PUT missions/:id/actions/:action/pull': async ({ params, body }) => runtime.workspace.configurePull(params.id, params.action, await body()),
    'POST missions/:id/actions/:action/pull/inspect': ({ params }) => runtime.workspace.inspectPull(params.id, params.action),
    'GET missions/:id/completions': ({ params }) => { runtime.workspace.get(params.id, false); return runtime.workspace.completions.list(params.id) },
    'POST mission-completions/:id/retry': ({ params }) => runtime.workspace.retryCompletion(params.id),
    'GET mission-pull-targets/:id': ({ params }) => {
      if (!runtime.workspace.pulls) throw new WorkspaceError(409, 'Mission PR targets are unavailable')
      return runtime.workspace.pulls.state(params.id)
    },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET briefing': () => briefing(overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem), runtime.schedules),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir, runtime.remoteRoot),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'GET tickets/:id/stops': ({ params, query }) => { ticket(params.id); const page = stopPage.parse(query); return stops().list(params.id, page.cursor, page.limit) },
    'GET tickets/:id/assignments/:assignment/stops/:stop': ({ params }) => originalStop(params),
    'POST tickets/:id/assignments/:assignment/stops/:stop/recheck': async ({ params, body }) => {
      originalStop(params)
      const request = z.object({ expectedRevision: z.number().int().positive(), executionBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
        scopeHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await body(4096))
      return { observationRequested: true as const, current: await stops().recheck(params.stop, request) }
    },
    'POST tickets/:id/assignments/:assignment/stops/:stop/attest': async ({ params, body }) => {
      originalStop(params); return stops().attest(params.stop, await body(16384))
    },
    'GET tickets/:id/assignments/:assignment/stops/:stop/attestations': ({ params, query }) => {
      originalStop(params); const page = stopPage.parse(query); return stops().attestations(params.stop, page.cursor, page.limit)
    },
    'GET tickets/:id/assignments/:assignment/stops/:stop/attestations/:request': ({ params }) => {
      const current = originalStop(params)
      return { receipt: stops().attestation(params.stop, params.request), current }
    },
    'POST tickets/:id/retry': ({ params }) => { allow('tasks:write'); const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { allow('tasks:write'); const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => { allow('runtime:operate'); return runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel') },
    'GET memory/search': ({ query }) => {
      allow('memory:read')
      const parsed = z.object({ q: z.string().trim().max(200).optional(), scope: z.string().trim().max(120).optional(),
        kinds: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().trim().max(300).optional() }).strict().parse(query)
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const kinds = parsed.kinds ? parsed.kinds.split(',').map(kind => kind.trim()).filter(Boolean) : undefined
      if (kinds?.some(kind => !(MEMORY_KINDS as readonly string[]).includes(kind))) throw new RouteError(400, 'Unknown memory kind')
      const scope = parsed.scope ? parseScopeKey(parsed.scope) : undefined
      return runtime.memory.search(MemoryAccess.owner(), { ...(parsed.q ? { q: parsed.q } : {}), ...(scope ? { scope } : {}),
        ...(kinds ? { kinds: kinds as never } : {}), limit: parsed.limit, ...(parsed.cursor ? { cursor: parsed.cursor } : {}) })
    },
    'POST memory': async ({ body }) => {
      allow('memory:write')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const input = MemoryInputSchema.parse(await body(64 * 1024))
      return runtime.memory.save(MemoryAccess.owner(), input, 'operator')
    },
    'GET tickets/:id/memory-grants': ({ params }) => {
      allow('memory:read')
      ticket(params.id)
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      return { scopes: runtime.memory.grants(params.id) }
    },
    'PUT tickets/:id/memory-grants': async ({ params, body }) => {
      allow('memory:write')
      ticket(params.id)
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const request = z.object({ requestId: z.string().trim().min(1).max(200),
        scopes: z.array(z.string().trim().min(1).max(120)).max(20) }).strict().parse(await body(16 * 1024))
      const scopes = runtime.memory.setGrants(MemoryAccess.owner(), params.id, request.scopes, 'operator')
      return { scopes }
    },
    'GET memory/profiles': () => {
      allow('memory:read')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      return { personal: runtime.memory.profile(MemoryAccess.owner(), 'personal') ?? null,
        business: runtime.memory.profile(MemoryAccess.owner(), 'business') ?? null }
    },
    'PUT memory/profiles/:type': async ({ params, body }) => {
      allow('memory:write')
      const type = z.enum(['personal', 'business']).parse(params.type)
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const request = z.object({ requestId: z.string().trim().min(1).max(200), content: z.string().trim().min(1).max(20_000),
        summary: z.string().trim().max(1000).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]) }).strict().parse(await body(32 * 1024))
      return runtime.memory.saveProfile(MemoryAccess.owner(), type, { content: request.content,
        ...(request.summary ? { summary: request.summary } : {}), tags: request.tags }, 'operator')
    },
    'POST memory/consolidate': async ({ body }) => {
      allow('memory:write')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const request = z.object({ requestId: z.string().trim().min(1).max(200), sessionId: z.string().trim().min(1).max(200),
        maxChars: z.number().int().min(200).max(4000).optional() }).strict().parse(await body(16 * 1024))
      return runtime.memory.summarizeConversations(MemoryAccess.owner(), request.sessionId, request.maxChars ?? 800)
    },
    'POST memory/import': async ({ body }) => {
      allow('memory:write')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      return importMemory(runtime.memory, MemoryAccess.owner(), ImportInputSchema.parse(await body(1_100_000)), 'operator')
    },
    'GET memory/:id': ({ params }) => {
      allow('memory:read')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      const record = runtime.memory.get(MemoryAccess.owner(), params.id)
      if (!record) throw new RouteError(404, 'Memory record not found')
      return { record, events: runtime.memory.events(MemoryAccess.owner(), params.id) }
    },
    'DELETE memory/:id': ({ params }) => {
      allow('memory:write')
      if (!runtime.memory) throw new RouteError(409, 'Memory is unavailable')
      return { deleted: runtime.memory.delete(MemoryAccess.owner(), params.id, 'operator') }
    },
    'GET credentials': () => {
      allow('secrets:read')
      return { items: runtime.credentials?.list() ?? [] }
    },
    'POST credentials/:name': async ({ params, body }) => {
      allow('secrets:write')
      if (!CREDENTIAL_NAME.test(params.name)) throw new RouteError(400, 'Invalid credential name')
      const request = z.object({ requestId: z.string().trim().min(1).max(200), value: z.string().min(1).max(16 * 1024) }).strict().parse(await body(32 * 1024))
      if (!runtime.credentials) throw new RouteError(409, 'Credential storage is unavailable')
      const stored = runtime.credentials.set(params.name, request.value)
      runtime.audit?.append({ actor: 'operator', action: 'credential.write', resource: params.name, outcome: 'completed', detail: { bytes: stored.bytes } })
      return stored
    },
    'DELETE credentials/:name': ({ params }) => {
      allow('secrets:write')
      if (!CREDENTIAL_NAME.test(params.name)) throw new RouteError(400, 'Invalid credential name')
      if (!runtime.credentials) throw new RouteError(409, 'Credential storage is unavailable')
      const deleted = runtime.credentials.delete(params.name)
      runtime.audit?.append({ actor: 'operator', action: 'credential.delete', resource: params.name, outcome: deleted ? 'completed' : 'failed' })
      return { deleted }
    },
    'GET providers': () => {
      allow('runtime:read')
      return { items: runtime.providers?.view() ?? [], verified: false }
    },
    'GET model-route': ({ query }) => {
      allow('runtime:read')
      const task = TaskKind.safeParse(query.task)
      if (!task.success) throw new RouteError(400, 'Invalid task kind')
      let ceiling: number | undefined
      if (query.monthlyBudgetUsd !== undefined) {
        ceiling = Number(query.monthlyBudgetUsd)
        if (!Number.isFinite(ceiling) || ceiling < 0) throw new RouteError(400, 'Invalid monthly budget ceiling')
      }
      if (!runtime.providers) throw new RouteError(409, 'Provider routing is unavailable')
      const spentUsd: Record<string, number> = {}
      if (runtime.usage) {
        const from = budgetFrom('month', Date.now())
        for (const provider of runtime.providers.view()) {
          const totals = runtime.usage.providerSpend(provider.id, from)
          spentUsd[provider.id] = totals.unknownCost > 0
            ? Number.POSITIVE_INFINITY
            : (totals.cost + totals.reservedCost) / 1_000_000
        }
      }
      const result = runtime.providers.route(task.data, { monthlyBudgetUsd: ceiling, spentUsd })
      if (!result.ok) return { ...result, verified: false }
      return {
        ok: true,
        task: result.task,
        candidates: result.candidates.map(candidate => ({
          provider: candidate.provider.id,
          model: candidate.model,
          monthlyBudgetUsd: candidate.monthlyBudgetUsd
        })),
        verified: false
      }
    },
    'GET audit': ({ query }) => {
      allow('audit:read')
      const limit = Number(query.limit ?? 50), cursor = query.cursor === undefined ? undefined : Number(query.cursor)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RouteError(400, 'Invalid audit page')
      if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new RouteError(400, 'Invalid audit page')
      return runtime.audit?.list(limit, cursor) ?? { items: [], nextCursor: null }
    },
    'GET emergency': () => {
      const emergency = runtime.emergency
      if (!emergency) throw new RouteError(409, 'Emergency control is unavailable')
      return emergency.state()
    },
    'POST emergency': async ({ body }) => {
      allow('runtime:operate')
      const emergency = runtime.emergency
      if (!emergency) throw new RouteError(409, 'Emergency control is unavailable')
      const request = EmergencyRequest.parse(await body(16_384))
      return request.action === 'engage' ? await emergency.engage(request) : await emergency.release(request)
    },
    'PUT settings/:block': async ({ params, body }) => {
      allow('settings:write')
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
/** Serve stored speech with byte-range support so media elements can stream and seek. */
function speechAudioResponse(req: IncomingMessage, res: ServerResponse, audio: Buffer): void {
  const range = req.headers.range
  const common = { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes' }
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (!match) { res.writeHead(200, { ...common, 'content-length': audio.length }); res.end(audio); return }
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Math.min(Number(match[2]), audio.length - 1) : audio.length - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= audio.length) {
    res.writeHead(416, { ...common, 'content-range': `bytes */${audio.length}` }); res.end(); return
  }
  res.writeHead(206, { ...common, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${audio.length}` })
  res.end(audio.subarray(start, end + 1))
}

export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const trustedOrigin = readTrustedOrigin()
  if (trustedOrigin && !runtime.access?.required()) throw new Error('Tailscale ingress requires configured administration bearer authentication')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      // A media element cannot attach the management header, so a short-lived capability token authorizes only audio bytes.
      const media = /^\/orchestrator\/api\/voice\/([0-9a-f-]{36})\/audio$/.exec(url.pathname)
      if (req.method === 'GET' && media && url.searchParams.get('token')) {
        const host = req.headers.host
        if (host !== `127.0.0.1:${ctx.webServer.port}` && host !== `localhost:${ctx.webServer.port}`) { res.writeHead(403); res.end(); return }
        if (!runtime.voice?.authorizeAudio(media[1]!, url.searchParams.get('token') ?? undefined)) { res.writeHead(403); res.end(); return }
        speechAudioResponse(req, res, runtime.voice.audio(media[1]!)); return
      }
      if (!sameOrigin(req, ctx.webServer.port, trustedOrigin)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      const remote = trustedOrigin !== undefined && req.headers.host === trustedOrigin.slice('https://'.length)
      // Even supervision requires the administration boundary through the remote ingress.
      // Its separate watchdog credential is still required below; neither credential replaces the other.
      // Independent supervision keeps its own bearer authentication and must stay observable during startup.
      const supervisionPath = url.pathname === '/orchestrator/api/supervision' || url.pathname.startsWith('/orchestrator/api/supervision/')
      if ((!supervisionPath || remote) && runtime.access) {
        const authenticated = runtime.access.authenticate(req.headers.authorization)
        if (!authenticated.ok) {
          try { runtime.audit?.append({ actor: 'unauthenticated', action: 'access.authenticate', resource: url.pathname, outcome: 'denied', detail: { reason: authenticated.reason } }) } catch { /* Response remains authoritative. */ }
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'www-authenticate': 'Bearer' })
          res.end(JSON.stringify({ error: 'Administration authentication required' })); return
        }
      }
      try {
        // Receipt refresh writes observations locally but never sends an execution or cancellation intent.
        const observation = req.method === 'POST' && /^\/orchestrator\/api\/(?:execution|tickets\/[^/]+\/execution|worlds\/[^/]+\/execution|publications\/[^/]+|repository-publications\/[^/]+|deliveries\/[^/]+|verification\/[^/]+)\/refresh$/.test(url.pathname)
        const mutation = req.method !== 'GET' && req.method !== 'HEAD' && !observation
        if (mutation) runtime.authorizeMutation?.()
        if (runtime.ownership && req.method === 'GET' && url.pathname === '/orchestrator/api/state') {
          json(res, 200, stateView(runtime)); return
        }
        // Independent supervision must remain observable even while normal startup has not finished.
        if (url.pathname === '/orchestrator/api/supervision' || url.pathname.startsWith('/orchestrator/api/supervision/')) {
          const supervisor = runtime.supervision
          if (!supervisor?.authorized(req.headers.authorization)) { json(res, 403, { error: 'Watchdog authentication required' }); return }
          if (req.method === 'GET' && url.pathname === '/orchestrator/api/supervision') {
            json(res, 200, supervisor.snapshot(offset.parse(url.searchParams.get('offset') ?? 0), url.searchParams.get('version') ?? undefined)); return
          }
          if (req.method === 'POST' && url.pathname === '/orchestrator/api/supervision/intervene') {
            const input = InterventionSchema.parse(await readBody(req, 4096)); runtime.authorizeMutation?.()
            json(res, 200, supervisor.intervene(input)); return
          }
          throw new RouteError(404, 'Unknown supervision operation')
        }
        await runtime.ready
        if (mutation) runtime.authorizeMutation?.()
        const attachment = /^\/orchestrator\/api\/uploads\/([0-9a-f-]{36})\/(download|image)$/.exec(url.pathname)
        const repositoryBundle = /^\/orchestrator\/api\/repository-exports\/([0-9a-f-]{36})\/download$/.exec(url.pathname)
        if (req.method === 'GET' && repositoryBundle) {
          if (!runtime.repositoryExports) throw new WorkspaceError(409, 'Repository export is unavailable')
          const download = runtime.repositoryExports.download(repositoryBundle[1]!)
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': download.value.bundle!.bytes,
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="repository-${download.value.id}.bundle"` })
          await pipeline(Readable.from(download.chunks), res); return
        }
        if (req.method === 'GET' && attachment) {
          if (!runtime.attachments) throw new UploadError(503, 'Attachments unavailable')
          if (attachment[2] === 'image') {
            const image = await runtime.attachments.preview(attachment[1]!)
            res.writeHead(200, { 'content-type': image.mediaType, 'content-length': image.data.byteLength, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
            res.end(Buffer.from(image.data)); return
          }
          const download = runtime.attachments.download(attachment[1]!)
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': download.value.bytes, 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(Buffer.from(download.value.name).toString('utf8')).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())}` })
          await pipeline(Readable.from(download.chunks), res); return
        }
        const speechAudio = /^\/orchestrator\/api\/voice\/([0-9a-f-]{36})\/audio$/.exec(url.pathname)
        if (req.method === 'GET' && speechAudio) {
          if (!runtime.voice) throw new VoiceError(503, 'Speech is unavailable')
          speechAudioResponse(req, res, runtime.voice.audio(speechAudio[1]!)); return
        }
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: async maxBytes => {
          const input = await readBody(req, maxBytes); if (mutation) runtime.authorizeMutation?.(); return input
        } }))
      } catch (error) { if (res.headersSent) res.destroy(); else json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
