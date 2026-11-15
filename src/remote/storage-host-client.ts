import { connect } from 'node:net'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import { EndpointStorage, StorageObservation, StorageReservation } from './storage-model.ts'
import { storageRoots } from './storage-journal.ts'
import type { StorageHost } from './storage-provisioning.ts'

const refused = () => new Error('Storage host response is unavailable or does not match the original operation; inspect before retrying')
const Reply = z.object({ ok: z.literal(true), endpointId: z.string().uuid(), requestId: z.string(), requestHash: z.string(),
  observation: StorageObservation }).strict()

/** Fixed local socket, root-owned pathname and parents; service authenticates the endpoint UID with SO_PEERCRED. */
export class LocalStorageHost implements StorageHost {
  constructor(private readonly socketPath: string) {}
  private async socketIdentity() {
    if (process.platform !== 'linux' || !isAbsolute(this.socketPath) || Buffer.byteLength(this.socketPath) >= 104
      || await realpath(this.socketPath) !== this.socketPath) throw refused()
    const socket = await lstat(this.socketPath)
    if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o777) !== 0o660) throw refused()
    for (let path = dirname(this.socketPath);; path = dirname(path)) {
      const parent = await lstat(path)
      if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) && !(parent.mode & 0o1000)) throw refused()
      if (path === '/') break
    }
    return `${socket.dev}:${socket.ino}`
  }
  private async call(op: 'provision' | 'observe', configured: EndpointStorage, reserved: StorageReservation, roots: readonly string[], signal: AbortSignal) {
    const policy = EndpointStorage.parse(configured), reservation = StorageReservation.parse(reserved)
    if (JSON.stringify(roots) !== JSON.stringify(storageRoots(policy, reservation))) throw refused()
    signal.throwIfAborted()
    const identity = await this.socketIdentity()
    const total = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    const payload = JSON.stringify({ op, request: { endpointId: reservation.endpointId, requestId: reservation.requestId,
      requestHash: reservation.requestHash, workspace: reservation.workspace, projectId: reservation.projectId } })
    if (Buffer.byteLength(payload) > 4096) throw refused()
    const output = await new Promise<string>((resolve, reject) => {
      const socket = connect({ path: this.socketPath, signal: total }), chunks: Buffer[] = []
      let length = 0
      socket.on('connect', () => socket.end(payload))
      socket.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 65536) socket.destroy(refused())
        else chunks.push(chunk)
      })
      socket.once('error', () => reject(refused()))
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      socket.once('close', hadError => { if (!hadError && !socket.readableEnded) reject(refused()) })
    })
    if (identity !== await this.socketIdentity()) throw refused()
    total.throwIfAborted()
    let decoded: unknown
    try { decoded = JSON.parse(output) } catch { throw refused() }
    const result = Reply.safeParse(decoded)
    if (!result.success || result.data.endpointId !== reservation.endpointId || result.data.requestId !== reservation.requestId
      || result.data.requestHash !== reservation.requestHash) throw refused()
    const observation = result.data.observation
    if (observation.filesystemUUID.toLowerCase() !== policy.filesystemUUID.toLowerCase() || observation.mountRoot !== policy.mountRoot
      || observation.projectId !== reservation.projectId || observation.quota.hardBytes !== policy.workspace.bytes
      || observation.quota.hardInodes !== policy.workspace.inodes || observation.directories.length !== roots.length
      || new Set(observation.directories.map(item => item.path)).size !== roots.length
      || observation.directories.some(item => !roots.includes(item.path) || item.projectId !== reservation.projectId)) throw refused()
    return observation
  }
  async provision(policy: EndpointStorage, reservation: StorageReservation, roots: readonly string[], signal: AbortSignal): Promise<void> {
    await this.call('provision', policy, reservation, roots, signal)
  }
  observe(policy: EndpointStorage, reservation: StorageReservation, roots: readonly string[], signal: AbortSignal): Promise<StorageObservation> {
    return this.call('observe', policy, reservation, roots, signal)
  }
}
