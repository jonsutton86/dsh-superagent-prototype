/** Authenticated prepared state is a held recovery artifact, never an execution permit. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { InventoryPage } from '../ownership/inventory.ts'
import { RecoveryReservation } from '../ownership/protocol.ts'
import { privateInput, recoveryKey } from './crypto.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const ReceiptImage = z.object({ version: z.literal(1), requestId: z.string().uuid(), requestHash: digest,
  checkpoint: z.string().uuid(), digest, auditId: z.string().uuid(), at: z.string().datetime(),
  recovery: RecoveryReservation, epoch: z.number().int().nonnegative(), executionOwnership: z.literal(false),
  resources: z.array(z.object({ identity: InventoryPage.shape.identity, revision: InventoryPage.shape.revision,
    total: InventoryPage.shape.total, quiescent: z.literal(true) }).strict()).max(257),
  applied: z.object({ commands: z.number().int().nonnegative(), mutations: z.number().int().nonnegative(), publications: z.number().int().nonnegative() }).strict(),
  files: z.array(z.object({ member: z.string().regex(/^(?:orchestrator\.sqlite|[a-z0-9-]+\.bin)$/),
    kind: z.enum(['store', 'world', 'session']), bytes: z.number().int().nonnegative().max(2 ** 40), sha256: digest,
    binding: digest.optional() }).strict()).min(1).max(20000),
}).strict()
export type ReceiptImage = z.infer<typeof ReceiptImage>
const envelope = z.object({ manifest: ReceiptImage, mac: digest }).strict()
const authenticate = (manifest: ReceiptImage, key: Buffer) => createHmac('sha256', key).update('dsh-receipt-image:1\n').update(JSON.stringify(manifest)).digest()
export function sealReceiptImage(value: ReceiptImage, key: Buffer): string {
  const manifest = ReceiptImage.parse(value)
  return JSON.stringify({ manifest, mac: authenticate(manifest, key).toString('hex') })
}
export async function syncRecoveryPath(path: string): Promise<void> {
  const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() }
}
export async function recoveryFileDigest(path: string, signal: AbortSignal, maximum = 2 ** 40): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256'); let bytes = 0
  for await (const chunk of privateInput(path, signal)) {
    bytes += chunk.length; if (bytes > maximum) throw new Error('Prepared recovery member exceeds its recorded size')
    hash.update(chunk)
  }
  return { bytes, sha256: hash.digest('hex') }
}
/** Verify the complete image and reject unlisted files, links and changed bytes before accepting an original-ID retry. */
export async function verifyReceiptImage(path: string, keyFile: string, signal = new AbortController().signal): Promise<ReceiptImage> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Prepared recovery image must be a private owned directory')
  const root = await realpath(path), chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of privateInput(join(root, 'prepared.json'), signal)) {
    bytes += chunk.length; if (bytes > 16_000_000) throw new Error('Prepared recovery manifest exceeds its bound')
    chunks.push(Buffer.from(chunk))
  }
  const value = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))), key = recoveryKey(keyFile)
  try { if (!timingSafeEqual(authenticate(value.manifest, key), Buffer.from(value.mac, 'hex'))) throw new Error('Prepared recovery manifest authentication failed') }
  finally { key.fill(0) }
  const expected = value.manifest.files.map(file => file.member)
  if (new Set(expected).size !== expected.length || value.manifest.files.filter(file => file.kind === 'store' && file.member === 'orchestrator.sqlite').length !== 1
    || JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([...expected, 'prepared.json'].sort()))
    throw new Error('Prepared recovery image member set differs from its manifest')
  for (const file of value.manifest.files) {
    const actual = await recoveryFileDigest(join(root, file.member), signal, file.bytes)
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('Prepared recovery image member digest differs')
  }
  signal.throwIfAborted(); return value.manifest
}
