/** Publication intents bind exact content and a host-configured destination; they never carry account credentials. */
import { z } from 'zod'
import { OwnershipStamp } from '../ownership/protocol.ts'

export const PUBLICATION_PATH = '/publication/v1'
export const PublicationId = z.string().uuid()
export const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const BaseDestination = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), name: z.string().trim().min(1).max(160),
  maxBytes: z.number().int().min(1).max(60_000).default(30_000) })
const GithubDestination = BaseDestination.extend({ repository: z.string().max(200).regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/).refine(value => !['.', '..'].includes(value.split('/')[1]!)),
  issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), login: z.string().regex(/^[A-Za-z0-9-]+$/),
})
const destinationShapes = [GithubDestination.extend({ kind: z.literal('github-comment') }).strict(),
  GithubDestination.extend({ kind: z.literal('github-review'), comment: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  BaseDestination.extend({ kind: z.literal('feishu-reply'), brand: z.enum(['feishu', 'lark']), appId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
    botId: z.string().regex(/^ou_[A-Za-z0-9]+$/), chatId: z.string().regex(/^oc_[A-Za-z0-9]+$/), messageId: z.string().regex(/^om_[A-Za-z0-9]+$/) }).strict()] as const
export const Destination = z.discriminatedUnion('kind', destinationShapes)
export type Destination = z.infer<typeof Destination>
export const DestinationConfig = z.union(destinationShapes.map(shape => shape.extend({ credentialFile: z.string().startsWith('/') }).strict()))
export type DestinationConfig = z.infer<typeof DestinationConfig>
const subject = { artifact: z.object({ id: PublicationId, revision: z.number().int().positive(), hash: Digest }).strict().optional(),
  message: z.object({ id: z.string().min(1).max(200), ticketId: z.string().min(1).max(200), missionId: PublicationId,
    grantId: PublicationId, planVersion: z.number().int().positive() }).strict().optional() }
const oneSubject = (value: { artifact?: unknown; message?: unknown }) => !!value.artifact !== !!value.message
export const Publication = z.object({ id: PublicationId, destination: BaseDestination.shape.id, destinationHash: Digest,
  text: z.string().min(1).max(60_000), hash: Digest,
  ...subject }).strict().refine(oneSubject, 'Exactly one artifact or message subject is required')
export type Publication = z.infer<typeof Publication>
export const ExternalReceipt = z.object({ id: z.string().regex(/^(?:[1-9][0-9]*|om_[A-Za-z0-9]+)$/),
  url: z.string().regex(/^https:\/\/(?:github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*#(?:issuecomment-|discussion_r)[1-9][0-9]*|applink\.(?:feishu\.cn|larksuite\.com)\/client\/chat\/open\?openChatId=oc_[A-Za-z0-9]+)$/), bodyHash: Digest }).strict()
export type ExternalReceipt = z.infer<typeof ExternalReceipt>
export const PublicationReceipt = z.object({ id: PublicationId, destination: BaseDestination.shape.id, destinationHash: Digest,
  ...subject, hash: Digest, bytes: z.number().int().positive(), ownership: OwnershipStamp,
  phase: z.enum(['accepted', 'started', 'sent', 'failed', 'unknown', 'cancelled', 'not_delivered']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), external: ExternalReceipt.optional(), problem: z.string().max(1000).optional(),
  reconciliation: z.object({ at: z.string().datetime(), note: z.string().min(1).max(1000), evidence: z.string().min(1).max(2000) }).strict().optional(),
}).strict().refine(oneSubject, 'Exactly one publication subject is required')
export type PublicationReceipt = z.infer<typeof PublicationReceipt>
export const PublicationRpc = z.discriminatedUnion('op', [
  z.object({ op: z.literal('identity') }).strict(), z.object({ op: z.literal('destinations') }).strict(),
  z.object({ op: z.literal('publish'), publication: Publication }).strict(),
  z.object({ op: z.literal('receipt.get'), id: PublicationId }).strict(),
  z.object({ op: z.literal('receipt.list'), offset: z.number().int().min(0).max(1_000_000).default(0) }).strict(),
  z.object({ op: z.literal('receipt.observe'), id: PublicationId, externalId: ExternalReceipt.shape.id.optional() }).strict(),
  z.object({ op: z.literal('receipt.resolve'), id: PublicationId, note: z.string().trim().min(10).max(1000), evidence: z.string().trim().min(10).max(2000) }).strict(),
])
export type PublicationRpc = z.infer<typeof PublicationRpc>
export const PublicationIdentity = z.object({ protocol: z.literal(1), id: PublicationId,
  ownership: z.object({ authorityId: z.string().uuid(), coordinatorId: z.string(), resourceId: z.string() }).strict() }).strict()
export type PublicationIdentity = z.infer<typeof PublicationIdentity>
export const DestinationView = z.union(destinationShapes.map(shape => shape.extend({ hash: Digest }).strict()))
export type DestinationView = z.infer<typeof DestinationView>
/** Safe protocol refusal; account/provider diagnostics are never copied into HTTP responses. */
export class PublicationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
