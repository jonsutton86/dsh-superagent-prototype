/** Operator-only endpoint contracts; no credential values are accepted or returned by the panel. */
import { z } from 'zod'
import { Operations, Rpc, type EndpointCredential, type EndpointIdentity, type RemoteGrant, type RemoteJob, type RemoteOperation,
  type RpcInput, type RpcRequest } from '../remote/protocol.ts'

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const RegisterEndpoint = z.object({ requestId, endpointId: z.string().uuid(), name: z.string().trim().min(1).max(160),
  url: z.string().max(2048), credentialFile: z.string().min(1).max(4096), revision: z.number().int().nonnegative() }).strict()
export const EndpointCommand = z.object({ revision: z.number().int().positive(), request: Rpc }).strict()
export const EndpointPage = z.object({ offset: z.coerce.number().int().nonnegative().default(0) }).strict()
export const EndpointProfile = z.object({ port: z.number().int().min(1024).max(65535) }).strict()
export const CredentialMetadata = z.object({ id: requestId, version: z.string().uuid(), variable: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  mode: z.enum(['env', 'file']), revision: z.number().int().positive(), enabled: z.boolean(), createdAt: z.string(), updatedAt: z.string() })
export const IdentityMetadata = z.object({ protocol: z.literal(1), id: z.string().uuid(), platform: z.string(), confinement: z.string(),
  ownership: z.object({ authorityId: z.string().uuid(), coordinatorId: requestId, resourceId: requestId }).optional(),
  capabilities: z.object({ filesystem: z.literal(true), process: z.literal(true), terminal: z.literal(false), interactiveStdin: z.literal(false), controlChannel: z.literal(false),
    outputWindow: z.number().int().positive(), effectOwnership: z.literal(true).optional(), credentialBindings: z.literal(true).optional(), administration: z.literal(true).optional() }) })
export const GrantMetadata = z.object({ id: z.string().uuid(), owner: requestId, workspace: requestId,
  root: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0')),
  rootIdentity: z.string().min(1).max(2000), operations: z.array(Operations).min(1).max(4),
  revision: z.number().int().positive(), epoch: z.number().int().positive(), enabled: z.boolean(), leaseUntil: z.number().int().nonnegative(),
  createdAt: z.string(), updatedAt: z.string(), credentials: z.array(z.object({ id: requestId, version: z.string().uuid(),
    variable: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), mode: z.enum(['env', 'file']) })).max(16).optional() })
export const ADMIN_ACTIONS = ['grant.create', 'grant.change', 'credential.import', 'credential.revoke', 'job.cancel', 'job.reconcile', 'operation.reconcile'] as const
export type EndpointAction = Extract<RpcRequest, { op: typeof ADMIN_ACTIONS[number] }>
export type RegisterEndpointInput = z.input<typeof RegisterEndpoint>
export interface EndpointCommandInput { revision: number; request: Extract<RpcInput, { op: typeof ADMIN_ACTIONS[number] }> }
export interface EndpointRegistration {
  id: string; name: string; url: string; credentialFile: string; revision: number; createdAt: string; updatedAt: string; identity: EndpointIdentity
}
export interface EndpointList<T> { items: T[]; nextOffset: number | null }
export type EndpointJob = Pick<RemoteJob, 'id' | 'grantId' | 'epoch' | 'phase' | 'createdAt' | 'updatedAt' | 'cancelRequested' | 'quiescent' | 'reconciled'>
export type EndpointOperation = Pick<RemoteOperation, 'id' | 'grantId' | 'epoch' | 'kind' | 'phase' | 'at' | 'reconciled'>
export interface EndpointCatalog {
  grants: EndpointList<RemoteGrant>; credentials: EndpointList<EndpointCredential>; jobs: EndpointList<EndpointJob>; operations: EndpointList<EndpointOperation>
}
export interface OperatorCommand {
  id: string; endpointId: string; enrollmentRevision: number; request: EndpointAction
  phase: 'pending' | 'unknown' | 'done' | 'refused' | 'superseded' | 'recovered'; createdAt: string; updatedAt: string; problem?: string
  recovery?: { at: string; revision: string; requestHash: string; originalPhase: string }
  result?: { grant?: RemoteGrant; credential?: EndpointCredential; job?: EndpointJob; operation?: EndpointOperation }
}
export interface RemoteProfileView { endpointId: string; grantId: string; epoch: number; leaseUntil: number; port: number; patchFile: string; patch: unknown[] }
