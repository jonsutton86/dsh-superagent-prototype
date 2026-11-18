/** Operator inbox contracts. Read receipts and conversation views do not grant execution authority. */
import { z } from 'zod'
import { INBOX_FILTERS } from '../app/api.ts'
import { AttachmentIds, type AttachmentView } from '../attachments/model.ts'
import { PersonaRef, type PersonaDefinition } from '../personas/model.ts'
import { WorldRef } from '../environments/pool-model.ts'
import { DefaultEnvironmentRef, type DefaultEnvironmentSelection, type EnvironmentDescription, type ExecutionGrant } from '../environments/model.ts'
import type { StopHoldView } from '../executor/stop-view-model.ts'

export type InboxFilter = typeof INBOX_FILTERS[number]
export const InboxQuery = z.object({ filter: z.enum(INBOX_FILTERS).default('all'), q: z.string().trim().max(200).default(''),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(50).default(30) }).strict()
export const InboxRead = z.object({ revision: z.string().min(1).max(100) }).strict()
const InboxInput = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  text: z.string().trim().min(1).max(12000), title: z.string().trim().max(160).default(''), attachments: AttachmentIds.optional(),
  persona: PersonaRef.optional(), environment: WorldRef.optional(), expectedDefault: DefaultEnvironmentRef.optional() }).strict()
export const InboxStart = InboxInput.refine(value => !value.environment || !value.expectedDefault, 'Choose a managed environment or the reviewed default, not both')
export const InboxReply = InboxInput.omit({ title: true, persona: true, environment: true, expectedDefault: true }).extend({ revision: z.string().min(1).max(100) }).strict()
export interface InboxExecutionSelection { persona?: PersonaRef; environment?: string; expectedDefault?: ExecutionGrant }
export interface InboxSetup { defaultEnvironment: DefaultEnvironmentSelection }
export interface InboxExecution {
  directory: string
  persona?: PersonaRef & { digest: string } & Pick<PersonaDefinition, 'name' | 'model' | 'capabilities'>
  environment?: { grant: ExecutionGrant; description?: EnvironmentDescription }
}
export const InboxHistory = z.object({ before: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30) }).strict()
export interface InboxItem {
  id: string; title: string; source: string; at: string; revision: string; unread: boolean
  status: 'question' | 'review' | 'working' | 'idle' | 'blocked' | 'done' | 'stopped' | 'outdated'
  preview: string; question?: string; sessionId?: string; canReply: boolean
  mission?: { id: string; title: string; actionId: string; revision: number; current: boolean }
  execution?: InboxExecution
  stopHold?: StopHoldView
}
export interface ConversationMessage {
  id: string; at: string; role: 'person' | 'agent' | 'context' | 'status'; text: string
  truncated: boolean; pending?: boolean; source?: string
  attachments?: AttachmentView[]
}
export interface InboxPage { items: InboxItem[]; nextOffset: number | null; unread: number; questions: number; review: number }
export interface Conversation {
  item: InboxItem; messages: ConversationMessage[]; nextBefore: string | null
  historyAvailable: boolean; artifacts: { id: string; title: string; kind: 'memory' | 'artifact' }[]
}
export type InboxStartInput = z.input<typeof InboxStart>
export type InboxReplyInput = z.input<typeof InboxReply>
