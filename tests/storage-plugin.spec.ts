import { describe, expect, it } from 'vitest'
import { Config, StorageConnection, apply } from '../src/remote/endpoint-plugin.ts'
import { IdentityMetadata } from '../src/environments/endpoint-model.ts'
import type { Context } from '@deepseek-ai/cordis'

const storage = { endpointId: '11111111-1111-4111-8111-111111111111', socketPath: '/run/dsh/storage.sock', policy: {
  kind: 'linux-xfs-project' as const, filesystemUUID: '22222222-2222-4222-8222-222222222222', mountRoot: '/srv/dsh',
  projectIds: { first: 100, last: 110 }, pool: { bytes: 4096 * 10, inodes: 100 }, workspace: { bytes: 4096, inodes: 10 },
} }
describe('Harness storage configuration', () => {
  it('preserves explicit policy and leaves existing configurations disabled', () => {
    const base = { stateDir: '/private/endpoint', workspaceRoot: '/srv/workspaces' }
    expect(Config(base).storage).toBeUndefined()
    expect(StorageConnection.parse(Config({ ...base, storage }).storage)).toEqual(storage)
  })
  it.each(['/run/../storage.sock', '/run//storage.sock', '/run/storage.sock/', '/run/\0sock', '/' + 'x'.repeat(104)])('rejects unsafe socket %s', socketPath => {
    expect(() => StorageConnection.parse({ ...storage, socketPath })).toThrow()
  })
  it('rejects inconsistent budgets before accessing host services or creating state', async () => {
    const config = Config({ stateDir: '/private/endpoint', workspaceRoot: '/srv/workspaces', storage: {
      ...storage, policy: { ...storage.policy, workspace: { bytes: 4096 * 20, inodes: 10 } },
    } })
    const ctx = { webServer: { host: '127.0.0.1' }, get subprocess() { throw new Error('must not access subprocess') } } as unknown as Context
    await expect(apply(ctx, config)).rejects.toThrow('Workspace allocation must fit the pool budget')
  })
})

it('retains pinned storage policy in coordinator identity metadata', () => {
  const identity = { protocol: 1, id: storage.endpointId, platform: 'linux', confinement: 'linux-bubblewrap',
    storage: { policy: storage.policy }, capabilities: { filesystem: true, process: true, terminal: false,
      interactiveStdin: false, controlChannel: false, outputWindow: 4096 } }
  expect(IdentityMetadata.parse(identity).storage).toEqual({ policy: storage.policy })
  expect(() => IdentityMetadata.parse({ ...identity, storage: { policy: { ...storage.policy, kind: 'estimate' } } })).toThrow()
})

it('keeps capture maintenance explicit and requires a reviewed digest only for reconciliation', async () => {
  const { CaptureMaintenance } = await import('../src/remote/endpoint-plugin.ts')
  const base = { stateDir: '/private/endpoint', workspaceRoot: '/srv/workspaces' }
  expect(Config(base).maintenance).toBeUndefined()
  const maintenance = { mode: 'capture' as const, receiptFile: '/private/capture-result.json', request: {
    requestId: '11111111-1111-4111-8111-111111111111', grantId: '22222222-2222-4222-8222-222222222222', epoch: 1,
    destination: '/private/archive', maxEntries: 100, maxBytes: 1024 } }
  expect(CaptureMaintenance.parse(Config({ ...base, maintenance }).maintenance)).toEqual(maintenance)
  expect(() => CaptureMaintenance.parse({ ...maintenance, mode: 'reconcile' })).toThrow()
  expect(() => CaptureMaintenance.parse({ ...maintenance, expectedManifestHash: 'a'.repeat(64) })).toThrow()
  expect(CaptureMaintenance.parse({ ...maintenance, mode: 'reconcile', expectedManifestHash: 'a'.repeat(64) }).mode).toBe('reconcile')
  const ctx = { webServer: { host: '127.0.0.1' }, get subprocess() { throw new Error('must not access subprocess') } } as unknown as Context
  await expect(apply(ctx, Config({ ...base, maintenance }))).rejects.toThrow('kernel resource enforcement')
})
