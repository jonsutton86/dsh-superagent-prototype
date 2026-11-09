/** Backend-neutral, bounded Session exports. Harness retains ownership of its log format and replay semantics. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { assertContiguous, assertVersion, materializeCreateHeader, validateStoredEvents, type SessionHandle,
  type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { privateInput } from './crypto.ts'

export interface SessionArchive {
  id: string; header: SessionHeader; inheritedEventCount: number; eventCount: number; sha256: string; bytes: number; member: string
}
const hash = () => createHash('sha256')
const line = (value: unknown) => JSON.stringify(value) + '\n'
// Harness's cold reader may materialize the absent delegation-depth default.
const comparableHeader = (header: SessionHeader) => ({ ...header, delegationDepth: header.delegationDepth ?? 0 })

/** Claim all selected writers before reading any history. The caller holds the coordinator's state lock first. */
export async function ownSessions(persistence: SessionPersistence, roots: readonly string[], signal: AbortSignal): Promise<SessionHandle[]> {
  const snapshots = await persistence.list({ signal }), selected = new Set(roots)
  for (let changed = true; changed;) {
    changed = false
    for (const { header } of snapshots) if (header.parentSession && selected.has(header.parentSession) && !selected.has(header.id)) {
      selected.add(header.id); changed = true
    }
  }
  const handles: SessionHandle[] = []
  try {
    for (const { header } of snapshots.filter(item => selected.has(item.header.id)).sort((a, b) => a.header.id.localeCompare(b.header.id)))
      handles.push(await persistence.open(header.id, 'write', { signal }))
    return handles
  } catch (error) { await Promise.allSettled(handles.map(handle => handle.close())); throw error }
}

/** Export a held writer as logical JSONL without depending on JSONL, cloud, or another backend's physical layout. */
export async function exportSession(handle: SessionHandle, file: string, member: string, signal: AbortSignal): Promise<SessionArchive> {
  await handle.flush({ signal })
  const header = materializeCreateHeader(handle.header); assertVersion(header)
  const digest = hash(), output = await open(file, 'wx', 0o600)
  let eventCount = 0, bytes = 0
  const write = async (value: unknown) => { const text = line(value); digest.update(text); bytes += Buffer.byteLength(text); await output.writeFile(text) }
  try {
    await write({ header, inheritedEventCount: handle.inheritedEventCount })
    for (;;) {
      signal.throwIfAborted()
      const page = await handle.read(eventCount, 128, { signal })
      if (!page.events.length) break
      const events = validateStoredEvents(header, structuredClone([...page.events])); assertContiguous(header.id, events, eventCount)
      for (const event of events) await write(event)
      eventCount += events.length
    }
    if (handle.inheritedEventCount > eventCount) throw new Error('Session inherited prefix exceeds its exported history')
    await output.sync()
    return { id: header.id, header, inheritedEventCount: handle.inheritedEventCount, eventCount, sha256: digest.digest('hex'), bytes, member }
  } finally { await output.close() }
}

/** Validate the entire authenticated archive before creating a Session or appending any event to a destination backend. */
export async function inspectSession(file: string, expected: SessionArchive, signal: AbortSignal): Promise<void> {
  await scanSession(file, expected, signal)
}

/** Visit bounded validated pages, then authenticate the entire archive; callers must discard results if this rejects. */
export async function scanSession(file: string, expected: SessionArchive, signal: AbortSignal,
  visit?: (events: SessionEvent[], offset: number) => Promise<void>): Promise<void> {
  let count = 0, bytes = 0, metadata = false
  let pending: SessionEvent[] = []
  const digest = hash(), input = privateInput(file, signal), lines = createInterface({ input, crlfDelay: Infinity })
  input.on('data', chunk => { digest.update(chunk); bytes += Buffer.byteLength(chunk) })
  try {
    for await (const text of lines) {
      signal.throwIfAborted()
      const value = JSON.parse(text)
      if (!metadata) {
        const header = materializeCreateHeader(value.header); assertVersion(header)
        if (!isDeepStrictEqual(header, expected.header) || header.id !== expected.id || value.inheritedEventCount !== expected.inheritedEventCount)
          throw new Error('Session archive metadata differs from its checkpoint')
        metadata = true; continue
      }
      validateStoredEvents(expected.header, [value]); assertContiguous(expected.header.id, [value], count++)
      if (visit) {
        pending.push(value)
        if (pending.length === 128) { await visit(pending, count - pending.length); pending = [] }
      }
    }
    if (visit && pending.length) await visit(pending, count - pending.length)
  } finally { lines.close(); input.destroy() }
  if (!metadata || count !== expected.eventCount || expected.inheritedEventCount > count || bytes !== expected.bytes || digest.digest('hex') !== expected.sha256)
    throw new Error('Session archive does not match its checkpoint digest and offsets')
}

export interface SessionBackendVerification { sessions: number; events: number }

