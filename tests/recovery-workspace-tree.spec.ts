import { verifyWorkspaceRecovery } from '../src/recovery/workspace-verify.ts'
import { createHash } from 'node:crypto'
import { captureWorkspaceRecovery } from '../src/recovery/workspace-archive.ts'
import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, link, rm, chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inventoryWorkspaceRecovery } from '../src/recovery/workspace-tree.ts'
const budget = { maxEntries: 100, maxBytes: 10 * 1024 * 1024 }
it('includes Git history, original modes, symbolic links and internal hard-link relationships', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-tree-'))
  try {
    await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(root, 'tool'), 'original'); await chmod(join(root, 'tool'), 0o751)
    await link(join(root, 'tool'), join(root, 'tool-copy')); await symlink('../absent', join(root, 'unresolved'))
    const result = await inventoryWorkspaceRecovery(root, budget)
    expect(result.entries).toContainEqual(expect.objectContaining({ path: '.git/HEAD', kind: 'file' }))
    expect(result.entries).toContainEqual(expect.objectContaining({ path: 'tool', mode: 0o751 }))
    expect(result.entries).toContainEqual(expect.objectContaining({ path: 'tool-copy', hardlinkTo: 'tool' }))
    expect(result.entries).toContainEqual(expect.objectContaining({ path: 'unresolved', kind: 'symlink', target: '../absent' }))
    expect(result).toMatchObject({ contentArchived: false, executionQuiescenceVerified: false, restoreVerified: false })
    expect((await inventoryWorkspaceRecovery(root, budget)).sha256).toBe(result.sha256)
    await writeFile(join(root, '.git', 'HEAD'), 'changed'); expect((await inventoryWorkspaceRecovery(root, budget)).sha256).not.toBe(result.sha256)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('refuses omitted external hard-link relationships, budgets and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-tree-limits-'))
  try {
    await mkdir(join(root, 'workspace')); await writeFile(join(root, 'outside'), Buffer.alloc(131073))
    await link(join(root, 'outside'), join(root, 'workspace', 'linked'))
    await expect(inventoryWorkspaceRecovery(join(root, 'workspace'), budget)).rejects.toThrow('outside')
    await expect(inventoryWorkspaceRecovery(root, { ...budget, maxBytes: 1 })).rejects.toThrow('byte budget')
    await expect(inventoryWorkspaceRecovery(root, { ...budget, maxEntries: 1 })).rejects.toThrow('entry budget')
    await expect(inventoryWorkspaceRecovery(root, budget, AbortSignal.abort())).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('archives exact full content in private members and refuses existing or nested destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-archive-'))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
    await mkdir(join(source, '.git')); await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const bytes = Buffer.alloc(200003, 123); await writeFile(join(source, 'large'), bytes)
    await link(join(source, 'large'), join(source, 'alias')); await symlink('large', join(source, 'link'))
    const result = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    expect(await verifyWorkspaceRecovery(result.path)).toMatchObject({ contentVerified: true, sourceAuthorityVerified: false, restoreVerified: false })
    expect(result.manifest).toMatchObject({ contentArchived: true, executionQuiescenceVerified: false, restoreVerified: false })
    for (const member of result.manifest.content) {
      const saved = await readFile(join(result.path, member.member))
      expect(saved).toEqual(await readFile(join(source, member.path)))
      expect(createHash('sha256').update(saved).digest('hex')).toBe(member.sha256)
      expect((await stat(join(result.path, member.member))).mode & 0o777).toBe(0o600)
    }
    expect(result.manifest.entries.find(entry => entry.path === 'large')?.hardlinkTo).toBe('alias')
    expect(JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8'))).toEqual(result.manifest)
    await expect(captureWorkspaceRecovery(source, result.path, budget)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(captureWorkspaceRecovery(source, join(source, 'archive'), budget)).rejects.toThrow('separate')
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('retains failed capture bytes without a completed manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-archive-failed-'))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
    await writeFile(join(root, 'external'), 'retained'); await link(join(root, 'external'), join(source, 'linked'))
    const target = join(root, 'archive')
    await expect(captureWorkspaceRecovery(source, target, budget)).rejects.toThrow('outside')
    expect(await readFile(join(target, 'content-0.bin'), 'utf8')).toBe('retained')
    await expect(readFile(join(target, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('rejects changed content, unbound members and rehashed invalid tree relationships', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-archive-invalid-'))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'original')
    const saved = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const member = saved.manifest.content[0]!, contentPath = join(saved.path, member.member)
    await writeFile(contentPath, 'modified')
    await expect(verifyWorkspaceRecovery(saved.path)).rejects.toThrow('digest')
    await writeFile(contentPath, 'original')
    await writeFile(join(saved.path, 'extra'), 'unbound', { mode: 0o600 })
    await expect(verifyWorkspaceRecovery(saved.path)).rejects.toThrow('unbound')
    await rm(join(saved.path, 'extra'))
    const malformed = structuredClone(saved.manifest)
    malformed.entries[1]!.path = '../escape'
    malformed.sha256 = createHash('sha256').update(JSON.stringify({ version: 1, entries: malformed.entries, bytes: malformed.bytes })).digest('hex')
    await writeFile(join(saved.path, 'manifest.json'), JSON.stringify(malformed))
    await expect(verifyWorkspaceRecovery(saved.path)).rejects.toThrow()
    malformed.entries[1]!.path = 'missing-parent/file'
    malformed.sha256 = createHash('sha256').update(JSON.stringify({ version: 1, entries: malformed.entries, bytes: malformed.bytes })).digest('hex')
    await writeFile(join(saved.path, 'manifest.json'), JSON.stringify(malformed))
    await expect(verifyWorkspaceRecovery(saved.path)).rejects.toThrow('directory relationships')
  } finally { await rm(root, { recursive: true, force: true }) }
})
