/** Host-only recovery operations; mount this in an offline maintenance profile, never in an agent preset. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { privateDirectory, privateFile } from '../environments/endpoint-files.ts'
import { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint } from './checkpoint.ts'
import { reserveCheckpointOwnership, type ReserveCheckpointOwnership } from './ownership.ts'
import { prepareCheckpointReceipts, type PrepareCheckpointReceipts } from './prepare.ts'
import { auditCheckpointReceipts, type AuditCheckpointReceipts, type ReceiptAudit } from './audit.ts'
import { recoveryInferenceHost } from './inference.ts'
import { recoverySourceHost } from './sources.ts'
import { installCheckpoint, type InstallCheckpoint, type Installation } from './installation.ts'

export { createCheckpoint, importCheckpointSessions, stageCheckpoint, verifyCheckpoint, type CheckpointManifest } from './checkpoint.ts'
export { createRecoveryKey } from './crypto.ts'
export { reserveCheckpointOwnership, type ReserveCheckpointOwnership, type RecoveryIntent } from './ownership.ts'
export { auditCheckpointReceipts, type AuditCheckpointReceipts, type ReceiptAudit } from './audit.ts'
export { exportSession, inspectSession, importSession, ownSessions, withVerifiedSessionBackend, type SessionArchive, type SessionBackendVerification } from './sessions.ts'
export { prepareCheckpointReceipts, type PrepareCheckpointReceipts, type ReceiptPreparation } from './prepare.ts'
export { verifyReceiptImage, type ReceiptImage } from './image.ts'
export { type RecoveryWorldConnection } from './configuration.ts'
export { inferenceConfigurationCheck, type RecoveryInferenceHost, type InferenceConfigurationVerification } from './inference.ts'
export { sourceConfigurationCheck, type RecoverySourceHost, type SourceConfigurationVerification } from './sources.ts'
export { reconcileStateGraph, StateGraphError, type StateGraphReconciliation } from './graph.ts'
export { installCheckpoint, readInstallation, installationProfile, type InstallCheckpoint, type Installation } from './installation.ts'
export { installationPatch, type InstallationLaunch } from './profile.ts'
export const name = 'dsh-superagent-recovery'
export const inject = ['sessionPersistence']
const authority = s.object({ url: s.string().required(), authorityId: s.string().required(), coordinatorId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
  timeoutMs: s.number().min(100).max(60_000).default(5000) })
export const Config: s<Partial<RecoveryConfig>, RecoveryConfig> = s.object({ mode: s.union(['checkpoint', 'verify', 'stage', 'import-sessions', 'reserve-ownership', 'audit-receipts', 'prepare-receipts', 'install']).required(), keyFile: s.string().required(),
  stateDir: s.string(), outputDir: s.string(), checkpoint: s.string(), destination: s.string(), receiptFile: s.string(),
  reservation: s.union([s.object({ requestId: s.string().required(), epoch: s.number().min(0).step(1).required(), generation: s.number().min(0).step(1).required(),
    authority: authority.required() })]),
  audit: s.union([s.object({ authority: authority.required(), endpoints: s.array(s.object({ url: s.string().required(), endpointId: s.string().required(),
    credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(5000) })).default([]),
    worlds: s.array(s.object({ binding: s.string().pattern(/^[a-f0-9]{64}$/).required(), url: s.string().required(), endpointId: s.string().required(),
      credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(5000) })).default([]),
    publication: s.union([s.object({ url: s.string().required(), serviceId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
      timeoutMs: s.number().min(100).max(60_000).default(5000) })]),
    publicationClient: s.union([s.object({ url: s.string().required(), serviceId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
      timeoutMs: s.number().min(100).max(60_000).default(5000) })]) })]),
  preparation: s.union([s.object({ requestId: s.string().required(), auditId: s.string().required() })]),
  installation: s.union([s.object({ requestId: s.string().required(), preparationId: s.string().required(), target: s.string().pattern(/^\//).required(),
    launch: s.union([s.object({ port: s.number().min(1).max(65535).step(1), sessionRoot: s.string().pattern(/^\//) })]),
    credentials: s.array(s.object({ from: s.string().pattern(/^\//).required(), to: s.string().pattern(/^\//).required() })).default([]) })]),
  worldDirectories: s.array(s.string()).default([]) })
interface RecoveryConfig { mode: 'checkpoint' | 'verify' | 'stage' | 'import-sessions' | 'reserve-ownership' | 'audit-receipts' | 'prepare-receipts' | 'install'; keyFile: string; stateDir?: string; outputDir?: string;
  checkpoint?: string; destination?: string; receiptFile?: string; worldDirectories?: string[];
  reservation?: Pick<ReserveCheckpointOwnership, 'requestId' | 'epoch' | 'generation' | 'authority'>;
  preparation?: Pick<PrepareCheckpointReceipts, 'requestId' | 'auditId'>;
  installation?: Pick<InstallCheckpoint, 'requestId' | 'preparationId' | 'target' | 'credentials' | 'launch'>;
  audit?: Pick<AuditCheckpointReceipts, 'authority' | 'endpoints' | 'worlds' | 'publication' | 'publicationClient'> }
const required = (value: string | undefined, field: string) => { if (!value) throw new Error(`Recovery requires ${field}`); return value }

/** Keep the backend pluggable: the maintenance profile chooses the same Session service as the stopped coordinator. */
export async function apply(ctx: Context, config: RecoveryConfig): Promise<void> {
  const abort = new AbortController(); ctx.effect(() => () => abort.abort())
  if (config.receiptFile && !isAbsolute(config.receiptFile)) throw new Error('Recovery receipt path must be absolute')
  let checkpoint: string, path: string | undefined, reservation: Awaited<ReturnType<typeof reserveCheckpointOwnership>> | undefined, audit: ReceiptAudit | undefined, prepared: Awaited<ReturnType<typeof prepareCheckpointReceipts>> | undefined, installation: Installation | undefined
  if (config.mode === 'install') {
    if (!config.audit || !config.installation) throw new Error('Installation requires resource connections and the selected prepared image')
    installation = await installCheckpoint({ ...config.audit, ...config.installation, launch: config.installation.launch ?? {}, checkpoint: required(config.checkpoint, 'checkpoint'), keyFile: config.keyFile,
      destination: required(config.destination, 'destination'), signal: abort.signal })
    checkpoint = installation.image.checkpoint; path = installation.root
    ctx.logger.info('Checkpoint %s installed; Runtime startup must verify Sessions and acquire independent ownership', checkpoint)
  } else if (config.mode === 'checkpoint') {
    const result = await createCheckpoint({ stateDir: required(config.stateDir, 'stateDir'), outputDir: required(config.outputDir, 'outputDir'),
      keyFile: config.keyFile, worldDirectories: config.worldDirectories, persistence: ctx.sessionPersistence, signal: abort.signal })
    ctx.logger.info('Checkpoint %s created at %s (%s Sessions)', result.manifest.id, result.path, result.manifest.sessions.length)
    checkpoint = result.manifest.id; path = result.path
  } else if (config.mode === 'prepare-receipts') {
    if (!config.audit || !config.preparation) throw new Error('Receipt preparation requires resource connections and the selected audit/request IDs')
    prepared = await prepareCheckpointReceipts({ ...config.audit, ...config.preparation, checkpoint: required(config.checkpoint, 'checkpoint'), keyFile: config.keyFile,
      destination: required(config.destination, 'destination'), persistence: ctx.sessionPersistence, signal: abort.signal,
      inference: recoveryInferenceHost(ctx), sources: recoverySourceHost(ctx) })
    checkpoint = prepared.manifest.checkpoint; path = prepared.path
    ctx.logger.info('Checkpoint %s receipts prepared in a separate authenticated image; execution remains held', checkpoint)
  } else if (config.mode === 'audit-receipts') {
    if (!config.audit) throw new Error('Receipt audit requires every independent resource connection')
    audit = await auditCheckpointReceipts({ ...config.audit, checkpoint: required(config.checkpoint, 'checkpoint'), keyFile: config.keyFile,
      destination: required(config.destination, 'destination'), signal: abort.signal })
    checkpoint = audit.checkpoint
    ctx.logger.info('Checkpoint %s receipt audit %s (%s findings); execution remains held', checkpoint, audit.status, audit.issueCount)
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
      at: new Date().toISOString(), ...(path ? { path } : {}), ...(reservation ? { reservation } : {}), ...(audit ? { audit } : {}), ...(prepared ? { prepared: prepared.manifest } : {}),
      ...(installation ? { installation: { id: installation.id, stateDir: installation.stateDir,
        ...(installation.launch ? { patchFile: join(installation.root, 'harness.patch.json') } : {}) } } : {}), executionOwnership: false }))
  }
}
