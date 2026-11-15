import { realpath, stat } from 'node:fs/promises'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { EndpointStorage, StorageReservation } from './storage-model.ts'
import { inside } from './journal.ts'

const fail = (): never => { throw new Error('Storage observation is unavailable or does not match the pinned allocation') }
const bounded = (value: string) => { if (Buffer.byteLength(value) > 65536 || value.includes('\0')) fail(); return value }
const integer = (value: string): number => { if (!/^\d+$/.test(value)) return fail(); const number = Number(value); return Number.isSafeInteger(number) ? number : fail() }
function single(text: string, expression: RegExp): string {
  const matches = [...bounded(text).matchAll(expression)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) return fail()
  return matches[0][1]
}

/** Parse only numeric, bounded output under LC_ALL=C. Missing/duplicate state is never readiness. */
export function storageQuotaObservation(state: string, report: string, projectId: number) {
  if (!Number.isInteger(projectId) || projectId < 1 || projectId > 2 ** 32 - 1) return fail()
  const accounting = single(state, /^\s*Accounting: (ON|OFF)\s*$/gm) === 'ON'
  const enforcement = single(state, /^\s*Enforcement: (ON|OFF)\s*$/gm) === 'ON'
  const rows = bounded(report).split('\n').map(line => line.trim()).filter(Boolean)
  if (rows.length !== 1) return fail()
  const row = /^#?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\[[^\]\r\n]*\]\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\[[^\]\r\n]*\]$/.exec(rows[0]!)
  if (!row || integer(row[1]!) !== projectId) return fail()
  const usedBytes = integer(row[2]!) * 1024, hardBytes = integer(row[4]!) * 1024
  if (!Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(hardBytes)) return fail()
  return { accounting, enforcement, usedBytes, hardBytes, usedInodes: integer(row[5]!), hardInodes: integer(row[7]!) }
}
export function storageDirectoryObservation(text: string) {
  const projectId = integer(single(text, /^fsxattr\.projid\s*=\s*(\d+)\s*$/gm))
  const flags = Number.parseInt(single(text, /^fsxattr\.xflags\s*=\s*(0x[0-9a-fA-F]+)(?:\s+.*)?$/gm), 16)
  if (!Number.isSafeInteger(flags) || flags > 0xffffffff) return fail()
  // Linux uapi fs.h: FS_XFLAG_PROJINHERIT=0x200; reject realtime file/inheritance for this data-block policy.
  return { projectId, inherits: !!(flags & 0x200), realtime: !!(flags & 0x101) }
}
export function storageMountObservation(text: string, policy: EndpointStorage) {
  const value = JSON.parse(bounded(text)) as { filesystems?: Array<{ target?: string; fstype?: string; uuid?: string; id?: number }> }
  if (!Array.isArray(value?.filesystems) || value.filesystems.length !== 1) return fail()
  const mount = value.filesystems[0]!
  if (mount.target !== policy.mountRoot || mount.fstype !== 'xfs' || mount.uuid?.toLowerCase() !== policy.filesystemUUID.toLowerCase()
    || !Number.isSafeInteger(mount.id) || mount.id! < 1) return fail()
  return { mountId: mount.id!, filesystemUUID: mount.uuid, mountRoot: mount.target }
}

/** Read-only host-side observation through Harness. No sudo, provisioning, policy edits, or readiness persistence. */
export async function observeStorage(subprocess: SubprocessRuntime, configured: EndpointStorage, reserved: StorageReservation,
  roots: readonly string[], signal: AbortSignal) {
  if (process.platform !== 'linux') return fail()
  const policy = EndpointStorage.parse(configured), reservation = StorageReservation.parse(reserved)
  if (reservation.projectId < policy.projectIds.first || reservation.projectId > policy.projectIds.last
    || roots.length < 1 || roots.length > 16 || new Set(roots).size !== roots.length) return fail()
  const total = AbortSignal.any([signal, AbortSignal.timeout(15000)])
  const run = async (program: string, args: string[]) => {
    total.throwIfAborted()
    const executable = await subprocess.resolveExecutable(program, { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, total)
    const handle = subprocess.spawn({ argv: [executable, ...args], cwd: '/', signal: total, graceMs: 1000,
      env: { LC_ALL: 'C', LANG: 'C', PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } } })
    const result = await handle.done
    if (!await handle.waitForExit(total) || result.exitCode !== 0) return fail()
    const output = handle.collected.stdout?.readFrom(0), error = handle.collected.stderr?.readFrom(0)
    if (!output || output.lossy || error?.lossy || error?.text.trim()) return fail()
    total.throwIfAborted()
    return bounded(output.text)
  }
  const identity = async (path: string) => {
    if (path.length > 4096 || /[\0\r\n]/.test(path) || await realpath(path) !== path) return fail()
    const value = await stat(path, { bigint: true })
    if (!value.isDirectory()) return fail()
    return { device: String(value.dev), inode: String(value.ino) }
  }
  await identity(policy.mountRoot)
  const mount = storageMountObservation(await run('findmnt', ['--json', '--target', policy.mountRoot, '--output', 'TARGET,FSTYPE,UUID,ID']), policy)
  const directories = []
  for (const root of roots) {
    if (root === policy.mountRoot || !inside(policy.mountRoot, root)) return fail()
    const before = await identity(root)
    const directoryMount = storageMountObservation(await run('findmnt', ['--json', '--target', root, '--output', 'TARGET,FSTYPE,UUID,ID']), policy)
    const member = storageDirectoryObservation(await run('xfs_io', ['-r', '-c', 'stat', root]))
    if (directoryMount.mountId !== mount.mountId || member.projectId !== reservation.projectId || !member.inherits || member.realtime) return fail()
    if (JSON.stringify(before) !== JSON.stringify(await identity(root))) return fail()
    directories.push({ path: root, ...before, ...member })
  }
  const id = reservation.projectId
  const quota = storageQuotaObservation(await run('xfs_quota', ['-x', '-c', 'state -p', policy.mountRoot]),
    await run('xfs_quota', ['-x', '-c', `report -p -b -i -n -N -L ${id} -U ${id}`, policy.mountRoot]), id)
  if (!quota.accounting || !quota.enforcement || quota.hardBytes !== policy.workspace.bytes || quota.hardInodes !== policy.workspace.inodes) return fail()
  // This is a point-in-time observation, not proof against later host changes or a substitute for pre-exec fencing.
  return { ...mount, projectId: id, directories, quota, observedAt: new Date().toISOString() }
}
