/** Reconcile the original administrator intent with its historical receipt; current resources never supply replacement authority. */
import { z } from 'zod'
import { CredentialMetadata, GrantMetadata, type EndpointAction, type OperatorCommand } from '../environments/endpoint-model.ts'
import { AdministrationAction, Rpc, type RemoteGrant } from '../remote/protocol.ts'
import { fingerprint } from '../remote/journal.ts'
import { AdministrationObservation, RecoveryJob, RecoveryOperation } from '../remote/recovery.ts'
import { worldBinding } from '../remote/world-journal.ts'

export interface SavedAdministration extends OperatorCommand {
  expectedEpoch?: number; previousGrant?: RemoteGrant; credentialPin?: string
}
/** A definite comparison finding, distinct from a failed transport or invalid protocol response. */
export class AdministrationMismatch extends Error {
  constructor(readonly code: 'administration_missing' | 'administration_mismatch') { super(code) }
}
export function administrationRequest(command: SavedAdministration) {
  const request = Rpc.parse(command.request) as EndpointAction
  AdministrationAction.parse(request.op)
  if (request.requestId !== command.id) throw new AdministrationMismatch('administration_mismatch')
  return { id: command.id, action: request.op,
    requestHash: fingerprint(request.op.startsWith('credential.') ? request : { principal: { role: 'admin' }, request }) }
}
const same = (left: unknown, right: unknown) => fingerprint(left ?? null) === fingerprint(right ?? null)
const sameSet = (left: unknown[], right: unknown[]) => same(left.map(value => JSON.stringify(value)).sort(), right.map(value => JSON.stringify(value)).sort())

export function observeAdministration(original: SavedAdministration, input: unknown): SavedAdministration | undefined {
  const observed = AdministrationObservation.parse(input), expected = administrationRequest(original), request = original.request
  const mismatch = () => { throw new AdministrationMismatch('administration_mismatch') }
  if (observed.id !== expected.id || observed.action !== expected.action || observed.requestHash !== expected.requestHash || !observed.quiescent) mismatch()
  if (!observed.found) {
    if (observed.current !== undefined || observed.result !== undefined) mismatch()
    if (original.phase === 'refused') return undefined
    throw new AdministrationMismatch('administration_missing')
  }
  if (original.phase === 'refused' || observed.result === undefined || observed.current === undefined) mismatch()
  const tag = request.op.startsWith('grant.') ? 'grant' : request.op.startsWith('credential.') ? 'credential' : request.op.startsWith('job.') ? 'job' : 'operation'
  if (original.phase === 'done' && !original.result?.[tag] || original.result && !original.result[tag]) mismatch()
  const command = structuredClone(original)
  delete command.problem
  if (request.op === 'grant.create' || request.op === 'grant.change') {
    const id = z.string().uuid().parse(observed.result), grant = GrantMetadata.parse(observed.current), previous = command.previousGrant
    if (grant.id !== id || command.result?.grant && command.result.grant.id !== id || command.expectedEpoch === undefined
      || request.op === 'grant.create' && (command.expectedEpoch !== 1 || grant.owner !== request.owner || grant.workspace !== request.workspace)
      || request.op === 'grant.change' && (!previous || previous.id !== id || request.id !== id || previous.revision !== request.revision
        || command.expectedEpoch !== previous.epoch + 1 || grant.root !== previous.root || grant.rootIdentity !== previous.rootIdentity)) mismatch()
    if (grant.epoch < command.expectedEpoch!) mismatch()
    if (grant.epoch !== command.expectedEpoch) {
      command.phase = 'superseded'; command.problem = 'The original administration committed, but its grant generation has been replaced'
      // Keep any historical result. Never record a replacement generation as the result of this older request.
    } else {
      const operations = request.op === 'grant.create' ? request.operations : previous!.operations
      const credentials = request.credentials ?? (request.op === 'grant.change' ? previous!.credentials ?? [] : [])
      if (grant.enabled !== (request.op === 'grant.create' || request.enabled)
        || request.op === 'grant.change' && (grant.owner !== previous!.owner || grant.workspace !== previous!.workspace)
        || !sameSet(grant.operations, [...new Set(operations)])
        || !sameSet((grant.credentials ?? []).map(({ id, version }) => ({ id, version })), credentials.map(({ id, version }) => ({ id, version })))) mismatch()
      if (command.result?.grant && worldBinding(command.endpointId, command.result.grant) !== worldBinding(command.endpointId, grant)) mismatch()
      command.result = { grant: command.result?.grant ?? grant }
      if (original.phase === 'done' && (!grant.enabled || command.credentialPin)) command.phase = 'done'
      else { command.phase = 'recovered'; command.problem = 'Original grant creation/change is confirmed; private grant credentials require recovery validation before activation' }
    }
  } else if (request.op === 'credential.import' || request.op === 'credential.revoke') {
    const saved = CredentialMetadata.parse(observed.result), current = CredentialMetadata.parse(observed.current)
    if (saved.id !== request.id || current.id !== saved.id || saved.revision !== request.revision + 1
      || saved.enabled !== (request.op === 'credential.import')
      || request.op === 'credential.import' && (saved.variable !== request.variable || saved.mode !== request.mode)
      || original.result?.credential && !same(CredentialMetadata.parse(original.result.credential), saved)
      || current.revision < saved.revision || current.revision === saved.revision && !same(current, saved)) mismatch()
    command.result = { credential: saved }; command.phase = same(current, saved) ? 'done' : 'superseded'
    if (command.phase === 'superseded') command.problem = 'The original credential administration committed; its catalog revision has since changed'
  } else if (request.op === 'operation.reconcile') {
    const operation = RecoveryOperation.parse(observed.current)
    if (observed.result !== request.id || operation.id !== request.id || operation.reconciled?.note !== request.note
      || original.result?.operation && original.result.operation.id !== operation.id) mismatch()
    command.result = { operation }; command.phase = 'done'
  } else {
    const job = RecoveryJob.parse(observed.current)
    if (observed.result !== request.id || job.id !== request.id || !job.quiescent || original.result?.job && original.result.job.id !== job.id
      || request.op === 'job.cancel' && !job.cancelRequested || request.op === 'job.reconcile' && job.reconciled?.note !== request.note) mismatch()
    command.result = { job }; command.phase = 'done'
  }
  if (original.phase === 'superseded') command.phase = 'superseded'
  command.updatedAt = new Date().toISOString()
  command.recovery = { at: command.updatedAt, revision: observed.revision, requestHash: observed.requestHash, originalPhase: original.phase }
  return command
}
