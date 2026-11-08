/** Private operator files. Values are checked in memory and never enter API responses or command journals. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { EnvironmentError } from './model.ts'

export const credentialDigest = (value: string) => createHash('sha256').update(value).digest('hex')
export function privateDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new EnvironmentError(409, 'Operator state must be a private directory owned by this service user')
  const canonical = realpathSync(directory), parent = openSync(dirname(canonical), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  return canonical
}
export function privateCredential(file: string, pin?: string): string {
  if (!isAbsolute(file) || realpathSync(dirname(file)) !== dirname(resolve(file)))
    throw new EnvironmentError(409, 'Use an absolute credential path without symbolic links')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size < 32 || stat.size > 4096)
      throw new EnvironmentError(409, 'Credential must be a private, owned regular file with no additional hard links')
    const value = readFileSync(fd, 'utf8').trim(), after = fstatSync(fd)
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || /\s/.test(value)
      || (pin && credentialDigest(value) !== pin)) throw new EnvironmentError(409, 'The pinned credential file changed; explicitly update endpoint registration')
    return value
  } finally { closeSync(fd) }
}
/** Publish whole files under the Runtime's single-writer lock, then sync their parent before recording success. */
export function privateFile(file: string, content: string): void {
  const existing = (): boolean => {
    let fd: number
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size !== Buffer.byteLength(content) || readFileSync(fd, 'utf8') !== content)
        throw new EnvironmentError(409, 'An existing operator file differs from the recorded request')
      fsyncSync(fd); return true
    } finally { closeSync(fd) }
  }
  if (!existing()) {
    const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
      if (!existing()) renameSync(temporary, file)
    } finally { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  }
  const parent = openSync(dirname(file), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
