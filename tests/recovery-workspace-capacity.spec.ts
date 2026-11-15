import { it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkWorkspaceStagingCapacity, workspaceStagingDemand } from '../src/recovery/workspace-capacity.ts'
const observed = vi.hoisted(() => ({ bsize: 4096n, bavail: 100n, files: 100n, ffree: 100n }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), statfs: async () => ({ ...observed }) }))
afterEach(() => Object.assign(observed, { bsize: 4096n, bavail: 100n, files: 100n, ffree: 100n }))
const entries = [{ path: '.', kind: 'directory' as const, mode: 0o700, uid: 1, gid: 1 },
  { path: 'file', kind: 'file' as const, mode: 0o600, uid: 1, gid: 1, bytes: 4097 },
  { path: 'alias', kind: 'file' as const, mode: 0o600, uid: 1, gid: 1, bytes: 4097, hardlinkTo: 'file' }]
it('accounts for rounded content, directories and completion metadata without double charging hard links', () => {
  expect(workspaceStagingDemand(entries, 100, 4096n)).toEqual({ bytes: 86016n, inodes: 6n })
  expect(() => workspaceStagingDemand(entries, 100, 0n)).toThrow('Invalid')
})
it('refuses insufficient bytes and finite inodes, while exposing unknown inode capacity without a reservation claim', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-capacity-'))), signal = new AbortController().signal
  try {
    observed.bavail = 20n
    await expect(checkWorkspaceStagingCapacity(root, entries, 100, signal)).rejects.toThrow('available bytes')
    observed.bavail = 21n; observed.ffree = 5n
    await expect(checkWorkspaceStagingCapacity(root, entries, 100, signal)).rejects.toThrow('available inodes')
    observed.ffree = 6n
    expect(await checkWorkspaceStagingCapacity(root, entries, 100, signal)).toMatchObject({ requiredBytes: '86016', availableInodes: '6', reserved: false, quotaVerified: false })
    observed.files = 0n; observed.ffree = 0n
    expect(await checkWorkspaceStagingCapacity(root, entries, 100, signal)).toMatchObject({ availableInodes: null, reserved: false })
    await expect(checkWorkspaceStagingCapacity(root, entries, 100, AbortSignal.abort())).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
