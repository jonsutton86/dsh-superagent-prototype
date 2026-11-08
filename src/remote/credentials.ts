import { createHash, randomUUID } from 'node:crypto'
import { constants, chmodSync, mkdirSync, realpathSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { RemoteJournal, fingerprint, timestamp } from './journal.ts'
import { RemoteError, type CredentialBinding, type EndpointCredential, type RpcRequest } from './protocol.ts'

const MAX_FILE = 64 * 1024
interface StoredCredential extends EndpointCredential { digest: string }
const binding = ({ id, version, variable, mode }: CredentialBinding): CredentialBinding => ({ id, version, variable, mode })
const order = (a: CredentialBinding, b: CredentialBinding) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
const publicRecord = ({ digest: _digest, ...record }: StoredCredential): EndpointCredential => record
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const deniedVariable = (name: string) => /^(?:DSH_|LD_|DYLD_|NODE_|PYTHON|RUBY|PERL|BASH|ZSH|LC_)/.test(name)
  || ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'ENV', 'IFS', 'CDPATH', 'GLOBIGNORE', 'LANG', 'TERM', 'PAGER', 'GIT_PAGER', 'NO_COLOR', 'CI', 'GIT_TERMINAL_PROMPT'].includes(name)

/** Endpoint-owned immutable credential snapshots; only public version bindings cross the execution protocol. */
export class EndpointCredentials {
  readonly imports: string
  private readonly vault: string
  constructor(private readonly journal: RemoteJournal) {
    const directory = realpathSync(journal.directory)
    this.imports = join(directory, 'credential-imports'); this.vault = join(directory, 'credential-vault')
    for (const path of [this.imports, this.vault]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      if (realpathSync(path) !== path) throw new Error('Endpoint credential directories must not be symlinks')
      chmodSync(path, 0o700)
    }
    journal.db.exec('CREATE TABLE IF NOT EXISTS remote_credential (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  private get(id: string): StoredCredential | undefined {
    const row = this.journal.db.prepare('SELECT value FROM remote_credential WHERE id=?').get(id)
    return row ? JSON.parse(String(row.value)) as StoredCredential : undefined
  }
  private save(record: StoredCredential): void {
    this.journal.db.prepare('INSERT INTO remote_credential VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, JSON.stringify(record))
  }
  list(offset = 0) {
    const rows = this.journal.db.prepare('SELECT value FROM remote_credential ORDER BY id LIMIT 101 OFFSET ?').all(offset)
    return { items: rows.slice(0, 100).map(row => publicRecord(JSON.parse(String(row.value)) as StoredCredential)), nextOffset: rows.length > 100 ? offset + 100 : null }
  }
  resolve(refs: readonly { id: string; version: string }[]): CredentialBinding[] {
    const records = refs.map(ref => {
      const record = this.get(ref.id)
      if (!record?.enabled || record.version !== ref.version) throw new RemoteError(409, 'credential_unavailable', `Credential binding is unavailable: ${ref.id}`)
      return binding(record)
    })
    if (new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.variable)).size !== records.length)
      throw new RemoteError(400, 'credential_conflict', 'A grant cannot repeat credentials or bind two credentials to one variable')
    return records.sort(order)
  }
  valid(bindings: readonly CredentialBinding[] = []): boolean {
    try { return fingerprint(this.resolve(bindings)) === fingerprint([...bindings].sort(order)) }
    catch { return false }
  }
  private async read(path: string): Promise<Buffer> {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size < 1 || before.size > MAX_FILE)
        throw new Error('Invalid private file')
      const bytes = Buffer.alloc(MAX_FILE + 1); let size = 0
      while (size <= MAX_FILE) {
        const result = await handle.read(bytes, size, bytes.length - size, size)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      const after = await handle.stat()
      if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size > MAX_FILE) throw new Error('File changed')
      return bytes.subarray(0, size)
    } catch { throw new RemoteError(409, 'credential_file', 'Credential must be a stable private regular file owned by the endpoint user, with no links, and at most 64 KiB') }
    finally { await handle?.close() }
  }
  async import(request: Extract<RpcRequest, { op: 'credential.import' }>, authorize: () => Promise<void> = async () => {}): Promise<EndpointCredential> {
    const hash = fingerprint(request), replay = this.journal.receipt<EndpointCredential>(request.requestId, hash)
    if (replay) return publicRecord(this.get(replay.id)!)
    const previous = this.get(request.id)
    if ((previous?.revision ?? 0) !== request.revision) throw new RemoteError(409, 'stale_revision', 'Credential revision changed')
    if (deniedVariable(request.variable)) throw new RemoteError(400, 'credential_variable', 'Credentials cannot replace runtime, shell, Harness or coordinator environment variables')
    const bytes = await this.read(join(this.imports, request.file))
    if (request.mode === 'env') {
      let value: string
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r?\n$/, '') } catch { throw new RemoteError(400, 'credential_value', 'Environment credentials require UTF-8 text') }
      if (!value || bytes.length > 8192 || value.includes('\0')) throw new RemoteError(400, 'credential_value', 'Environment credentials require 1–8192 bytes of UTF-8 text without NUL')
    }
    const at = timestamp(), record: StoredCredential = { id: request.id, variable: request.variable, mode: request.mode,
      version: randomUUID(), revision: request.revision + 1, enabled: true, createdAt: previous?.createdAt ?? at, updatedAt: at, digest: digest(bytes) }
    const path = join(this.vault, record.version), handle = await open(path, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    const directory = await open(this.vault, 'r')
    try { await directory.sync() } finally { await directory.close() }
    try {
      await authorize()
      this.journal.atomic(() => {
        this.save(record); this.journal.remember(request.requestId, hash, publicRecord(record))
        this.journal.audit({ action: request.op, credential: record.id, version: record.version, revision: record.revision, reason: request.reason })
      })
    } catch (error) { await unlink(path).catch(() => {}); throw error }
    return publicRecord(record)
  }
  revoke(request: Extract<RpcRequest, { op: 'credential.revoke' }>): EndpointCredential {
    const hash = fingerprint(request), replay = this.journal.receipt<EndpointCredential>(request.requestId, hash)
    if (replay) return publicRecord(this.get(replay.id)!)
    const record = this.get(request.id)
    if (!record) throw new RemoteError(404, 'not_found', 'Credential not found')
    if (record.revision !== request.revision) throw new RemoteError(409, 'stale_revision', 'Credential revision changed')
    record.enabled = false; record.revision++; record.updatedAt = timestamp()
    this.journal.atomic(() => { this.save(record); this.journal.remember(request.requestId, hash, publicRecord(record));
      this.journal.audit({ action: request.op, credential: record.id, version: record.version, revision: record.revision, reason: request.reason }) })
    return publicRecord(record)
  }
  /** Validate private snapshots before mounting; the command launcher receives only the selected files. */
  async mounts(bindings: readonly CredentialBinding[]) {
    if (!this.valid(bindings)) throw new RemoteError(409, 'credential_unavailable', 'Credential binding changed before dispatch')
    const mounts = []
    for (const item of bindings) {
      const source = join(this.vault, item.version), bytes = await this.read(source)
      if (digest(bytes) !== this.get(item.id)?.digest) throw new RemoteError(409, 'credential_integrity', 'Private credential snapshot changed; import a new version')
      mounts.push({ source, target: `/run/dsh-credentials/${item.id}`, variable: item.variable, mode: item.mode })
    }
    return mounts
  }
}
