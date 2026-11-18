/** Transfer a verified installation's exclusive Store lock and newly fenced ownership into the real Runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import type { Machine } from '../deployment.ts'
import { KV } from '../kv.ts'
import { privateCredential } from '../environments/endpoint-files.ts'
import { remoteWorld } from '../environments/remote-workspace.ts'
import { CoordinatorOwnership } from '../ownership/lease.ts'
import { OwnershipClient } from '../ownership/client.ts'
import { OwnershipView } from '../ownership/protocol.ts'
import { InventoryPage } from '../ownership/inventory.ts'
import { assertOwnershipCredential } from '../ownership/runtime.ts'
import { RemoteClient } from '../remote/client.ts'
import { PublicationClient } from '../publication/client.ts'
import { fingerprint } from '../remote/journal.ts'
import type { WorldRecord } from '../remote/world-journal.ts'
import { authenticateInstallationValue, installationBindings, installationKV, readInstallation, signInstallationValue, type Installation } from './installation.ts'
import { recoveryStateDigest } from './state.ts'
import { withVerifiedSessionBackend, type SessionArchive } from './sessions.ts'
import { recoverySourceHost, sourceConfigurationCheck } from './sources.ts'
import { inferenceConfigurationCheck, recoveryInferenceHost } from './inference.ts'
import { verifyControlConfigurations, controlConfigurationChecks } from './control.ts'
import { verifyWorldConfiguration } from './configuration.ts'
import type { RecoveryIntent } from './ownership.ts'

export interface RuntimeBootstrap {
  installation: Installation; ownership: CoordinatorOwnership; signal: AbortSignal; release(): void
  bindings: ReturnType<typeof installationBindings>
}
const issued = new WeakSet<RuntimeBootstrap>()
/** Only a successful in-process preflight can transfer a lock. A JSON object or an old bootstrap cannot bypass the hold. */
export function consumeRuntimeBootstrap(value: RuntimeBootstrap, machine: Machine): RuntimeBootstrap {
  if (!issued.delete(value) || value.installation.stateDir !== machine.stateDir || machine.restore?.directory !== value.installation.root)
    throw new Error('Runtime requires its original verified installation handoff')
  checkMachine(value.installation, machine)
  value.signal.throwIfAborted(); value.ownership.proof(); return value
}
function checkMachine(value: Installation, machine: Machine): void {
  const core = (config: { url: string; credentialFile: string; authorityId?: string; coordinatorId?: string; serviceId?: string } | undefined) => config &&
    { url: config.url, credentialFile: config.credentialFile, authorityId: config.authorityId, coordinatorId: config.coordinatorId, serviceId: config.serviceId }
  if (machine.stateDir !== value.stateDir || machine.executionMode !== 'local' || fingerprint(core(machine.ownership)) !== fingerprint(core(value.ownership))
    || fingerprint(core(machine.publication)) !== fingerprint(core(value.publication))) throw new Error('Runtime configuration differs from its authenticated installation')
}
async function database(path: string): Promise<DatabaseSync> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.nlink !== 1)
    throw new Error('Installed database must be a private owned regular file')
  return new DatabaseSync(path)
}

