/** Offline storage evidence export. Never initialize an endpoint or settle retained operations. */
import { verifyCaptureHandoff } from './capture-handoff.ts'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { inside } from '../remote/journal.ts'
import { privateInput } from './crypto.ts'
import { readEndpointStorageSnapshot } from './storage.ts'

const sync = async (path: string) => { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
export async function exportEndpointStorageSnapshot(stateDir: string, destination: string, requestedSignal = new AbortController().signal, captureSelections?: unknown) {
  if (!isAbsolute(stateDir) || !isAbsolute(destination)) throw new Error('Snapshot paths must be absolute')
  // Require an existing source: privateDirectory alone would create a missing directory.
  const sourceStat = await lstat(stateDir)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Snapshot source must be an existing endpoint directory')
  const source = privateDirectory(await realpath(stateDir)), parent = privateDirectory(await realpath(dirname(destination)))
  const target = join(parent, basename(resolve(destination)))
  if (inside(source, target) || inside(target, source)) throw new Error('Snapshot destination must be separate from endpoint state')
  const abort = new AbortController(), signal = AbortSignal.any([requestedSignal, abort.signal, AbortSignal.timeout(120_000)])
  signal.throwIfAborted()
  const release = lockSync(source, { stale: 30_000, onCompromised: error => abort.abort(error) })
  let db: DatabaseSync | undefined, copy: DatabaseSync | undefined
  try {
    const original = join(source, 'endpoint.sqlite'), stat = await lstat(original)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('Endpoint database must be a private owned regular file')
    db = new DatabaseSync(original, { readOnly: true, allowExtension: false })
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
    // Reserve a fresh private directory. Failed output is retained without a success receipt.
    await mkdir(target, { mode: 0o700 })
    const path = join(target, 'endpoint.sqlite')
    const reserved = await open(path, 'wx', 0o600); await reserved.close()
    await backup(db, path, { rate: 128, progress: () => { signal.throwIfAborted() } })
    await chmod(path, 0o600)
    copy = new DatabaseSync(path, { allowExtension: false })
    copy.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL')
    const integrity = copy.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') throw new Error('Endpoint snapshot integrity check failed')
    const evidence = await readEndpointStorageSnapshot(copy, signal)
    const handoff = captureSelections === undefined ? undefined : await verifyCaptureHandoff(evidence.snapshot, captureSelections, signal)
    copy.close(); copy = undefined
    let bytes = 0; const hash = createHash('sha256')
    for await (const chunk of privateInput(path, signal)) { bytes += chunk.length; hash.update(chunk) }
    const receipt = { version: 1, endpointId: evidence.snapshot.endpointId, endpoint: { path, bytes, sha256: hash.digest('hex') },
      records: evidence.records, recordDigest: evidence.digest, writerLockHeld: true, workspaceFilesIncluded: false,
      executionQuiescenceVerified: false, hostRegistryIncluded: false, restoreVerified: false, ...(handoff ? { handoff } : {}) }
    await sync(path); signal.throwIfAborted()
    await writeFile(join(target, 'snapshot.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    await sync(join(target, 'snapshot.json')); await sync(target); await sync(parent)
    signal.throwIfAborted()
    return receipt
  } finally { try { try { copy?.close() } finally { db?.close() } } finally { release() } }
}
