import { mkdtemp, mkdir, writeFile, readFile, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { SnapshotSpec } from '../src/verification/model.ts'
import { captureSnapshot, sameSnapshotFiles, validateSnapshot } from '../src/verification/snapshot.ts'
import { discardSnapshot } from '../src/verification/runner.ts'
const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await discardSnapshot(path) })
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'verified-snapshot-')); cleanup.push(root); const source = join(root, 'source'); await mkdir(source); return { root, source, copy: join(root, 'copy') } }
const spec = () => SnapshotSpec.parse({ repository: 'none' }), signal = () => AbortSignal.timeout(10000)
it('captures actual bytes and executable bits, preserves internal links and detects changed content', async () => {
  const f = await fixture(); await mkdir(join(f.source, 'scripts')); await writeFile(join(f.source, 'scripts/check'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await symlink('scripts/check', join(f.source, 'check')); await writeFile(join(f.source, 'artifact'), Buffer.from([0, 255, 42]))
  const original = await captureSnapshot(f.source, spec(), signal(), f.copy), copy = await captureSnapshot(f.copy, spec(), signal())
  expect(validateSnapshot(original)).toEqual(original); expect(sameSnapshotFiles(original, copy)).toBe(true)
  expect(original.entries.find(item => item.path === 'check')).toMatchObject({ kind: 'symlink', target: 'scripts/check' })
  expect(original.entries.find(item => item.path === 'scripts/check')!.executable).toBe(true)
  expect(await readFile(join(f.copy, 'artifact'))).toEqual(Buffer.from([0, 255, 42]))
  await writeFile(join(f.source, 'artifact'), 'new'); expect((await captureSnapshot(f.source, spec(), signal())).hash).not.toBe(original.hash)
  expect((await captureSnapshot(f.copy, spec(), signal())).hash).toBe(copy.hash)
  expect(() => validateSnapshot({ ...original, bytes: 1 })).toThrow('totals')
  expect(() => validateSnapshot({ ...original, entries: original.entries.map(entry => entry.path === 'artifact' ? { ...entry, hash: '0'.repeat(64) } : entry) })).toThrow('digest')
})
it('captures Git commit/tree identity and dirty working content without treating a model report as evidence', async () => {
  const f = await fixture(), git = (...args: string[]) => execFileSync('git', args, { cwd: f.source, encoding: 'utf8' }).trim()
  git('init', '-q'); await writeFile(join(f.source, 'source.txt'), 'committed'); git('add', 'source.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial')
  await writeFile(join(f.source, 'source.txt'), 'dirty')
  const manifest = await captureSnapshot(f.source, SnapshotSpec.parse({ repository: 'required' }), signal(), f.copy)
  expect(manifest.repository).toMatchObject({ commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') })
  expect(manifest.entries.some(item => item.path.startsWith('.git'))).toBe(false)
  expect(manifest.entries[0]!.hash).toBe(createHash('sha256').update('dirty').digest('hex'))
  git('add', 'source.txt'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Changed')
  expect((await captureSnapshot(f.source, SnapshotSpec.parse({ repository: 'required' }), signal())).hash).not.toBe(manifest.hash)
})
it('refuses escaped/excluded links, incomplete bounds, traversal and missing required repositories', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'outside'), 'private'); await symlink('../outside', join(f.source, 'escape'))
  await expect(captureSnapshot(f.source, spec(), signal())).rejects.toThrow('leaves')
  await expect(captureSnapshot(f.source, SnapshotSpec.parse({ repository: 'required' }), signal())).rejects.toThrow('requires a Git')
  expect(() => SnapshotSpec.parse({ exclude: ['../outside'] })).toThrow()
  const g = await fixture(); await mkdir(join(g.source, 'dependency')); await writeFile(join(g.source, 'dependency/file'), 'dependency'); await symlink('dependency/file', join(g.source, 'link'))
  await expect(captureSnapshot(g.source, SnapshotSpec.parse({ exclude: ['dependency'] }), signal())).rejects.toThrow('excluded')
  await expect(captureSnapshot(g.source, { ...spec(), maxFiles: 1 }, signal())).rejects.toThrow('path limit')
  await expect(captureSnapshot(g.source, { ...spec(), maxBytes: 1 }, signal())).rejects.toThrow('byte limit')
  await chmod(g.source, 0o700)
})
