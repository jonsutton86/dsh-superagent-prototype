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
import type { ConfigureMissionPull, MissionPullState } from '../workspace/pull-model.ts'
import type { CompletionAttempt } from '../workspace/completion.ts'
import type { ArchiveRecordInput, CreateRecordInput, LibraryContent, LibraryEntry, LibraryList, LibraryQueryInput, LibraryRead } from '../workspace/library-model.ts'
import type { CreateCheckInput, SaveCheckInput, ConfigureCheckInput, RequestCheckInput, CheckRecord, CheckVersion, CheckRun, CheckRunSummary } from '../verification/contracts.ts'
import type { EvidenceBinding, EvidenceReview } from '../verification/review-model.ts'
import type { OutputWindow } from '../remote/protocol.ts'
import type { Conversation, InboxFilter, InboxItem, InboxPage, InboxReplyInput, InboxStartInput, InboxSetup } from '../workspace/inbox-model.ts'
import type { PlanIndex, PlanProposal, PlanVersion, ProposePlanInput, ReviewPlanInput, RequestPlanInput } from '../workspace/plan-model.ts'
import type { CreateScheduleInput, SaveScheduleInput, ToggleScheduleInput, ScheduleView, ScheduleList, Schedule } from '../workspace/schedule-model.ts'
import type { UsagePage, UsageCall, UsageConfiguration, SaveUsageInput, ReconcileUsageInput } from '../usage/model.ts'
import type { ReflectionList, ReflectionView, ReflectionProposal, ReviewReflectionInput } from '../workspace/reflection-model.ts'
import type { SpeculationState, SpeculationView, SpeculationConfiguration, SaveSpeculationInput, SpeculationCommandInput, ApproveSpeculationMessageInput } from '../speculation/model.ts'
import type { RecallState, RecallConfiguration, SaveRecallInput } from '../workspace/recall-model.ts'
import type { EnvironmentList, EnvironmentView, EnrollEnvironmentInput, EnvironmentCommandInput } from '../environments/model.ts'
import type { ExecutionReceiptPage } from '../remote/effects.ts'
import type { StopAttestationRequest, StopAttestationReceipt, StopDetail, StopHoldSummary } from '../executor/stop-model.ts'
import type { ArchivePersonaInput, CreatePersonaInput, PersonaList, PersonaRecord, PersonaVersion, SavePersonaInput } from '../personas/model.ts'
import type { ActivateWorldInput, RevokeWorldInput, WorldList, WorldView } from '../environments/pool-model.ts'
import type { EndpointCatalog, EndpointCommandInput, EndpointList, EndpointRegistration, OperatorCommand, RegisterEndpointInput, RemoteProfileView } from '../environments/endpoint-model.ts'
import type { ApprovePublication, PublicationRecord } from '../publication/runtime.ts'
import type { PrepareRepositoryExport, RepositoryExportView } from '../publication/repository-export-model.ts'
import type { PrepareRepositoryPublication, ApproveRepositoryPublication, RepositoryPublicationView } from '../publication/repository-runtime-model.ts'
import type { RepositoryDestinationView } from '../publication/repository-model.ts'
import type { PullObservation } from '../publication/pull-model.ts'
import type { DestinationView } from '../publication/protocol.ts'
import type { ChannelDelivery, ConfigureDelivery, MissionDelivery } from '../publication/channels.ts'
import type { ConfigureInbound, InboundState } from '../publication/inbound.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export const INBOX_FILTERS = ['all', 'unread', 'questions', 'review', 'working'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

