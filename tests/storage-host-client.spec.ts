import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { EndpointStorage } from '../src/remote/storage-model.ts'
import { RemoteJournal, fingerprint } from '../src/remote/journal.ts'
import { StorageReservations, storageRoots } from '../src/remote/storage-journal.ts'
import { StorageProvisioning } from '../src/remote/storage-provisioning.ts'
import { LocalStorageHost } from '../src/remote/storage-host-client.ts'

it.runIf(!!process.env.DSH_STORAGE_SERVICE_CONFIG)('prepares and recovers original storage through the authenticated host socket as an unprivileged endpoint', async () => {
  const config = JSON.parse(process.env.DSH_STORAGE_SERVICE_CONFIG!) as { endpointId: string; uid: number; policy: unknown }
  expect(process.platform).toBe('linux'); expect(process.getuid?.()).toBe(config.uid); expect(config.uid).toBeGreaterThan(0)
  const policy = EndpointStorage.parse(config.policy), directory = await mkdtemp(join(tmpdir(), 'dsh-storage-client-'))
  const state = join(directory, 'state')
  const assignedRoot = `${policy.mountRoot}/dsh-${config.endpointId}/workspaces`
  let journal = new RemoteJournal(state, assignedRoot, config.endpointId)
  try {
    expect(journal.id).toBe(config.endpointId)
    await expect(writeFile(join(assignedRoot, 'unprivileged-parent-write'), 'no')).rejects.toMatchObject({ code: 'EACCES' })
    const client = new LocalStorageHost(process.env.DSH_STORAGE_SERVICE_SOCKET!), request = {
      requestId: 'socket-original', workspace: 'socket-one', requestHash: fingerprint('socket-original') }
    let reservations = new StorageReservations(journal, policy)
    const original = await new StorageProvisioning(reservations, client).prepare(request, AbortSignal.timeout(20000))
    expect(original.phase).toBe('provisioned')
    expect(original.observation!.directories.map(item => item.path)).toEqual(storageRoots(policy, original))
    journal.close(); journal = new RemoteJournal(state, assignedRoot, config.endpointId)
    reservations = new StorageReservations(journal, policy)
    const recovered = await new StorageProvisioning(reservations, client).prepare(request, AbortSignal.timeout(20000))
    expect(recovered.projectId).toBe(original.projectId)
    expect(recovered.observation!.directories).toEqual(original.observation!.directories)
    const forged = { ...recovered, endpointId: randomUUID() }
    await expect(client.observe(policy, forged, storageRoots(policy, forged), AbortSignal.timeout(20000))).rejects.toThrow('Storage host response')
    await expect(client.observe(policy, recovered, ['/unassigned'], AbortSignal.timeout(20000))).rejects.toThrow('Storage host response')
    await expect(client.observe(policy, recovered, storageRoots(policy, recovered), AbortSignal.abort())).rejects.toThrow()
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }) }
}, 60000)
