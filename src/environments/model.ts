/** Execution environment enrollment and operator grant contracts. Remote transports are separate providers. */
import { z } from 'zod'
import type { ExecutionGrant } from '../core/index.ts'
import type { CredentialBinding } from '../remote/protocol.ts'

const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const EnrollEnvironment = z.object({ requestId, name: z.string().trim().min(1).max(160),
  root: z.string().min(1), mode: z.enum(['local', 'repository']),
  replaceId: z.string().uuid().optional(), revision: z.number().int().positive().optional() }).strict()
  .refine(value => !!value.replaceId === (value.revision !== undefined), 'Replacing enrollment requires its ID and revision')
export const EnvironmentCommand = z.object({ requestId, revision: z.number().int().positive(), enabled: z.boolean(),
  reason: z.string().trim().min(1).max(2000) }).strict()
export interface EnvironmentRecord {
  id: string; name: string; kind: 'local' | 'remote'; root: string; configuredRoot: string; mode: 'repository' | 'local'
  identity: string; revision: number; epoch: number; enabled: boolean; createdAt: string; updatedAt: string
  remote?: { binding: string; endpointId: string; grantId: string; epoch: number; credentials?: CredentialBinding[] }
  retired?: boolean
}
export interface EnvironmentView extends Omit<EnvironmentRecord, 'identity'> {
  current: boolean; verifiedAt?: string; problem?: string; openTickets: number
  capabilities: { filesystem: true; subprocess: true; osIsolation: boolean; remote: boolean }
  remoteStatus?: { ready: boolean; phase: 'active' | 'revoking' | 'revoked'; problem?: string; acknowledged?: boolean; quiescent?: boolean }
}
export interface EnvironmentList { items: EnvironmentView[]; currentRoot: string; currentMode: 'local' | 'repository'; currentKind?: 'local' | 'remote'; needsEnrollment: boolean }
export type EnrollEnvironmentInput = z.input<typeof EnrollEnvironment>
export type EnvironmentCommandInput = z.input<typeof EnvironmentCommand>
export type { ExecutionGrant }

/** A visible enrollment/authorization refusal, distinct from a worker's task failure. */
export class EnvironmentError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