/** Hold every restored writer while comparing the actual backend with authenticated logical history. */
export async function withVerifiedSessionBackend<T>(persistence: SessionPersistence, directory: string, expected: readonly SessionArchive[], signal: AbortSignal,
  action: (verified: SessionBackendVerification, recheck: () => Promise<void>) => Promise<T>): Promise<T> {
  const selected = new Map(expected.map(session => [session.id, session])), identity = persistence.identity
  if (!expected.length || selected.size !== expected.length) throw new Error('Destination Session verification requires a unique nonempty checkpoint set')
  const recheck = async () => {
    signal.throwIfAborted()
    if (persistence.identity !== identity) throw new Error('Destination Session backend changed during verification')
    const snapshots = await persistence.list({ signal }), found = new Set<string>()
    for (const { header } of snapshots) {
      const original = selected.get(header.id)
      if (original) {
        if (found.has(header.id) || !isDeepStrictEqual(comparableHeader(header), comparableHeader(original.header)))
          throw new Error('Destination Session immutable metadata differs from the checkpoint')
        found.add(header.id)
      } else if (header.parentSession && selected.has(header.parentSession))
        throw new Error('Destination Session backend contains an extra related descendant')
    }
    if (found.size !== selected.size) throw new Error('Destination Session backend is missing checkpoint history')
    if (persistence.identity !== identity) throw new Error('Destination Session backend changed during verification')
    signal.throwIfAborted()
  }
  // Validate complete archived history before interacting with destination writers.
  for (const session of expected) await inspectSession(join(directory, session.member), session, signal)
  await recheck()
  const handles: SessionHandle[] = []
  try {
    for (const session of [...expected].sort((a, b) => a.id.localeCompare(b.id))) {
      signal.throwIfAborted()
      const handle = await persistence.open(session.id as SessionId, 'write', { signal }); handles.push(handle)
      if (handle.id !== session.id || handle.access !== 'write' || !isDeepStrictEqual(comparableHeader(handle.header), comparableHeader(session.header)))
        throw new Error('Destination Session immutable metadata differs from the checkpoint')
      if (handle.inheritedEventCount !== session.inheritedEventCount) throw new Error('Destination Session inherited prefix differs from the checkpoint')
    }
    for (const handle of handles) {
      const session = selected.get(handle.id)!
      await scanSession(join(directory, session.member), session, signal, async (events, offset) => {
        for (let index = 0; index < events.length;) {
          signal.throwIfAborted()
          const page = await handle.read(offset + index, events.length - index, { signal })
          if (!page.events.length) throw new Error('Destination Session history is shorter than the checkpoint')
          const actual = validateStoredEvents(handle.header, structuredClone([...page.events])); assertContiguous(handle.id, actual, offset + index)
          if (actual.length > events.length - index || !isDeepStrictEqual(actual, events.slice(index, index + actual.length)))
            throw new Error('Destination Session history diverges from the checkpoint')
          index += actual.length
        }
      })
      if ((await handle.read(session.eventCount, 1, { signal })).events.length) throw new Error('Destination Session history is newer than the checkpoint')
    }
    await recheck()
    return await action({ sessions: expected.length, events: expected.reduce((total, session) => total + session.eventCount, 0) }, recheck)
  } finally {
    const closed = await Promise.allSettled(handles.map(handle => handle.close()))
    const errors = closed.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Destination Session writer release failed')
  }
}

/** Restore into an empty backend or resume an interrupted exact-prefix import; never overwrite or truncate a Session. */
export async function importSession(persistence: SessionPersistence, file: string, expected: SessionArchive, signal: AbortSignal): Promise<void> {
  // Import from a private snapshot, so changing the caller's file after validation cannot alter appended history.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-import-')), snapshot = join(directory, 'archive.jsonl')
  try {
    await pipeline(privateInput(file, signal), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }), { signal })
    await importSnapshot(persistence, snapshot, expected, signal)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

async function importSnapshot(persistence: SessionPersistence, file: string, expected: SessionArchive, signal: AbortSignal): Promise<void> {
  await inspectSession(file, expected, signal)
  const id = expected.id as SessionId, present = await persistence.stat(id, { signal })
  if (present && !isDeepStrictEqual(comparableHeader(present.header), comparableHeader(expected.header))) throw new Error('A destination Session already has different immutable metadata')
  const handle = present ? await persistence.open(id, 'write', { signal }) : await persistence.create(expected.header, {
    inheritedEventCount: expected.inheritedEventCount as SessionLogOffset, signal })
  const input = createReadStream(file, { signal }), lines = createInterface({ input, crlfDelay: Infinity })
  let first = true, offset = 0, pending: SessionEvent[] = []
  const flush = async () => {
    if (!pending.length) return
    const existing = (await handle.read(offset, pending.length, { signal })).events
    for (let i = 0; i < existing.length; i++) if (!isDeepStrictEqual(existing[i], pending[i]))
      throw new Error('A destination Session diverges from the checkpoint; overwrite is forbidden')
    if (existing.length < pending.length) await handle.append(pending.slice(existing.length), { signal })
    offset += pending.length; pending = []
  }
  try {
    if (handle.inheritedEventCount !== expected.inheritedEventCount) throw new Error('The destination Session inherited prefix differs')
    for await (const text of lines) {
      if (first) { first = false; continue }
      // Seed history and its boundary must enter the backend in one append. A partial inherited prefix is not a valid cold log.
      const pageSize = offset === 0 ? Math.max(128, expected.inheritedEventCount + 1) : 128
      pending.push(JSON.parse(text)); if (pending.length === pageSize) await flush()
    }
    await flush()
    if ((await handle.read(offset, 1, { signal })).events.length) throw new Error('The destination Session is newer than the checkpoint; truncation is forbidden')
    await handle.flush({ signal })
  } finally { lines.close(); input.destroy(); await handle.close() }
}