import type { VoiceCapabilities, VoiceReceipt, TranscribeInput, SpeakInput } from '../voice/model.ts'
import type { AttachmentCapabilities, BeginUploadInput, UploadChunkInput, UploadView } from '../attachments/model.ts'
export interface Api {
  'GET library/:id/repository-exports': { response: { items: RepositoryExportView[] } }
  'POST library/:id/repository-exports': { body: PrepareRepositoryExport; response: RepositoryExportView }
  'GET repository-exports/:id': { response: RepositoryExportView }
  'POST repository-exports/:id/retry': { response: RepositoryExportView }
  'POST repository-exports/:id/cancel': { response: RepositoryExportView }
  'GET repository-publication/destinations': { response: { configured: boolean; items: import('zod').infer<typeof RepositoryDestinationView>[] } }
  'GET repository-exports/:id/publications': { response: { items: RepositoryPublicationView[] } }
  'POST repository-exports/:id/publications': { body: PrepareRepositoryPublication; response: RepositoryPublicationView }
  'GET repository-publications/:id': { response: RepositoryPublicationView }
  'POST repository-publications/:id/retry': { response: RepositoryPublicationView }
  'POST repository-publications/:id/publish': { body: ApproveRepositoryPublication; response: RepositoryPublicationView }
  'POST repository-publications/:id/refresh': { response: RepositoryPublicationView }
  'POST repository-publications/:id/cancel': { response: RepositoryPublicationView }
  'GET uploads': { response: AttachmentCapabilities }
  'POST uploads': { body: BeginUploadInput; response: UploadView }
  'GET uploads/:id': { response: UploadView }
  'POST uploads/:id/chunks': { body: UploadChunkInput; response: UploadView }
  'POST uploads/:id/finish': { response: UploadView }
  'POST uploads/:id/cancel': { response: UploadView }
  'GET voice': { response: VoiceCapabilities }
  'POST voice/transcribe': { body: TranscribeInput; response: VoiceReceipt }
  'POST voice/speak': { body: SpeakInput; response: VoiceReceipt }
  'GET voice/:id': { response: VoiceReceipt }
  'POST voice/:id/cancel': { response: VoiceReceipt }
  'GET recall': { query?: Paged; response: RecallState }
  'PUT recall': { body: SaveRecallInput; response: RecallConfiguration }
  'GET recall/versions/:version': { response: RecallConfiguration }
  'GET usage': { query?: Paged & { scope?: 'workspace' | 'mission' | 'schedule' | 'persona'; subject?: string; from?: string }; response: UsagePage }
  'PUT usage': { body: SaveUsageInput; response: UsageConfiguration }
  'GET usage/versions/:version': { response: UsageConfiguration }
  'POST usage/calls/:id/reconcile': { body: ReconcileUsageInput; response: UsageCall }
  'GET schedules': { query?: Paged; response: ScheduleList }
  'GET speculation': { query?: Paged; response: SpeculationState }
  'PUT speculation': { body: SaveSpeculationInput; response: SpeculationConfiguration }
  'GET speculation/versions/:version': { response: SpeculationConfiguration }
  'GET speculation/:id': { response: SpeculationView }
  'POST speculation/:id/review': { body: SpeculationCommandInput; response: SpeculationView }
  'POST speculation/:id/messages': { body: ApproveSpeculationMessageInput; response: SpeculationView }
  'GET reflections': { query?: Paged; response: ReflectionList }
  'GET reflections/:id': { response: ReflectionView }
  'POST reflections/:id/proposals/:proposal/review': { body: ReviewReflectionInput; response: ReflectionProposal }
  'GET schedules/:id': { query?: Paged; response: ScheduleView }
  'GET schedules/:id/versions/:version': { response: Schedule }
  'POST schedules': { body: CreateScheduleInput; response: ScheduleView }
  'PUT schedules/:id': { body: SaveScheduleInput; response: ScheduleView }
  'POST schedules/:id/enabled': { body: ToggleScheduleInput; response: ScheduleView }
  'POST schedules/:id/occurrences/:occurrence/retry': { body: { requestId: string }; response: ScheduleView }
  'GET missions/:id/inbound': { response: InboundState }
  'PUT missions/:id/inbound': { body: ConfigureInbound; response: InboundState }
  'POST missions/:id/inbound/poll': { body: { rescan?: boolean }; response: InboundState }
  'GET missions/:id/delivery': { response: MissionDelivery }
  'PUT missions/:id/delivery': { body: ConfigureDelivery; response: MissionDelivery }
  'POST deliveries/:id/refresh': { response: ChannelDelivery }
  'POST deliveries/:id/retry': { response: ChannelDelivery }
  'GET personas': { query?: { offset?: number; q?: string; active?: 'true' | 'false' }; response: PersonaList }
  'GET worlds': { query?: { offset?: number }; response: WorldList }
  'GET worlds/:id/execution': { query?: Paged; response: ExecutionReceiptPage & { blocked: number } }
  'POST worlds/:id/execution/refresh': { response: ExecutionReceiptPage & { blocked: number } }
  'POST worlds/:id/execution/:effect/cancel': { body: { requestId: string }; response: ExecutionReceiptPage & { blocked: number } }
  'POST worlds': { body: ActivateWorldInput; response: WorldView }
  'POST worlds/:id/refresh': { response: WorldView }
  'POST worlds/:id/revoke': { body: RevokeWorldInput; response: WorldView }
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
  'GET inbox/setup': { response: InboxSetup }
  'POST inbox': { body: InboxStartInput; response: InboxItem }
  'GET inbox/:id': { query?: { before?: string; limit?: number }; response: Conversation }
  'POST inbox/:id/read': { body: { revision: string }; response: { marked: boolean; unread: boolean } }
  'POST inbox/:id/reply': { body: InboxReplyInput; response: InboxItem }
  'GET library': { query?: LibraryQueryInput; response: LibraryList }
  'GET publication/destinations': { response: { configured: boolean; items: DestinationView[]; artifactEvidence?: boolean; pullReviews?: boolean } }
  'GET publication/destinations/:id/pull': { query: { hash: string }; response: PullObservation }
  'GET library/:id/publications': { response: { items: PublicationRecord[] } }
  'POST library/:id/publications': { body: ApprovePublication; response: PublicationRecord }
  'POST publications/:id/refresh': { response: PublicationRecord }
  'POST publications/:id/retry': { response: PublicationRecord }
  'POST library': { body: CreateRecordInput; response: LibraryEntry }
  'GET library/:id': { query?: Paged; response: LibraryRead }
  'GET library/:id/content': { response: LibraryContent }
  'GET checks': { query?: Paged; response: { items: CheckRecord[]; nextOffset: number | null } }
  'POST checks': { body: CreateCheckInput; response: CheckRecord }
  'GET checks/:id': { response: CheckRecord }
  'PUT checks/:id': { body: SaveCheckInput; response: CheckRecord }
  'POST checks/:id/authority': { body: ConfigureCheckInput; response: CheckRecord }
  'GET checks/:id/versions/:version': { response: CheckVersion }
  'GET library/:id/checks': { query?: Paged; response: { items: CheckRecord[]; nextOffset: number | null } }
  'GET library/:id/review-checks': { query?: Paged; response: { items: { run: CheckRunSummary; binding: EvidenceBinding }[]; nextOffset: number | null } }
  'GET evidence-reviews/:id': { response: EvidenceReview }
  'GET library/:id/verification': { query?: Paged; response: { items: CheckRunSummary[]; nextOffset: number | null } }
  'POST library/:id/verification': { body: RequestCheckInput; response: CheckRun }
  'GET verification/:id': { response: CheckRun }
  'GET verification/:id/output': { query: { stream: 'stdout' | 'stderr'; offset?: number; limit?: number }; response: OutputWindow }
  'POST verification/:id/refresh': { response: CheckRun }
  'POST verification/:id/cancel': { body: { requestId: string; reason: string }; response: CheckRun }
  'POST verification/:id/reconcile': { body: { requestId: string; reason: string; quiescent: true }; response: CheckRun }
  'POST verification/:id/freshness': { body: { requestId: string }; response: CheckRun }
  'PUT library/:id': { body: ArchiveRecordInput; response: LibraryEntry }
  'GET missions': { query?: Paged; response: MissionList }
  'GET missions/:id': { response: MissionView }
  'POST missions': { body: CreateMissionInput; response: MissionView }
  'POST missions/:id/actions': { body: AddActionInput; response: MissionView }
  'POST missions/:id/actions/:action': { body: ActionCommandInput; response: MissionView }
  'PUT missions/:id': { body: MissionCommandInput; response: MissionView }
  'PUT missions/:id/actions/:action/pull': { body: ConfigureMissionPull; response: MissionView }
  'POST missions/:id/actions/:action/pull/inspect': { response: PullObservation }
  'GET missions/:id/completions': { response: { items: CompletionAttempt[] } }
  'POST mission-completions/:id/retry': { response: MissionView }
  'GET mission-pull-targets/:id': { response: MissionPullState }
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
  'GET tickets/:id/stops': { query?: { cursor?: string; limit?: number }; response: { items: StopHoldSummary[]; nextCursor: string | null } }
  'GET tickets/:id/assignments/:assignment/stops/:stop': { response: StopDetail }
  'POST tickets/:id/assignments/:assignment/stops/:stop/recheck': {
    body: { expectedRevision: number; executionBindingHash: string; scopeHash: string }; response: { observationRequested: true; current: StopDetail } }
  'POST tickets/:id/assignments/:assignment/stops/:stop/attest': { body: StopAttestationRequest; response: { receipt: StopAttestationReceipt; current: StopDetail } }
  'GET tickets/:id/assignments/:assignment/stops/:stop/attestations': { query?: { cursor?: string; limit?: number }; response: { items: StopAttestationReceipt[]; nextCursor: string | null } }
  'GET tickets/:id/assignments/:assignment/stops/:stop/attestations/:request': { response: { receipt: StopAttestationReceipt | null; current: StopDetail } }
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
