import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import { observeStorage, storageDirectoryObservation, storageMountObservation, storageQuotaObservation } from '../src/remote/storage-probe.ts'
import type { EndpointStorage } from '../src/remote/storage-model.ts'

const state = 'Project quota state on /volume (/dev/loop3)\n  Accounting: ON\n  Enforcement: ON\n'
const report = '#17 10240 0 16384 00 [--------] 2 0 128 00 [--------]\n'
const policy: EndpointStorage = { kind: 'linux-xfs-project', filesystemUUID: 'a9b48006-3a5a-4238-a2c8-b64e1f6b530a',
  mountRoot: '/volume', projectIds: { first: 17, last: 19 },
  pool: { bytes: 32 * 1024 ** 2, inodes: 256 }, workspace: { bytes: 16 * 1024 ** 2, inodes: 128 } }
it('converts qualified numeric quota-report units without treating accounting as enforcement', () => {
  expect(storageQuotaObservation(state, report, 17)).toEqual({ accounting: true, enforcement: true,
    usedBytes: 10 * 1024 ** 2, hardBytes: 16 * 1024 ** 2, usedInodes: 2, hardInodes: 128 })
  expect(storageQuotaObservation(state.replace('Enforcement: ON', 'Enforcement: OFF'), report, 17).enforcement).toBe(false)
})
it.each([['missing state', '', report], ['duplicate state', state + state, report], ['empty report', state, ''],
  ['duplicate rows', state, report + report], ['wrong project', state, report.replace('#17', '#18')],
  ['unsafe integer', state, report.replace('10240', '9007199254740992')],
  ['unit suffix', state, report.replace('16384', '16M')], ['truncated report', state, report.slice(0, -10)]])('rejects %s', (_, a, b) => {
  expect(() => storageQuotaObservation(a!, b!, 17)).toThrow()
})
it('requires exactly one directory membership and exposes inheritance/realtime distinctions', () => {
  const text = 'fsxattr.projid = 17\nfsxattr.xflags = 0x200 [proj-inherit]\n'
  expect(storageDirectoryObservation(text)).toEqual({ projectId: 17, inherits: true, realtime: false })
  expect(storageDirectoryObservation(text.replace('0x200', '0x100'))).toMatchObject({ inherits: false, realtime: true })
  expect(() => storageDirectoryObservation(text + text)).toThrow()
})
it('binds observations to exact filesystem UUID, mount root and numeric mount identity', () => {
  const value = { target: '/volume', fstype: 'xfs', uuid: policy.filesystemUUID, id: 42 }
  const input = (record = value) => JSON.stringify({ filesystems: [record] })
  expect(storageMountObservation(input(), policy).mountId).toBe(42)
  for (const change of [{ target: '/volume/child' }, { fstype: 'ext4' }, { uuid: randomUUID() }, { id: 0 }])
    expect(() => storageMountObservation(input({ ...value, ...change }), policy)).toThrow()
})
it.runIf(!!process.env.DSH_STORAGE_PROBE_ROOT)('observes actual XFS through Harness and refuses disabled or mismatched limits', async () => {
  const root = process.env.DSH_STORAGE_PROBE_ROOT!
  expect(process.platform).toBe('linux'); expect(process.getuid?.()).toBe(0)
  expect(root).toMatch(/^\/tmp\/agentic-storage-[a-zA-Z0-9]+\/volume$/)
  const uuid = execFileSync('findmnt', ['-n', '-o', 'UUID', '--target', root], { encoding: 'utf8' }).trim()
  const configured = { ...policy, mountRoot: root, filesystemUUID: uuid }
  const reservation = { requestId: 'native', requestHash: 'a'.repeat(64), workspace: 'one', endpointId: randomUUID(),
    projectId: 17, phase: 'provisioning' as const, createdAt: new Date().toISOString() }
  const ctx = new Context(), runtime = new LocalSubprocessRuntime(ctx)
  const quota = (command: string) => execFileSync('xfs_quota', ['-x', '-c', command, root], { encoding: 'utf8' })
  try {
    const observe = () => observeStorage(runtime, configured, reservation, [root + '/workspace', root + '/copy'], AbortSignal.timeout(20000))
    const result = await observe()
    expect(result.quota).toMatchObject({ enforcement: true, hardBytes: 16 * 1024 ** 2, hardInodes: 128 })
    expect(result.directories).toHaveLength(2)
    quota('disable -p')
    await expect(observe()).rejects.toThrow('Storage observation')
    quota('enable -p')
    quota('limit -p bhard=8m 17')
    await expect(observe()).rejects.toThrow('Storage observation')
    quota('limit -p bhard=16m 17')
    await expect(observeStorage(runtime, configured, reservation, [root + '/other'], AbortSignal.timeout(20000))).rejects.toThrow('Storage observation')
  } finally { quota('enable -p'); quota('limit -p bhard=16m 17'); await ctx.dispose() }
}, 60000)
