/**
 * Read-only access to operator attachments and to a ticket directory.
 * Workers may also write inside the ticket directory through the preset's file tools; this module never writes except to
 * copy attachments into that directory so the file tools and the shell see the same bytes.
 */
import { closeSync, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { Ticket, Trigger } from '../core/index.ts'
import { textPage } from './cards.ts'
import { pathsOf } from '../sources/operator.ts'
import type { Store } from './store.ts'

const PAGE = 64 * 1024
const COPY_LIMIT = 64 * 1024 * 1024

type Records = Pick<Store, 'triggers' | 'tickets' | 'read'>

function triggersFor(store: Records, ticketId?: string): Trigger[] {
  if (!ticketId) return store.read.recentTriggers(0, 200)
  const ticket = store.tickets.get(ticketId)
  if (!ticket) return []
  const ids = new Set([...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input =>
    input.kind === 'trigger' || input.kind === 'resumed' ? [input.triggerId] : [])])
  return [...ids].flatMap(id => store.triggers.get(id) ?? [])
}

/** Directories this caller may read: its own ticket, or every ticket directory for the main Session. */
export function readableDirectories(store: Records, ticketId?: string): string[] {
  if (ticketId) {
    const directory = store.tickets.get(ticketId)?.execution?.directory
    return directory ? [directory] : []
  }
  return store.tickets.list().flatMap(ticket => ticket.execution?.directory ? [ticket.execution.directory] : [])
}

/** Attachment paths this caller may read: a worker's own triggers, or recent triggers for the main Session. */
export function readableAttachments(store: Records, ticketId?: string): string[] {
  return [...new Set(triggersFor(store, ticketId).flatMap(pathsOf))]
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The real path of a regular file the caller may read.
 * @throws when the path is outside the caller's attachments and ticket directories, or is not a regular file.
 */
export function resolveReadable(request: string, attachments: readonly string[], directories: readonly string[]): string {
  if (!isAbsolute(request)) throw new Error('The path must be absolute')
  let real: string
  try { real = realpathSync(request) } catch { throw new Error('File is not available') }
  if (!lstatSync(real).isFile()) throw new Error('Only a regular file can be read')
  for (const path of attachments) {
    try { if (realpathSync(path) === real) return real } catch { /* The attachment is gone. */ }
  }
  for (const directory of directories) {
    try { if (inside(realpathSync(directory), real)) return real } catch { /* The ticket directory is gone. */ }
  }
  throw new Error('This file is outside the attachments and the ticket directory')
}

/** One page of a text file, at most 64 KiB of the file. */
export function readTextFile(path: string, offset: number, limit?: number) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, PAGE))
    readSync(fd, buf, 0, buf.length, 0)
    if (buf.includes(0)) throw new Error('Only text files can be read')
    const text = buf.toString('utf8') + (size > PAGE ? `\n[truncated at ${PAGE} bytes]` : '')
    return textPage(path, text, offset, Math.min(limit ?? PAGE, PAGE))
  } finally { closeSync(fd) }
}

/** Attachment paths of the triggers a ticket already holds, which the assignment copies into its directory. */
export function attachmentPaths(store: Pick<Store, 'triggers' | 'tickets'>, ticket: Ticket): string[] {
  const ids = new Set([...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input =>
    input.kind === 'trigger' || input.kind === 'resumed' ? [input.triggerId] : [])])
  return [...new Set([...ids].flatMap(id => pathsOf(store.triggers.get(id))))]
}

/**
 * Copies attachment files into `<directory>/attachments` so the ticket's file tools and shell, whose cwd is the ticket
 * directory, see the same bytes. An existing copy is left as it is. A missing file, a directory, or a file over 64 MiB is skipped.
 */
export function stageAttachments(directory: string, paths: readonly string[]): string[] {
  if (!paths.length) return []
  const destDir = join(directory, 'attachments')
  mkdirSync(destDir, { recursive: true })
  const staged: string[] = []
  paths.forEach((path, index) => {
    let info: ReturnType<typeof statSync>
    try { info = statSync(path) } catch { return }
    if (!info.isFile() || info.size > COPY_LIMIT) return
    const leaf = basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file'
    const dest = join(destDir, `${index}-${leaf}`)
    try { if (statSync(dest).isFile()) { staged.push(dest); return } } catch { /* Not copied yet. */ }
    copyFileSync(path, dest)
    staged.push(dest)
  })
  return staged
}
