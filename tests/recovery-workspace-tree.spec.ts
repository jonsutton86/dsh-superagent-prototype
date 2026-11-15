import { verifyHeldWorkspaceCandidate } from '../src/recovery/workspace-candidate.ts'
import { stageWorkspaceRecovery } from '../src/recovery/workspace-stage.ts'
import { validateWorkspaceMembers, verifyWorkspaceMembers } from '../src/recovery/workspace-members.ts'
import { createRecoveryKey } from '../src/recovery/crypto.ts'
import { encryptWorkspaceRecovery, verifyEncryptedWorkspaceRecovery } from '../src/recovery/workspace-encrypted.ts'
import { verifyWorkspaceRecovery } from '../src/recovery/workspace-verify.ts'
import { createHash } from 'node:crypto'
import { captureWorkspaceRecovery } from '../src/recovery/workspace-archive.ts'
import { it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, link, rm, chmod, readFile, stat, readdir, realpath, copyFile, readlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inventoryWorkspaceRecovery } from '../src/recovery/workspace-tree.ts'
const stageFault = vi.hoisted(() => ({ abort: undefined as AbortController | undefined, replaceRoot: undefined as string | undefined, capacityBlocked: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, async statfs(...args: Parameters<typeof real.statfs>) {
    const result = await real.statfs(...args)
    return stageFault.capacityBlocked ? { ...result, bavail: 0n } : result
  }, async lstat(...args: Parameters<typeof real.lstat>) {
    const result = await real.lstat(...args)
    if (stageFault.replaceRoot === args[0]) {
      const root = stageFault.replaceRoot; stageFault.replaceRoot = undefined
      await real.rename(root, root + '-retired'); await real.mkdir(root, { mode: 0o700 })
      await real.writeFile(join(root, 'replacement.txt'), 'replacement content')
    }
    return result
  }, async copyFile(...args: Parameters<typeof real.copyFile>) {
    await real.copyFile(...args)
    const abort = stageFault.abort; stageFault.abort = undefined; abort?.abort()
  } }
})
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

