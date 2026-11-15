/** Workspace encryption reuses recovery AES-GCM/key handling; it does not grant execution authority. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { inside } from '../remote/journal.ts'
import { privateInput, recoveryKey, seal, unseal, type SealedFile } from './crypto.ts'
import { verifyWorkspaceRecovery } from './workspace-verify.ts'

const envelopeSchema = z.object({ version: z.literal(1), kind: z.literal('workspace-content'), id: z.string().uuid(),
  files: z.array(z.object({ member: z.string().regex(/^(manifest|content-(0|[1-9]\d*))\.bin$/),
    iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative().max(2 ** 40) }).strict()).min(1).max(100001) }).strict()
const sync = async (path: string) => { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }

export async function encryptWorkspaceRecovery(source: string, destination: string, keyFile: string, signal = new AbortController().signal) {
  signal.throwIfAborted()
  if (!isAbsolute(destination)) throw new Error('Encrypted workspace destination must be absolute')
  const root = await realpath(source), parent = privateDirectory(await realpath(dirname(destination)))
  const target = join(parent, basename(resolve(destination))), keyPath = await realpath(keyFile)
  if (inside(root, target) || inside(target, root) || inside(root, keyPath) || inside(target, keyPath))
    throw new Error('Workspace archive, destination and recovery key must remain separate')
  const key = recoveryKey(keyFile)
  try {
    await mkdir(target, { mode: 0o700 })
    const id = randomUUID(), files: SealedFile[] = []
    await verifyWorkspaceRecovery(root, signal, async verified => {
      const inventory = JSON.parse(await readFile(join(verified, 'manifest.json'), 'utf8'))
      if (inside(resolve(inventory.source), keyPath)) throw new Error('Recovery key must remain outside the original workspace')
      for (const file of (await readdir(verified)).sort()) {
        signal.throwIfAborted()
        const member = file === 'manifest.json' ? 'manifest.bin' : file
        files.push(await seal(join(verified, file), join(target, member), key, id, member, signal))
      }
    })
    const envelope = envelopeSchema.parse({ version: 1, kind: 'workspace-content', id, files })
    signal.throwIfAborted()
    await writeFile(join(target, 'archive.json'), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 })
    await sync(join(target, 'archive.json')); await sync(target); await sync(parent)
    signal.throwIfAborted()
    return { path: target, id, encrypted: true as const, sourceAuthorityVerified: false as const, restoreVerified: false as const }
  } finally { key.fill(0) }
}

export async function verifyEncryptedWorkspaceRecovery(path: string, keyFile: string, signal = new AbortController().signal,
  capture?: (directory: string) => Promise<void>) {
  signal.throwIfAborted()
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Error('Encrypted workspace archive must be a private owned directory')
  const root = await realpath(path), chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of privateInput(join(root, 'archive.json'), signal)) {
    bytes += chunk.length
    if (bytes > 40 * 1024 * 1024) throw new Error('Encrypted workspace index exceeds its bound')
    chunks.push(chunk)
  }
  const envelope = envelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  const members = new Set(envelope.files.map(file => file.member)), names = await readdir(root)
  if (members.size !== envelope.files.length || !members.has('manifest.bin') || names.length !== members.size + 1
    || names.some(name => name !== 'archive.json' && !members.has(name))) throw new Error('Encrypted workspace archive membership differs')
  const key = recoveryKey(keyFile)
  let temporary: string | undefined
  try {
    temporary = await mkdtemp(join(tmpdir(), 'dsh-workspace-decrypted-'))
    for (const file of envelope.files) {
      signal.throwIfAborted()
      await unseal(join(root, file.member), join(temporary, file.member === 'manifest.bin' ? 'manifest.json' : file.member), key, envelope.id, file, signal)
    }
    const verified = await verifyWorkspaceRecovery(temporary, signal, capture)
    return { ...verified, id: envelope.id, encryptionVerified: true as const }
  } finally { key.fill(0); if (temporary) await rm(temporary, { recursive: true, force: true }) }
}