export async function prepareRuntimeActivation(ctx: Context, machine: Machine, lifetime: AbortSignal): Promise<RuntimeBootstrap> {
  if (!machine.restore) throw new Error('Runtime recovery configuration is missing')
  const { directory, keyFile } = machine.restore, abort = new AbortController()
  const signal = AbortSignal.any([lifetime, abort.signal]), value = await readInstallation(directory, keyFile, signal)
  checkMachine(value, machine)
  if (await realpath(value.stateDir) !== value.stateDir) throw new Error('Installation state directory cannot be redirected')
  const unlock = lockSync(value.stateDir, { stale: 30_000, onCompromised: error => abort.abort(error) })
  let released = false, ownership: CoordinatorOwnership | undefined
  const release = () => { if (!released) { released = true; unlock() } }
  const stop = () => { void ownership?.close() }
  signal.addEventListener('abort', stop, { once: true })
  let db: DatabaseSync | undefined
  try {
    db = await database(join(value.stateDir, 'orchestrator.sqlite'))
    const activation = installationKV<string>(db, KV.recovery.activation), hold = installationKV<{ checkpoint: string; requestId: string; state: string }>(db, KV.recovery.hold)
    if (activation) {
      const recorded = authenticateInstallationValue(activation, keyFile, 'dsh-activation:1')
      if (fingerprint(recorded) !== fingerprint({ installation: value.id, requestHash: value.requestHash, recovery: value.image.recovery }) || hold)
        throw new Error('Installed activation record differs')
    } else if (hold?.checkpoint !== value.image.checkpoint || hold.requestId !== value.image.requestId || hold.state !== 'prepared'
      || recoveryStateDigest(db, signal) !== value.storeDigest) throw new Error('Held installation Store differs from its prepared image')
    const reservation = installationKV<RecoveryIntent>(db, KV.recovery.reservation)
    if (!reservation?.recovery || fingerprint(reservation.recovery) !== fingerprint(value.image.recovery)) throw new Error('Installed ownership reservation differs')
    for (const item of value.credentials) assertOwnershipCredential({ ...value.ownership, credentialFile: item.file }, value.workspaces)
    const dedicated = value.worlds.find(item => !item.managed), mounted = remoteWorld(ctx)
    if (!!dedicated !== !!mounted || dedicated && (mounted!.status().binding !== dedicated.binding
      || fingerprint(mounted!.configuration()) !== fingerprint({ url: dedicated.config.url, endpointId: dedicated.config.endpointId,
        credentialFile: dedicated.config.credentialFile, stateDir: dedicated.config.stateDir }))) throw new Error('Dedicated execution world differs from the installed profile')
    await withVerifiedSessionBackend(ctx.sessionPersistence, join(value.root, 'archive'), value.sessions as unknown as SessionArchive[], signal, async (_verified, recheckSessions) => {
      const sources = sourceConfigurationCheck(recoverySourceHost(ctx), db!, signal)
      sources.verify()
      if (!activation) {
        for (const item of value.worlds) {
          const journal = await database(join(item.config.stateDir, 'world.sqlite'))
          try { if (recoveryStateDigest(journal, signal) !== item.digest) throw new Error('Installed execution journal differs from prepared receipts') }
          finally { journal.close() }
        }
        const authority = new OwnershipClient(value.administrators.authority)
        const inspect = async () => {
          const view = OwnershipView.parse(await authority.call({ op: 'coordinator.inspect', id: value.ownership.coordinatorId }, signal))
          if (view.phase !== 'vacant' || view.epoch < value.image.epoch || fingerprint(view.recovery) !== fingerprint(value.image.recovery)
            || fingerprint([...view.resources].sort()) !== fingerprint(value.image.resources.map(item => item.identity.resourceId).sort()))
            throw new Error('Installed recovery ownership or resource set changed')
          return view
        }
        const current = await inspect()
        const clients = new Map(value.administrators.endpoints.map(config => [config.endpointId, new RemoteClient(config)]))
        const publication = value.administrators.publication && new PublicationClient(value.administrators.publication)
        if (clients.size + (publication ? 1 : 0) !== value.image.resources.length) throw new Error('Installed resource set is incomplete')
        for (const resource of value.image.resources) {
          const client = resource.identity.kind === 'endpoint' ? clients.get(resource.identity.id)
            : resource.identity.id === value.administrators.publication?.serviceId ? publication : undefined
          if (!client) throw new Error('Installed resource connection is missing')
          const page = InventoryPage.parse(await client.call({ op: 'recovery.inventory', revision: resource.revision, offset: resource.total }, signal))
          if (page.revision !== resource.revision || page.total !== resource.total || page.offset !== resource.total || page.items.length || page.nextOffset !== null
            || !page.quiescent || fingerprint(page.identity) !== fingerprint(resource.identity)) throw new Error('Independent recovery inventory changed after installation')
        }
        await verifyControlConfigurations(controlConfigurationChecks({ ...value.administrators, publicationClient: value.publication }, db!,
          { ...reservation, credentialFile: value.ownership.credentialFile }, { ...value.image, epoch: current.epoch }, value.workspaces, signal))
        for (const item of value.worlds) if (!(item.original as WorldRecord).revocation)
          await verifyWorldConfiguration({ original: item.original as WorldRecord, binding: item.binding, connection: { binding: item.binding, ...item.config } },
            value.image.resources.find(resource => resource.identity.id === item.config.endpointId), value.workspaces, signal)
        const inference = await inferenceConfigurationCheck(recoveryInferenceHost(ctx), db!, join(value.root, 'archive'), value.sessions as unknown as SessionArchive[], value.masterId, signal)
        await inference.verify(); await inspect()
      }
      await recheckSessions(); sources.verify(); signal.throwIfAborted()
      ownership = new CoordinatorOwnership(machine.ownership!, value.image.recovery)
      await ownership.start(); signal.throwIfAborted(); ownership.proof()
      if (!activation) {
        // One SQLite transaction is the handoff boundary. An earlier crash leaves the original hold; a later crash
        // resumes under the signed activation record and still acquires a new independent process lease.
        db!.exec('BEGIN IMMEDIATE')
        try {
          db!.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KV.recovery.deployment,
            JSON.stringify({ worlds: value.worlds.map(({ binding, managed, config }) => ({ binding, managed, config })), registrations: value.registrations }))
          db!.prepare('INSERT INTO kv VALUES (?,?)').run(KV.recovery.activation, JSON.stringify(signInstallationValue(
            { installation: value.id, requestHash: value.requestHash, recovery: value.image.recovery }, keyFile, 'dsh-activation:1')))
          db!.prepare('DELETE FROM kv WHERE key=?').run(KV.recovery.hold)
          db!.exec('COMMIT')
        } catch (error) { db!.exec('ROLLBACK'); throw error }
      }
    }, !!activation)
    db.close(); db = undefined
    const result = { installation: value, ownership: ownership!, signal, release: () => { signal.removeEventListener('abort', stop); release() }, bindings: installationBindings(value) }
    issued.add(result); return result
  } catch (error) {
    try { await ownership?.close() } finally { db?.close(); signal.removeEventListener('abort', stop); release() }
    throw error
  }
}
