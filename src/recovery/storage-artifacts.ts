/** Verified private copies of storage artifacts; never opens a live registry as a product service. */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { privateInput } from './crypto.ts'
import { auditStorageRecoveryBindings, readEndpointStorageSnapshot, readHostStorageSnapshot } from './storage.ts'

const artifact = z.object({ path: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !value.includes('\0')), bytes: z.number().int().positive().max(2 ** 40),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const inputs = z.object({ endpointId: z.string().uuid(), endpoint: artifact, host: artifact }).strict()
async function copyVerified(source: z.infer<typeof artifact>, destination: string, signal: AbortSignal) {
  const hash = createHash('sha256'); let bytes = 0
  const inspect = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    if (bytes > source.bytes) return callback(new Error('Storage snapshot exceeds its expected size'))
    hash.update(chunk); callback(null, chunk)
  } })
  await pipeline(privateInput(source.path, signal), inspect, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal })
  if (bytes !== source.bytes || hash.digest('hex') !== source.sha256) throw new Error('Storage snapshot differs from its expected digest')
  const file = await open(destination, 'r')
  try {
    const header = Buffer.alloc(20), result = await file.read(header, 0, 20, 0)
    if (result.bytesRead !== 20 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1)
      throw new Error('Storage snapshot must be a standalone SQLite database without a WAL dependency')
  } finally { await file.close() }
}
function openSnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON'); return db }
  catch (error) { db.close(); throw error }
}

/** Expected digests must come from authenticated image membership; this function cannot establish their provenance. */
export async function auditStorageRecoveryArtifacts(input: unknown, signal: AbortSignal) {
  const value = inputs.parse(input); signal.throwIfAborted()
  const staging = await mkdtemp(join(tmpdir(), 'dsh-storage-recovery-'))
  let endpoint: DatabaseSync | undefined, host: DatabaseSync | undefined
  try {
    const endpointPath = join(staging, 'endpoint.sqlite'), hostPath = join(staging, 'host.sqlite')
    await copyVerified(value.endpoint, endpointPath, signal)
    await copyVerified(value.host, hostPath, signal)
    endpoint = openSnapshot(endpointPath); host = openSnapshot(hostPath)
    const endpointRecords = await readEndpointStorageSnapshot(endpoint, signal)
    const hostRecords = await readHostStorageSnapshot(host, value.endpointId, signal)
    const result = auditStorageRecoveryBindings(endpointRecords.snapshot, hostRecords.snapshot)
    signal.throwIfAborted()
    return { ...result, endpointDigest: endpointRecords.digest, hostDigest: hostRecords.digest,
      endpointArtifact: { bytes: value.endpoint.bytes, sha256: value.endpoint.sha256 },
      hostArtifact: { bytes: value.host.bytes, sha256: value.host.sha256 }, hostRegistryAuditRequired: true as const }
  } finally {
    try { endpoint?.close() } finally { try { host?.close() } finally { await rm(staging, { recursive: true, force: true }) } }
  }
}
