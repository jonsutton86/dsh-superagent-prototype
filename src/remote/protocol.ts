/** Versioned remote execution contracts. Authority comes from endpoint-issued credentials, never tool text. */
import { z } from 'zod'
import type { FsEditOutcome, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { OwnershipStamp } from '../ownership/protocol.ts'
import { InventoryPage, InventoryRequest, ReceiptRequest } from '../ownership/inventory.ts'

export const REMOTE_VERSION = 1
export const RPC_PATH = '/execution/v1'
import { MAX_TEXT, MAX_WINDOW } from './limits.ts'
export { MAX_TEXT, MAX_WINDOW }
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const revision = z.number().int().positive()
const path = z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is not a path character')
const leaseMs = z.number().int().min(1000).max(300_000)
export const Operations = z.enum(['fs.read', 'fs.write', 'process.spawn', 'network'])
const version = z.string().min(1).max(1000)
const intent = z.discriminatedUnion('kind', [z.object({ kind: z.literal('createIfAbsent') }).strict(),
  z.object({ kind: z.literal('replaceIfVersion'), version }).strict()])
const request = { requestId: id }
export const CredentialRef = z.object({ id, version: z.string().uuid() }).strict()
const credentialRefs = z.array(CredentialRef).max(16)
export interface CredentialBinding { id: string; version: string; variable: string; mode: 'env' | 'file' }
export interface EndpointCredential extends CredentialBinding { revision: number; enabled: boolean; createdAt: string; updatedAt: string }
/** Attribution supplied by trusted coordinator code; it never grants endpoint authority. */
export const EffectOwner = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assignment'), ticketId: id, assignmentId: id, sessionId: z.string().min(1).max(300),
    callId: z.string().min(1).max(300), tool: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('host'), purpose: z.string().min(1).max(100) }).strict(),
])
export type EffectOwner = z.infer<typeof EffectOwner>
const ownership = { owner: EffectOwner.optional() }
export const AdministrationAction = z.enum(['grant.create', 'grant.change', 'credential.import', 'credential.revoke', 'job.cancel', 'job.reconcile', 'operation.reconcile'])
export const AdministrationRead = z.object({ op: z.literal('recovery.administration'), revision: InventoryPage.shape.revision,
  id, action: AdministrationAction, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const RevocationRead = z.object({ op: z.literal('recovery.revocation'), revision: InventoryPage.shape.revision,
  id, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const Rpc = z.discriminatedUnion('op', [
  InventoryRequest, ReceiptRequest, AdministrationRead, RevocationRead,
  z.object({ op: z.literal('identity') }).strict(),
  z.object({ op: z.literal('grant.list'), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('grant.get'), id }).strict(),
  z.object({ op: z.literal('job.catalog'), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('operation.list'), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('credential.list'), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('credential.import'), ...request, id, revision: z.number().int().nonnegative(),
    file: z.string().regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/), variable: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
    mode: z.enum(['env', 'file']), reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ op: z.literal('credential.revoke'), ...request, id, revision, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ op: z.literal('grant.create'), ...request, owner: id, workspace: id,
    operations: z.array(Operations).min(1).max(4), leaseMs, credentials: credentialRefs.optional() }).strict(),
  z.object({ op: z.literal('grant.change'), ...request, id, revision, enabled: z.boolean(), leaseMs, reason: z.string().trim().min(1).max(2000),
    credentials: credentialRefs.optional() }).strict(),
  z.object({ op: z.literal('grant.renew'), ...request, revision, leaseMs }).strict(),
  z.object({ op: z.literal('grant.revoke'), ...request, reason: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ op: z.literal('grant.status') }).strict(),
  z.object({ op: z.literal('job.spawn'), ...request, ...ownership, revision, argv: z.array(z.string().max(MAX_TEXT).refine(value => !value.includes('\0'))).min(1).max(256),
    cwd: path, stdin: z.string().max(MAX_TEXT).optional(), graceMs: z.number().int().min(1).max(30_000),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192).refine(value => !value.includes('\0')).nullable()).default({}) }).strict(),
  z.object({ op: z.literal('job.get'), id }).strict(),
  z.object({ op: z.literal('job.list'), offset: z.number().int().nonnegative().default(0) }).strict(),
  z.object({ op: z.literal('job.output'), id, stream: z.enum(['stdout', 'stderr']), offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(MAX_WINDOW).default(MAX_WINDOW) }).strict(),
  z.object({ op: z.literal('job.cancel'), ...request, id }).strict(),
  z.object({ op: z.literal('job.reconcile'), ...request, id, note: z.string().trim().min(1).max(2000), quiescent: z.literal(true) }).strict(),
  z.object({ op: z.literal('process.executable'), command: path }).strict(),
  z.object({ op: z.literal('fs.resolve'), path, cwd: path.optional() }).strict(),
  z.object({ op: z.literal('fs.stat'), path }).strict(),
  z.object({ op: z.literal('fs.lstat'), path, cwd: path.optional() }).strict(),
  z.object({ op: z.literal('fs.read'), path }).strict(),
  z.object({ op: z.literal('fs.bytes'), path, offset: z.number().int().nonnegative(), length: z.number().int().min(0).max(MAX_WINDOW) }).strict(),
  z.object({ op: z.literal('fs.list'), path }).strict(),
  z.object({ op: z.literal('fs.write'), ...request, ...ownership, path, content: z.string().max(MAX_TEXT), expected: intent.optional() }).strict(),
  z.object({ op: z.literal('fs.edit'), ...request, ...ownership, path, oldString: z.string().min(1).max(MAX_TEXT), newString: z.string().max(MAX_TEXT),
    replaceAll: z.boolean(), expected: z.object({ version }).strict().optional() }).strict(),
  z.object({ op: z.literal('operation.get'), id }).strict(),
  z.object({ op: z.literal('operation.reconcile'), ...request, id, note: z.string().trim().min(1).max(2000) }).strict(),
])
export type RpcInput = z.input<typeof Rpc>
export type RpcRequest = z.output<typeof Rpc>
export type Principal = { role: 'admin' } | { role: 'grant'; id: string; epoch: number }
export interface RemoteGrant {
  id: string; owner: string; workspace: string; root: string; operations: z.infer<typeof Operations>[]
  revision: number; epoch: number; enabled: boolean; leaseUntil: number; createdAt: string; updatedAt: string
  rootIdentity: string
  credentials?: CredentialBinding[]
}
export interface GrantReceipt { grant: RemoteGrant; credential?: string }
/** Acknowledges removal of this credential's authority; process/file quiescence is a separate observation. */
export interface RevocationReceipt { grantId: string; epoch: number; at: string; quiescent: boolean }
export interface EndpointIdentity {
  protocol: 1; id: string; platform: string; confinement: string
  ownership?: { authorityId: string; coordinatorId: string; resourceId: string }
  capabilities: { filesystem: true; process: true; terminal: false; interactiveStdin: false; controlChannel: false; outputWindow: number; effectOwnership?: true; credentialBindings?: true; administration?: true }
}
export interface RemoteJob {
  id: string; grantId: string; epoch: number; revision: number; fingerprint: string
  phase: 'accepted' | 'started' | 'settled' | 'unknown'; createdAt: string; updatedAt: string
  request: Extract<RpcRequest, { op: 'job.spawn' }>; cancelRequested: boolean; quiescent: boolean | null
  credentials?: CredentialBinding[]
  ownership?: OwnershipStamp
  outcome?: { exitCode: number | null; signal: string | null }; error?: string; reconciled?: { at: string; note: string }
}
export interface RemoteOperation {
  id: string; grantId: string; epoch: number; fingerprint: string; kind: string
  owner?: EffectOwner
  ownership?: OwnershipStamp
  phase: 'started' | 'settled' | 'unknown'; value?: FsWriteOutcome | FsEditOutcome
  error?: { code: string; message: string }; at: string
  reconciled?: { at: string; note: string }
}
export interface OutputWindow { offset: number; nextOffset: number; data: string; gap: boolean; totalBytes: number; retainedBytes: number }
/** Typed protocol refusal; ambiguous transport failures are represented separately by the client. */
export class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