it('hands off verified private copies despite later source replacement and always removes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-archive-handoff-'))
  let copied = ''
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'verified')
    const saved = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const member = saved.manifest.content[0]!
    await verifyWorkspaceRecovery(saved.path, new AbortController().signal, async directory => {
      copied = directory
      await writeFile(join(saved.path, member.member), 'replaced')
      expect(await readFile(join(directory, member.member), 'utf8')).toBe('verified')
      expect((await stat(join(directory, member.member))).mode & 0o777).toBe(0o600)
      expect((await verifyWorkspaceRecovery(directory)).contentVerified).toBe(true)
    })
    await expect(stat(copied)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(saved.path, member.member), 'verified')
    await expect(verifyWorkspaceRecovery(saved.path, new AbortController().signal, async directory => {
      copied = directory; throw new Error('consumer failed')
    })).rejects.toThrow('consumer failed')
    await expect(stat(copied)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('encrypts verified workspace bytes and refuses wrong keys or changed ciphertext', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-archive-encrypted-')))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 })
    await writeFile(join(source, 'private-name'), 'private workspace content retained exactly')
    const plain = await captureWorkspaceRecovery(source, join(root, 'plain'), budget)
    const key = join(root, 'key'), wrong = join(root, 'wrong'); createRecoveryKey(key); createRecoveryKey(wrong)
    const encrypted = await encryptWorkspaceRecovery(plain.path, join(root, 'encrypted'), key)
    const checked = await verifyEncryptedWorkspaceRecovery(encrypted.path, key, new AbortController().signal, async directory => {
      expect(await readFile(join(directory, 'content-0.bin'), 'utf8')).toBe('private workspace content retained exactly')
    })
    expect(checked).toMatchObject({ encryptionVerified: true, contentVerified: true, sourceAuthorityVerified: false, restoreVerified: false })
    expect(checked.manifest.entries).toEqual(plain.manifest.entries)
    for (const name of await readdir(encrypted.path)) expect((await readFile(join(encrypted.path, name))).includes(Buffer.from('private workspace content retained exactly'))).toBe(false)
    await expect(verifyEncryptedWorkspaceRecovery(encrypted.path, wrong)).rejects.toThrow()
    const cipher = join(encrypted.path, 'content-0.bin'), data = await readFile(cipher); data[0] = data[0]! ^ 1; await writeFile(cipher, data)
    await expect(verifyEncryptedWorkspaceRecovery(encrypted.path, key)).rejects.toThrow()
    await expect(encryptWorkspaceRecovery(plain.path, encrypted.path, key)).rejects.toMatchObject({ code: 'EEXIST' })
    const embeddedKey = join(source, 'embedded-key'); createRecoveryKey(embeddedKey)
    await expect(encryptWorkspaceRecovery(plain.path, join(root, 'refused-key'), embeddedKey)).rejects.toThrow('original workspace')
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('verifies authenticated workspace member mapping and rejects role, source and digest substitutions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-member-binding-')))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'original')
    const archive = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const members = join(root, 'members'); await mkdir(members, { mode: 0o700 })
    const files: { member: string; kind: string; bytes: number; sha256: string }[] = []
    for (const [name, kind] of [['manifest.json', 'workspace-manifest'], ['content-0.bin', 'workspace-content']] as const) {
      const member = `member-${files.length}.bin`, bytes = await readFile(join(archive.path, name))
      await copyFile(join(archive.path, name), join(members, member))
      files.push({ member, kind, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    const bindings = [{ source, manifestMember: 'member-0.bin', content: [{ name: 'content-0.bin', member: 'member-1.bin' }] }]
    await expect(verifyWorkspaceMembers(members, bindings, files, new AbortController().signal)).resolves.toEqual([{ member: 'member-0.bin', hash: archive.manifest.sha256 }])
    expect(() => validateWorkspaceMembers([bindings[0]!, bindings[0]!], files)).toThrow('Duplicate recovery workspace source')
    expect(() => validateWorkspaceMembers(undefined, files)).toThrow('Unbound')
    expect(() => validateWorkspaceMembers(bindings, [files[0]!, { ...files[1]!, kind: 'session' }])).toThrow('binding differs')
    expect(() => validateWorkspaceMembers([{ ...bindings[0]!, content: [{ name: '../escape', member: 'member-1.bin' }] }], files)).toThrow()
    await expect(verifyWorkspaceMembers(members, [{ ...bindings[0]!, source: '/another-workspace' }], files, new AbortController().signal)).rejects.toThrow('source differs')
    await expect(verifyWorkspaceMembers(members, bindings, [files[0]!, { ...files[1]!, sha256: 'f'.repeat(64) }], new AbortController().signal)).rejects.toThrow('authenticated digest')
    await expect(verifyWorkspaceMembers(members, bindings, files, AbortSignal.abort())).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('reconstructs Git bytes and links in a new held candidate without applying authority or original permissions', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-workspace-held-')))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await mkdir(join(source, '.git'))
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(source, 'tool'), 'original'); await chmod(join(source, 'tool'), 0o755)
    await link(join(source, 'tool'), join(source, 'alias')); await symlink('../outside', join(source, 'external-link'))
    const archive = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const staged = await stageWorkspaceRecovery(archive.path, join(root, 'held'))
    expect(staged).toMatchObject({ state: 'held', contentReconstructed: true, metadataApplied: false, executionOwnership: false, restoreVerified: false })
    expect(await readFile(join(staged.workspace, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(await readlink(join(staged.workspace, 'external-link'))).toBe('../outside')
    expect((await stat(join(staged.workspace, 'tool'))).ino).toBe((await stat(join(staged.workspace, 'alias'))).ino)
    expect((await stat(join(staged.workspace, 'tool'))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(staged.path, 'source-manifest.json'), 'utf8')).entries.find((item: { path: string }) => item.path === 'tool').mode).toBe(0o755)
    expect(JSON.parse(await readFile(join(staged.path, 'hold.json'), 'utf8')).state).toBe('held')
    await expect(stageWorkspaceRecovery(archive.path, staged.path)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(stageWorkspaceRecovery(archive.path, join(source, 'nested'))).rejects.toThrow('original source')
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('retains the original preparing hold after cancellation during reconstruction', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-workspace-cancel-')))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'retained')
    const archive = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const abort = new AbortController(), target = join(root, 'held')
    stageFault.abort = abort
    await expect(stageWorkspaceRecovery(archive.path, target, abort.signal)).rejects.toThrow()
    stageFault.abort = undefined
    expect(JSON.parse(await readFile(join(target, 'hold.json'), 'utf8'))).toMatchObject({ state: 'preparing', executionOwnership: false, restoreVerified: false })
    expect(await readFile(join(target, 'workspace', 'file'), 'utf8')).toBe('retained')
    expect(await readFile(join(source, 'file'), 'utf8')).toBe('retained')
    await expect(stageWorkspaceRecovery(archive.path, target)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { stageFault.abort = undefined; await rm(root, { recursive: true, force: true }) }
})


it('refuses changed candidate metadata, exposed modes and replaced workspace roots without mutating the hold', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recovery-candidate-check-')))
  try {
    const source = join(root, 'source'); await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'retained')
    const archive = await captureWorkspaceRecovery(source, join(root, 'archive'), budget)
    const expected = (await verifyWorkspaceRecovery(archive.path)).manifest
    const origin = { checkpointId: '11111111-1111-4111-8111-111111111111', workspaceManifestSHA256: createHash('sha256').update(await readFile(join(archive.path, 'manifest.json'))).digest('hex') }
    const staged = await stageWorkspaceRecovery(archive.path, join(root, 'held'), new AbortController().signal, origin)
    const inspect = () => verifyHeldWorkspaceCandidate(staged.path, expected, origin, new AbortController().signal)
    expect((await inspect()).id).toBe(staged.id)
    const hold = await readFile(join(staged.path, 'hold.json'))
    await chmod(join(staged.workspace, 'file'), 0o644)
    await expect(inspect()).rejects.toThrow('modes changed')
    await chmod(join(staged.workspace, 'file'), 0o600)
    await writeFile(join(staged.path, 'source-manifest.json'), '{}')
    await expect(inspect()).rejects.toThrow('source manifest differs')
    await copyFile(join(archive.path, 'manifest.json'), join(staged.path, 'source-manifest.json'))
    await rename(staged.workspace, join(root, 'saved-workspace')); await symlink(source, staged.workspace)
    await expect(inspect()).rejects.toThrow('root was replaced')
    expect(await readFile(join(staged.path, 'hold.json'))).toEqual(hold)
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('refuses a root replaced after initial identity capture instead of binding replacement bytes to the old inode', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'recovery-root-race-'))), source = join(directory, 'source')
  try {
    await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'original.txt'), 'original content')
    stageFault.replaceRoot = source
    await expect(captureWorkspaceRecovery(source, join(directory, 'archive'), budget)).rejects.toThrow('root changed before inventory')
    await expect(readFile(join(directory, 'archive/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'replacement.txt'), 'utf8')).toBe('replacement content')
    expect(await readFile(join(source + '-retired', 'original.txt'), 'utf8')).toBe('original content')
  } finally { stageFault.replaceRoot = undefined; await rm(directory, { recursive: true, force: true }) }
})


it('refuses staging before creating a candidate when available capacity is insufficient', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'recovery-capacity-refusal-'))), source = join(directory, 'source')
  try {
    await mkdir(source, { mode: 0o700 }); await writeFile(join(source, 'file'), 'content')
    const archive = await captureWorkspaceRecovery(source, join(directory, 'archive'), budget)
    stageFault.capacityBlocked = true
    await expect(stageWorkspaceRecovery(archive.path, join(directory, 'candidate'))).rejects.toThrow('available bytes')
    await expect(stat(join(directory, 'candidate'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, 'file'), 'utf8')).toBe('content')
  } finally { stageFault.capacityBlocked = false; await rm(directory, { recursive: true, force: true }) }
})
