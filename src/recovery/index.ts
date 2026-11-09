/** Host-only recovery operations; mount this in an offline maintenance profile, never in an agent preset. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { privateDirectory, privateFile } from '../environments/endpoint-files.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint } from './checkpoint.ts'
import { reserveCheckpointOwnership, type ReserveCheckpointOwnership } from './ownership.ts'

export { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint, type CheckpointManifest } from './checkpoint.ts'
export { createRecoveryKey } from './crypto.ts'
export { reserveCheckpointOwnership, type ReserveCheckpointOwnership, type RecoveryIntent } from './ownership.ts'
export { exportSession, inspectSession, importSession, ownSessions, type SessionArchive } from './sessions.ts'
export const name = 'dsh-superagent-recovery'
export const inject = ['sessionPersistence']
export const Config: s<Partial<RecoveryConfig>, RecoveryConfig> = s.object({ mode: s.union(['checkpoint', 'verify', 'stage', 'import-sessions', 'reserve-ownership']).required(), keyFile: s.string().required(),
  stateDir: s.string(), outputDir: s.string(), checkpoint: s.string(), destination: s.string(), receiptFile: s.string(),
  reservation: s.union([s.object({ requestId: s.string().required(), epoch: s.number().min(0).step(1).required(), generation: s.number().min(0).step(1).required(),
    authority: s.object({ url: s.string().required(), authorityId: s.string().required(), coordinatorId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
      timeoutMs: s.number().min(100).max(60_000).default(5000) }).required() })]),
  worldDirectories: s.array(s.string()).default([]) })
interface RecoveryConfig { mode: 'checkpoint' | 'verify' | 'stage' | 'import-sessions' | 'reserve-ownership'; keyFile: string; stateDir?: string; outputDir?: string;
  checkpoint?: string; destination?: string; receiptFile?: string; worldDirectories?: string[];
  reservation?: Pick<ReserveCheckpointOwnership, 'requestId' | 'epoch' | 'generation' | 'authority'> }
const required = (value: string | undefined, field: string) => { if (!value) throw new Error(`Recovery requires ${field}`); return value }

/** Keep the backend pluggable: the maintenance profile chooses the same Session service as the stopped coordinator. */
export async function apply(ctx: Context, config: RecoveryConfig): Promise<void> {
  const abort = new AbortController(); ctx.effect(() => () => abort.abort())
  if (config.receiptFile && !isAbsolute(config.receiptFile)) throw new Error('Recovery receipt path must be absolute')
  let checkpoint: string, path: string | undefined, reservation: Awaited<ReturnType<typeof reserveCheckpointOwnership>> | undefined
  if (config.mode === 'checkpoint') {
    const result = await createCheckpoint({ stateDir: required(config.stateDir, 'stateDir'), outputDir: required(config.outputDir, 'outputDir'),
      keyFile: config.keyFile, worldDirectories: config.worldDirectories, persistence: ctx.sessionPersistence, signal: abort.signal })
    ctx.logger.info('Checkpoint %s created at %s (%s Sessions)', result.manifest.id, result.path, result.manifest.sessions.length)
    checkpoint = result.manifest.id; path = result.path
  } else if (config.mode === 'reserve-ownership') {
    if (!config.reservation) throw new Error('Recovery requires reservation parameters reviewed against the independent authority')
    reservation = await reserveCheckpointOwnership({ ...config.reservation, checkpoint: required(config.checkpoint, 'checkpoint'), keyFile: config.keyFile,
      destination: required(config.destination, 'destination'), signal: abort.signal })
    checkpoint = reservation.request.selection.checkpoint
    ctx.logger.info('Checkpoint %s reserved for recovery; the prior acquisition credential is invalid and the execution hold remains', checkpoint)
  } else {
    const source = required(config.checkpoint, 'checkpoint')
    const result = config.mode === 'verify' ? await verifyCheckpoint(source, config.keyFile, abort.signal)
      : config.mode === 'import-sessions' ? await importCheckpointSessions(source, config.keyFile, required(config.destination, 'destination'), ctx.sessionPersistence, abort.signal)
      : await stageCheckpoint(source, config.keyFile, required(config.destination, 'destination'), abort.signal)
    ctx.logger.info('Checkpoint %s %s; execution ownership is not granted', result.id,
      config.mode === 'verify' ? 'verified' : config.mode === 'import-sessions' ? 'Sessions imported' : 'staged')
    checkpoint = result.id
  }
  // A small durable completion receipt supports unattended maintenance when the host routes logs away from stdout.
  if (config.receiptFile) {
    const parent = privateDirectory(dirname(config.receiptFile))
    privateFile(join(parent, basename(config.receiptFile)), JSON.stringify({ version: 1, mode: config.mode, checkpoint,
      at: new Date().toISOString(), ...(path ? { path } : {}), ...(reservation ? { reservation } : {}), executionOwnership: false }))
  }
}
