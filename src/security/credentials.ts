/** Confined credential vault: one 0600 file per named secret, atomic writes, names-only listings. */
import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { lstatSync } from 'node:fs'

export const CREDENTIAL_NAME = /^[a-z][a-z0-9._-]{0,63}$/
export const MAX_CREDENTIAL_BYTES = 16 * 1024
export interface CredentialMetadata { name: string; bytes: number; updatedAt: string }

const validateName = (name: string): string => {
  if (!CREDENTIAL_NAME.test(name)) throw new Error('Credential names must match ^[a-z][a-z0-9._-]{0,63}$')
  return name
}

/** Host-owned secret storage. Values are returned only by `get`, never by `list` or a view. */
export class CredentialVault {
  private readonly directory: string
  constructor(stateDir: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.directory = join(stateDir, 'credentials')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    let fd: number | undefined
    try {
      fd = openSync(this.directory, constants.O_RDONLY)
      fchmodSync(fd, 0o700)
    } catch { /* An existing directory may have a stricter mode; do not fail the vault for that. */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }

  private file(name: string): string { return join(this.directory, `${validateName(name)}.secret`) }
  /** Rejects symlinks so a planted link cannot redirect a write or read outside the vault. */
  private guard(name: string): void {
    try { if (lstatSync(this.file(name)).isSymbolicLink()) throw new Error('Credential path is a symlink') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }

  /** Writes atomically with 0600 permissions; an existing value is replaced, never partially exposed. */
  set(name: string, value: string): CredentialMetadata {
    this.guard(name)
    const path = this.file(name), bytes = Buffer.byteLength(value)
    if (!value) throw new Error('A credential value cannot be empty')
    if (bytes > MAX_CREDENTIAL_BYTES) throw new Error(`A credential value cannot exceed ${MAX_CREDENTIAL_BYTES} bytes`)
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
      let fd: number | undefined
      try { fd = openSync(temporary, constants.O_RDONLY); fchmodSync(fd, 0o600) } finally { if (fd !== undefined) closeSync(fd) }
      renameSync(temporary, path)
    } catch (error) { rmSync(temporary, { force: true }); throw error }
    return { name, bytes, updatedAt: this.now() }
  }

  /** Reads the value for an authorized caller; O_NOFOLLOW prevents following a symlink. */
  get(name: string): string | undefined {
    this.guard(name)
    let fd: number | undefined
    try {
      fd = openSync(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW)
      return readFileSync(fd, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  has(name: string): boolean { return this.get(name) !== undefined }

  delete(name: string): boolean {
    this.guard(name)
    try { rmSync(this.file(name)); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }

  /** Names and metadata only; never a value. */
  list(): CredentialMetadata[] {
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.secret'))
      .map(entry => entry.name.slice(0, -'.secret'.length))
      .filter(name => CREDENTIAL_NAME.test(name))
      .sort()
      .map(name => {
        const stat = lstatSync(this.file(name))
        return { name, bytes: stat.size, updatedAt: stat.mtime.toISOString() }
      })
  }
}
