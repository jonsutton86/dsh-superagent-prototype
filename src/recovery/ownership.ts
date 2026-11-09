import { join, resolve } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { z } from 'zod'
import { KV } from '../kv.ts'
import { fingerprint, inside } from '../remote/journal.ts'
import { privateCredential, privateFile } from '../environments/endpoint-files.ts'
import { OwnershipClient, type OwnershipConnection } from '../ownership/client.ts'
import { OwnershipError, OwnershipRequest, OwnershipView, RecoveryReservation, type RecoveryClaim } from '../ownership/protocol.ts'
import { withVerifiedStagedCheckpoint } from './checkpoint.ts'

type RecoveryRequest = Extract<z.infer<typeof OwnershipRequest>, { op: 'coordinator.recover' }>
export interface RecoveryIntent {
  authorityId: string; request: RecoveryRequest; credentialFile: string; phase: 'requested' | 'refused' | 'reserved';
  recovery?: z.infer<typeof RecoveryReservation>; problem?: string
}
export interface ReserveCheckpointOwnership {
  checkpoint: string; keyFile: string; destination: string; authority: OwnershipConnection & { coordinatorId: string };
  requestId: string; epoch: number; generation: number; signal?: AbortSignal
}

/** Reserve one verified held checkpoint, revoke the prior acquisition credential, and publish its replacement without activation. */
export async function reserveCheckpointOwnership(options: ReserveCheckpointOwnership): Promise<RecoveryIntent> {
  return withVerifiedStagedCheckpoint(options.checkpoint, options.keyFile, options.destination, options.signal ?? new AbortController().signal,
    async ({ root, manifest, db, signal }) => {
      const binding = JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key=?').get(KV.runtime.ownership)?.value ?? 'null'))
      if (!binding || binding.authorityId !== options.authority.authorityId || binding.coordinatorId !== options.authority.coordinatorId)
        throw new Error('Recovery requires the checkpoint’s original independent ownership authority and coordinator identity')
      const credentialFile = join(root, 'recovery-claimant.token'), administrator = realpathSync(options.authority.credentialFile)
      if (manifest.executionWorkspaces.some(workspace => {
        let path = resolve(workspace); try { path = realpathSync(path) } catch { /* Also reject future execution paths. */ }
        return inside(path, administrator) || inside(path, credentialFile)
      })) throw new Error('Recovery credentials must stay outside every recorded execution workspace')
      const adminCredential = privateCredential(options.authority.credentialFile), pin = fingerprint(adminCredential)
      const client = new OwnershipClient(options.authority, () => {
        const current = privateCredential(options.authority.credentialFile)
        if (fingerprint(current) !== pin) throw new Error('Recovery administrator credential changed during reservation')
        return current
      })
      const request = OwnershipRequest.parse({ op: 'coordinator.recover', requestId: options.requestId, id: options.authority.coordinatorId,
        epoch: options.epoch, generation: options.generation, selection: { checkpoint: manifest.id, digest: fingerprint(manifest) } }) as RecoveryRequest
      const row = db.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.reservation)
      const saved: RecoveryIntent | undefined = row ? JSON.parse(String(row.value)) : undefined
      if (saved && saved.credentialFile !== credentialFile) throw new Error('Recovery reservation credential path changed; automatic remapping is not supported')
      const same = saved && saved.authorityId === options.authority.authorityId && fingerprint(saved.request) === fingerprint(request)
      if (saved && !same && (saved.phase !== 'refused' || saved.request.requestId === request.requestId))
        throw new Error('Retry the original recovery reservation before changing its intent')
      if (!saved) {
        try { lstatSync(credentialFile); throw new Error('Recovery refuses a pre-existing replacement credential file') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      const intent: RecoveryIntent = same ? saved : { authorityId: options.authority.authorityId, request, credentialFile, phase: 'requested' }
      const save = () => db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KV.recovery.reservation, JSON.stringify(intent))
      save(); signal.throwIfAborted()
      let claim: RecoveryClaim
      try { claim = await client.call<RecoveryClaim>(request, signal) }
      catch (error) {
        // Unknown transport outcomes keep the immutable original request. Only a confirmed domain refusal may be replaced.
        if (intent.phase !== 'reserved' && error instanceof OwnershipError && error.status === 409
          && ['recovery_changed', 'generation_exhausted'].includes(error.code)) { intent.phase = 'refused'; intent.problem = error.code; save() }
        throw error
      }
      const recovery = RecoveryReservation.parse(claim.recovery)
      if (claim.coordinatorId !== request.id || recovery.checkpoint !== request.selection.checkpoint || recovery.digest !== request.selection.digest
        || recovery.generation !== request.generation + 1 || typeof claim.credential !== 'string' || !claim.credential.startsWith(`claim.${request.id}.${recovery.generation}.`)
        || claim.credential.length > 1024 || /\s/.test(claim.credential)) throw new Error('Recovery authority returned a mismatched reservation')
      signal.throwIfAborted()
      const current = OwnershipView.parse(await client.call({ op: 'coordinator.inspect', id: request.id }, signal))
      if (current.recovery?.checkpoint !== recovery.checkpoint || current.recovery.digest !== recovery.digest || current.recovery.generation !== recovery.generation)
        throw new Error('The original recovery reservation was superseded; the staged coordinator remains held')
      signal.throwIfAborted()
      // File publication may fail after the authority commits; retry recovers the same credential without rotating again.
      privateFile(credentialFile, claim.credential)
      intent.phase = 'reserved'; intent.recovery = recovery; delete intent.problem; save()
      return intent
    })
}
