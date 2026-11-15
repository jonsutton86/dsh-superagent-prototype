import { it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, link, rm, chmod } from 'node:fs/promises'
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
