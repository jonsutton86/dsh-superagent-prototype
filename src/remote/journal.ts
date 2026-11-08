import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { RemoteError, type Principal, type RemoteGrant, type RemoteJob, type RemoteOperation, type OutputWindow } from './protocol.ts'

export const timestamp = () => new Date().toISOString()
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const inside = (root: string, child: string): boolean => {
  const path = relative(root, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'))
}
const equal = (left: string, right: string) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())

/** Single-writer endpoint state: credentials, grant generations, command receipts and durable output offsets. */
export class RemoteJournal {
  readonly db: DatabaseSync
  readonly id: string
  private readonly secret: string
  private readonly admin: string
  private readonly release: () => void
  private closed = false
  constructor(readonly directory: string, readonly root: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); mkdirSync(root, { recursive: true, mode: 0o700 })
    const control = realpathSync(directory), workspace = realpathSync(root)
    if (inside(workspace, control) || inside(control, workspace)) throw new Error('Endpoint control state and workspaces must be separate directories')
    chmodSync(directory, 0o700)
    this.release = lockSync(directory, { stale: 30_000 })
    let opened: DatabaseSync | undefined
    try {
      const readSecret = (name: string): string => {
        const file = join(directory, name)
        try { writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        chmodSync(file, 0o600)
        const value = readFileSync(file, 'utf8').trim()
        if (!/^[A-Za-z0-9_-]{43,}$/.test(value)) throw new Error(`Invalid endpoint credential file: ${name}`)
        return value
      }
      this.secret = readSecret('signing.key'); this.admin = readSecret('admin.token')
      this.db = opened = new DatabaseSync(join(directory, 'endpoint.sqlite'))
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS endpoint_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_grant (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_job (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_operation (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_receipt (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_audit (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS remote_output (job TEXT, stream TEXT, data BLOB NOT NULL, total INTEGER NOT NULL, PRIMARY KEY(job,stream));`)
      this.db.prepare('INSERT OR IGNORE INTO endpoint_meta VALUES (?,?)').run('id', randomUUID())
      this.id = String(this.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('id')!.value)
      this.atomic(() => {
        for (const job of this.jobs()) if (job.phase === 'started' || (job.phase === 'settled' && !job.quiescent)) {
          job.phase = 'unknown'; job.quiescent = null; job.error = 'Endpoint restarted before managed-range quiescence was recorded'; this.saveJob(job)
        }
        for (const operation of this.operations()) if (operation.phase === 'started') {
          operation.phase = 'unknown'; this.saveOperation(operation)
        }
      })
    } catch (error) { opened?.close(); this.release(); throw error }
  }
  atomic<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = run(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  credential(id: string, epoch: number): string {
    const body = `${id}.${epoch}`
    return `grant.${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`
  }
  authenticate(header: string | undefined): Principal {
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (equal(token, this.admin)) return { role: 'admin' }
    const match = /^grant\.([a-zA-Z0-9_-]{1,100})\.([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/.exec(token)
    if (match && equal(token, this.credential(match[1]!, Number(match[2])))) return { role: 'grant', id: match[1]!, epoch: Number(match[2]) }
    throw new RemoteError(401, 'unauthorized', 'Endpoint credential required')
  }
  private all<T>(table: string): T[] { return this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(String(row.value)) as T) }
  private get<T>(table: string, id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }
  private save(table: string, id: string, value: unknown): void {
    this.db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(value))
  }
  grants(): RemoteGrant[] { return this.all('remote_grant') }
  grant(id: string): RemoteGrant { const value = this.get<RemoteGrant>('remote_grant', id); if (!value) throw new RemoteError(404, 'not_found', 'Grant not found'); return value }
  saveGrant(value: RemoteGrant): void { this.save('remote_grant', value.id, value) }
  jobs(): RemoteJob[] { return this.all('remote_job') }
  job(id: string): RemoteJob { const value = this.get<RemoteJob>('remote_job', id); if (!value) throw new RemoteError(404, 'not_found', 'Command not found'); return value }
  findJob(id: string): RemoteJob | undefined { return this.get('remote_job', id) }
  saveJob(value: RemoteJob): void { value.updatedAt = timestamp(); this.save('remote_job', value.id, value) }
  operations(): RemoteOperation[] { return this.all('remote_operation') }
  operation(id: string): RemoteOperation | undefined { return this.get('remote_operation', id) }
  saveOperation(value: RemoteOperation): void { this.save('remote_operation', value.id, value) }
  receipt<T>(id: string, digest: string): T | undefined {
    const row = this.db.prepare('SELECT fingerprint,value FROM remote_receipt WHERE id=?').get(id)
    if (!row) return
    if (row.fingerprint !== digest) throw new RemoteError(409, 'request_conflict', 'Request ID already used with another payload')
    return JSON.parse(String(row.value)) as T
  }
  remember(id: string, digest: string, value: unknown): void { this.db.prepare('INSERT INTO remote_receipt VALUES (?,?,?)').run(id, digest, JSON.stringify(value)) }
  audit(value: unknown): void { this.db.prepare('INSERT INTO remote_audit(value) VALUES (?)').run(JSON.stringify({ at: timestamp(), value })) }
  append(id: string, stream: 'stdout' | 'stderr', bytes: Buffer, cap: number): void {
    const size = this.db.prepare('SELECT length(data) AS size FROM remote_output WHERE job=? AND stream=?').get(id, stream)
    if (Number(size?.size ?? 0) >= cap) { this.db.prepare('UPDATE remote_output SET total=total+? WHERE job=? AND stream=?').run(bytes.length, id, stream); return }
    const row = this.db.prepare('SELECT data,total FROM remote_output WHERE job=? AND stream=?').get(id, stream)
    const before = row ? Buffer.from(row.data as Uint8Array) : Buffer.alloc(0), total = Number(row?.total ?? 0) + bytes.length
    const data = Buffer.concat([before, bytes.subarray(0, Math.max(0, cap - before.length))])
    this.db.prepare('INSERT INTO remote_output VALUES (?,?,?,?) ON CONFLICT(job,stream) DO UPDATE SET data=excluded.data,total=excluded.total').run(id, stream, data, total)
  }
  output(id: string, stream: 'stdout' | 'stderr', offset: number, limit: number): OutputWindow {
    const row = this.db.prepare('SELECT data,total FROM remote_output WHERE job=? AND stream=?').get(id, stream)
    const bytes = row ? Buffer.from(row.data as Uint8Array) : Buffer.alloc(0), totalBytes = Number(row?.total ?? 0)
    if (offset > totalBytes) throw new RemoteError(409, 'output_cursor', 'Output cursor is ahead of the recorded stream')
    const data = bytes.subarray(offset, offset + limit), gap = offset >= bytes.length && totalBytes > offset
    return { offset, nextOffset: gap ? totalBytes : offset + data.length, data: data.toString('base64'), gap, totalBytes, retainedBytes: bytes.length }
  }
  close(): void { if (this.closed) return; this.closed = true; this.db.close(); this.release() }
}
