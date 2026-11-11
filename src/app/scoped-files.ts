/** Read-only access to operator attachment files and the ticket directory. Writes stay a copy into that directory. */
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { Store } from './store.ts'
import type { Ticket } from '../core/index.ts'

const LIMIT = 64 * 1024
const COPY_LIMIT = 64 * 1024 * 1024

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.split(sep).includes('..'))
}

export function recordedAttachments(store: Pick<Store, 'triggers'>, ticket: Ticket): string[] {
  const ids = [ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])]
  const paths = ids.flatMap(id => {
    const list = store.triggers.get(id)?.meta.attachments
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  })
  return [...new Set(paths)]
}

/** Copies attachment bytes into `<ticket>/attachments` so the filesystem and subprocess providers read the same file. */
export async function stageAttachments(directory: string, paths: readonly string[]): Promise<void> {
  if (!paths.length) return
  const root = await realpath(directory)
  const destDir = join(root, 'attachments')
  await mkdir(destDir, { recursive: true })
  for (const source of paths) {
    try {
      if (source.includes('\0')) continue
      const from = await realpath(source)
      if (inside(root, from)) continue
      const info = await stat(from)
      if (!info.isFile() || info.size > COPY_LIMIT) continue
      const name = basename(from).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment'
      const dest = join(destDir, name)
      await copyFile(from, dest, constants.COPYFILE_EXCL)
    } catch { /* An existing copy or an unreadable attachment stays unchanged. */ }
  }
}

export async function readScopedFile(directory: string, attachments: readonly string[], requestPath: string, offset = 0): Promise<{ path: string; content: string; bytes: number; next_offset: number | null }> {
  if (!requestPath || requestPath.includes('\0')) throw new Error('That file is outside this ticket')
  const root = await realpath(directory)
  const target = await realpath(requestPath)
  const allowed = inside(root, target) || (await Promise.all(attachments.map(async path => {
    try { return await realpath(path) === target } catch { return false }
  }))).some(Boolean)
  if (!allowed) throw new Error('That file is outside this ticket')
  const info = await stat(target)
  if (!info.isFile()) throw new Error('That file is outside this ticket')
  if (info.size > LIMIT) throw new Error('File exceeds 64 KiB')
  const bytes = await readFile(target)
  if (bytes.includes(0)) throw new Error('Only text files can be read here')
  const text = bytes.toString('utf8')
  const start = Math.min(offset, text.length)
  const content = text.slice(start, start + 4000)
  const next = start + content.length
  return { path: target, content, bytes: info.size, next_offset: next < text.length ? next : null }
}
