import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RemoteJournal } from '../src/remote/journal.ts'

const faults = vi.hoisted(() => ({ sync: undefined as undefined | 'file' | 'published-directory', key: '' }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, fsyncSync(fd: number) {
    const stat = fs.fstatSync(fd)
    if ((faults.sync === 'file' && stat.isFile() && stat.size === 43)
      || (faults.sync === 'published-directory' && stat.isDirectory() && fs.existsSync(faults.key)))
      throw Object.assign(new Error('Simulated storage sync failure'), { code: 'EIO' })
    return fs.fsyncSync(fd)
  } }
})

const roots: string[] = [], journals: RemoteJournal[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentic journal ')); roots.push(root)
  const control = join(root, 'control'), workspace = join(root, 'workspace')
  const open = () => { const journal = new RemoteJournal(control, workspace); journals.push(journal); return journal }
  return { root, control, open }
}
afterEach(() => {
  faults.sync = undefined; faults.key = ''
  for (const journal of journals.splice(0)) journal.close()
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

it('retains endpoint and grant identity through a journal reopen with private credentials', () => {
  const h = fixture(), first = h.open(), id = first.id, grant = first.credential('saved-grant', 1)
  const admin = readFileSync(join(h.control, 'admin.token'), 'utf8')
  first.close()
  const reopened = h.open()
  expect(reopened.id).toBe(id)
  expect(reopened.authenticate('Bearer ' + grant)).toEqual({ role: 'grant', id: 'saved-grant', epoch: 1 })
  expect(reopened.authenticate('Bearer ' + admin)).toEqual({ role: 'admin' })
  for (const name of ['signing.key', 'admin.token']) expect(statSync(join(h.control, name)).mode & 0o777).toBe(0o600)
})

it.each(['signing.key', 'admin.token'])('refuses missing or empty %s on an existing endpoint without replacement', name => {
  const h = fixture(); h.open().close()
  const file = join(h.control, name), database = readFileSync(join(h.control, 'endpoint.sqlite'))
  unlinkSync(file)
  expect(h.open).toThrow('Missing endpoint credential file')
  expect(existsSync(file)).toBe(false)
  writeFileSync(file, '', { mode: 0o600 })
  expect(h.open).toThrow('Credential must be a private')
  expect(statSync(file).size).toBe(0)
  expect(readFileSync(join(h.control, 'endpoint.sqlite')).equals(database)).toBe(true)
})

it.each(['file', 'published-directory'] as const)('refuses readiness on %s sync failure and releases the journal lock for recovery', point => {
  const h = fixture(); faults.key = join(h.control, 'signing.key'); faults.sync = point
  expect(h.open).toThrow('Simulated storage sync failure')
  expect(existsSync(join(h.control, 'endpoint.sqlite'))).toBe(false)
  const published = existsSync(faults.key) ? readFileSync(faults.key) : undefined
  faults.sync = undefined
  const journal = h.open()
  expect(journal.id).toMatch(/^[a-f0-9-]{36}$/)
  if (published) expect(readFileSync(faults.key).equals(published)).toBe(true)
})

it.each(['symbolic', 'hard'] as const)('refuses a %s credential link without changing its target', kind => {
  const h = fixture(); h.open().close()
  const file = join(h.control, 'signing.key'), target = join(h.root, 'original-credential')
  writeFileSync(target, readFileSync(file), { mode: 0o600 }); unlinkSync(file)
  if (kind === 'symbolic') symlinkSync(target, file); else linkSync(target, file)
  const before = readFileSync(target)
  expect(h.open).toThrow()
  expect(readFileSync(target).equals(before)).toBe(true)
  expect(statSync(target).mode & 0o777).toBe(0o600)
})
