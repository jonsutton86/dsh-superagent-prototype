/** Private authenticated checkpoint members. The backup key is never written into the checkpoint. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, createReadStream, createWriteStream, fstatSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { privateCredential, privateFile } from '../environments/endpoint-files.ts'

export interface SealedFile { member: string; iv: string; tag: string; sha256: string; bytes: number }
export function recoveryKey(file: string): Buffer {
  const value = privateCredential(file)
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Recovery key must be exactly 32 random bytes encoded as lowercase hex')
  return Buffer.from(value, 'hex')
}
export function createRecoveryKey(file: string): void { privateFile(file, randomBytes(32).toString('hex')) }
const aad = (id: string, member: string) => Buffer.from(`dsh-checkpoint:1:${id}:${member}`)

/** Pin a private regular input before streaming; refuse links and special files without blocking on them. */
export function privateInput(file: string, signal: AbortSignal) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Recovery inputs must be private owned regular files with no extra hard links')
    return createReadStream(file, { fd, autoClose: true, signal })
  } catch (error) { closeSync(fd); throw error }
}

/** Stream encryption bounds memory independently of database or Session history size. */
export async function seal(source: string, destination: string, key: Buffer, id: string, member: string, signal: AbortSignal): Promise<SealedFile> {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), digest = createHash('sha256')
  let bytes = 0
  cipher.setAAD(aad(id, member))
  const observe = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; digest.update(chunk); callback(null, chunk) } })
  await pipeline(privateInput(source, signal), observe, cipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
  const file = await open(destination, 'r'); try { await file.sync() } finally { await file.close() }
  return { member, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), bytes, sha256: digest.digest('hex') }
}

/** Only publish the caller's staging directory after every member has authenticated and matched its recorded digest. */
export async function unseal(source: string, destination: string, key: Buffer, id: string, record: SealedFile, signal: AbortSignal): Promise<void> {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'hex')), digest = createHash('sha256')
  let bytes = 0
  decipher.setAAD(aad(id, record.member)); decipher.setAuthTag(Buffer.from(record.tag, 'hex'))
  const observe = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    if (bytes > record.bytes) return callback(new Error('Checkpoint member exceeds its authenticated size'))
    digest.update(chunk); callback(null, chunk)
  } })
  await pipeline(privateInput(source, signal), decipher, observe, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
  if (bytes !== record.bytes || digest.digest('hex') !== record.sha256) throw new Error('Checkpoint member digest does not match')
}
