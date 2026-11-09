/** Confirm original world revocation without replaying it, adopting another grant or enabling a restored world. */
import { Rpc } from '../remote/protocol.ts'
import { fingerprint } from '../remote/journal.ts'
import { RevocationObservation } from '../remote/recovery.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'

/** An independently missing or conflicting original revocation prevents recovery preparation. */
export class RevocationMismatch extends Error {
  constructor(readonly code: 'revocation_missing' | 'revocation_mismatch') { super(code) }
}
export function revocationRequest(original: WorldRecord) {
  if (!original.revocation || !['revoking', 'revoked'].includes(original.phase)) throw new RevocationMismatch('revocation_mismatch')
  const request = Rpc.parse({ op: 'grant.revoke', requestId: original.revocation.requestId, reason: original.revocation.reason })
  return { id: original.revocation.requestId,
    requestHash: fingerprint({ principal: { role: 'grant', id: original.grant.id, epoch: original.grant.epoch }, request }) }
}
export function observeRevocation(original: WorldRecord, input: unknown): WorldRecord {
  const observed = RevocationObservation.parse(input), expected = revocationRequest(original)
  const mismatch = () => { throw new RevocationMismatch('revocation_mismatch') }
  if (observed.id !== expected.id || observed.requestHash !== expected.requestHash || !observed.quiescent) mismatch()
  if (!observed.found) {
    if (observed.result !== undefined || observed.current !== undefined || observed.generationQuiescent !== undefined) mismatch()
    throw new RevocationMismatch('revocation_missing')
  }
  const receipt = observed.result, grant = observed.current, saved = original.revocation!.receipt
  if (!receipt || !grant || !observed.generationQuiescent) return mismatch()
  if (receipt.grantId !== original.grant.id || receipt.epoch !== original.grant.epoch || grant.enabled || grant.epoch !== original.grant.epoch + 1
    || grant.revision <= original.grant.revision || worldBinding(original.endpointId, { ...grant, epoch: original.grant.epoch }) !== worldBinding(original.endpointId, original.grant)
    || saved && (saved.grantId !== receipt.grantId || saved.epoch !== receipt.epoch || saved.at !== receipt.at)
    || original.phase === 'revoked' && !saved) mismatch()
  return { ...structuredClone(original), phase: 'revoked', revocation: { ...original.revocation!, receipt: { ...receipt, quiescent: true } } }
}
