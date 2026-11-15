/** Read-only structural/content verification. Hashes establish integrity, never source authority or safe execution. */
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { z } from 'zod'
import { privateInput } from './crypto.ts'

const path = z.string().min(1).max(4096).refine(value => value === '.' || !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..'))
const digest = z.string().regex(/^[a-f0-9]{64}$/), count = z.number().int().nonnegative().max(2 ** 40)
const base = { path, mode: z.number().int().min(0).max(0o7777), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative() }
const entry = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('directory') }).strict(),
  z.object({ ...base, kind: z.literal('file'), bytes: count, sha256: digest, hardlinkTo: path.optional() }).strict(),
  z.object({ ...base, kind: z.literal('symlink'), target: z.string().min(1).max(4096).refine(value => !value.includes('\0')) }).strict(),
])
const manifestSchema = z.object({ version: z.literal(1), entries: z.array(entry).min(1).max(100000), bytes: count, sha256: digest,
  source: z.string().max(4096).startsWith('/'), sourceIdentity: z.string().regex(/^\d+:\d+$/),
  content: z.array(z.object({ path, member: z.string().regex(/^content-(0|[1-9]\d*)\.bin$/), bytes: count, sha256: digest }).strict()).max(100000),
  contentArchived: z.literal(true), executionQuiescenceVerified: z.literal(false), restoreVerified: z.literal(false) }).strict()

export async function verifyWorkspaceRecovery(path: string, signal = new AbortController().signal) {
  signal.throwIfAborted()
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('Workspace archive must be a private owned directory')
  const root = await realpath(path), chunks: Buffer[] = []; let size = 0
  for await (const chunk of privateInput(join(root, 'manifest.json'), signal)) {
    size += chunk.length
    if (size > 80 * 1024 * 1024) throw new Error('Workspace archive manifest exceeds its bound')
    chunks.push(chunk)
  }
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')), manifest = manifestSchema.parse(raw)
  // Preserve the writer's entry key ordering when checking its version-1 inventory digest.
  const hash = createHash('sha256').update(JSON.stringify({ version: 1, entries: raw.entries, bytes: manifest.bytes })).digest('hex')
  if (hash !== manifest.sha256) throw new Error('Workspace archive inventory digest differs')
  const entries = new Map<string, z.infer<typeof entry>>(); let total = 0
  for (const item of manifest.entries) {
    signal.throwIfAborted()
    if (entries.has(item.path) || item.path === '.' && (entries.size !== 0 || item.kind !== 'directory')
      || item.path !== '.' && entries.get(posix.dirname(item.path))?.kind !== 'directory')
      throw new Error('Workspace archive tree has duplicate or missing directory relationships')
    if (!entries.size && item.path !== '.') throw new Error('Workspace archive has no root directory')
    if (item.kind === 'file') {
      total += item.bytes
      if (item.hardlinkTo) {
        const original = entries.get(item.hardlinkTo)
        if (original?.kind !== 'file' || original.hardlinkTo || original.bytes !== item.bytes || original.sha256 !== item.sha256
          || original.mode !== item.mode || original.uid !== item.uid || original.gid !== item.gid)
          throw new Error('Workspace archive hard-link relationship differs')
      }
    }
    entries.set(item.path, item)
  }
  if (total !== manifest.bytes) throw new Error('Workspace archive byte total differs')
  const members = new Set<string>(), covered = new Set<string>()
  for (const member of manifest.content) {
    const item = entries.get(member.path)
    if (item?.kind !== 'file' || covered.has(member.path) || members.has(member.member) || item.bytes !== member.bytes || item.sha256 !== member.sha256)
      throw new Error('Workspace archive content membership differs')
    members.add(member.member); covered.add(member.path)
    const hash = createHash('sha256'); let bytes = 0
    for await (const chunk of privateInput(join(root, member.member), signal)) {
      bytes += chunk.length
      if (bytes > member.bytes) throw new Error('Workspace archive content exceeds its recorded size')
      hash.update(chunk)
    }
    if (bytes !== member.bytes || hash.digest('hex') !== member.sha256) throw new Error('Workspace archive content digest differs')
  }
  if ([...entries.values()].some(item => item.kind === 'file' && !covered.has(item.path))) throw new Error('Workspace archive content is missing')
  const files = await readdir(root)
  if (files.length !== members.size + 1 || files.some(file => file !== 'manifest.json' && !members.has(file))) throw new Error('Workspace archive has unbound members')
  signal.throwIfAborted()
  return { manifest, contentVerified: true as const, sourceAuthorityVerified: false as const, executionQuiescenceVerified: false as const, restoreVerified: false as const }
}
