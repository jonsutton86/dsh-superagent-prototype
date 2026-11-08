/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { ActionCommandInput, AddActionInput, CreateMissionInput, MissionCommandInput, MissionList, MissionView } from '../workspace/model.ts'
import type { ArchiveRecordInput, CreateRecordInput, LibraryContent, LibraryEntry, LibraryList, LibraryQueryInput, LibraryRead } from '../workspace/library-model.ts'
import type { Conversation, InboxFilter, InboxItem, InboxPage, InboxReplyInput, InboxStartInput } from '../workspace/inbox-model.ts'
import type { PlanIndex, PlanProposal, PlanVersion, ProposePlanInput, ReviewPlanInput, RequestPlanInput } from '../workspace/plan-model.ts'
import type { EnvironmentList, EnvironmentView, EnrollEnvironmentInput, EnvironmentCommandInput } from '../environments/model.ts'
import type { ExecutionReceiptPage } from '../remote/effects.ts'
import type { ArchivePersonaInput, CreatePersonaInput, PersonaList, PersonaRecord, PersonaVersion, SavePersonaInput } from '../personas/model.ts'
import type { EndpointCatalog, EndpointCommandInput, EndpointList, EndpointRegistration, OperatorCommand, RegisterEndpointInput, RemoteProfileView } from '../environments/endpoint-model.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export const INBOX_FILTERS = ['all', 'unread', 'questions', 'review', 'working'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET personas': { query?: { offset?: number; q?: string; active?: 'true' | 'false' }; response: PersonaList }
  'GET personas/:id': { response: PersonaRecord }
  'GET personas/:id/versions/:version': { response: PersonaVersion }
  'POST personas': { body: CreatePersonaInput; response: PersonaRecord }
  'PUT personas/:id': { body: SavePersonaInput; response: PersonaRecord }
  'POST personas/:id/archive': { body: ArchivePersonaInput; response: PersonaRecord }
  'GET endpoints': { query?: { offset?: number }; response: EndpointList<EndpointRegistration> }
  'POST endpoints': { body: RegisterEndpointInput; response: EndpointRegistration }
  'GET endpoints/:id/catalog': { query?: { offset?: number }; response: EndpointCatalog }
  'GET endpoints/:id/commands': { query?: { offset?: number }; response: EndpointList<OperatorCommand> }
  'POST endpoints/:id/commands': { body: EndpointCommandInput; response: OperatorCommand }
  'POST endpoints/:id/commands/:command/retry': { response: OperatorCommand }
  'POST endpoints/:id/commands/:command/profile': { body: { port: number }; response: RemoteProfileView }
  'GET execution': { query?: Paged; response: ExecutionReceiptPage & { blocked: number } }
  'POST execution/refresh': { response: ExecutionReceiptPage & { blocked: number } }
  'POST execution/:effect/cancel': { body: { requestId: string }; response: ExecutionReceiptPage & { blocked: number } }
  'GET tickets/:id/execution': { query?: Paged; response: ExecutionReceiptPage & { blocked: number } }
  'POST tickets/:id/execution/refresh': { response: ExecutionReceiptPage & { blocked: number } }
  'POST tickets/:id/execution/:effect/cancel': { body: { requestId: string }; response: ExecutionReceiptPage & { blocked: number } }
  'GET environments': { response: EnvironmentList }
  'POST environments': { body: EnrollEnvironmentInput; response: EnvironmentView }
  'PUT environments/:id': { body: EnvironmentCommandInput; response: EnvironmentView }
  'GET missions/:id/plans': { query?: Paged; response: PlanIndex }
  'GET missions/:id/plans/:version': { response: PlanVersion }
  'GET missions/:id/proposals/:proposal': { response: PlanProposal }
  'POST missions/:id/proposals': { body: ProposePlanInput; response: PlanProposal }
  'POST missions/:id/proposals/:proposal': { body: ReviewPlanInput; response: PlanProposal }
  'POST missions/:id/plan-request': { body: RequestPlanInput; response: MissionView }
  'GET inbox': { query?: Paged & { filter?: InboxFilter; q?: string }; response: InboxPage }
  'POST inbox': { body: InboxStartInput; response: InboxItem }
  'GET inbox/:id': { query?: { before?: string; limit?: number }; response: Conversation }
  'POST inbox/:id/read': { body: { revision: string }; response: { marked: boolean; unread: boolean } }
  'POST inbox/:id/reply': { body: InboxReplyInput; response: InboxItem }
  'GET library': { query?: LibraryQueryInput; response: LibraryList }
  'POST library': { body: CreateRecordInput; response: LibraryEntry }
  'GET library/:id': { query?: Paged; response: LibraryRead }
  'GET library/:id/content': { response: LibraryContent }
  'PUT library/:id': { body: ArchiveRecordInput; response: LibraryEntry }
  'GET missions': { query?: Paged; response: MissionList }
  'GET missions/:id': { response: MissionView }
  'POST missions': { body: CreateMissionInput; response: MissionView }
  'POST missions/:id/actions': { body: AddActionInput; response: MissionView }
  'POST missions/:id/actions/:action': { body: ActionCommandInput; response: MissionView }
  'PUT missions/:id': { body: MissionCommandInput; response: MissionView }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
