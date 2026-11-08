import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { FsError, type FsErrorCode } from '@deepseek-ai/dsh-fs'
import { z } from 'zod'
import { RPC_PATH, RemoteError, type RpcInput, type RemoteOperation } from './protocol.ts'

const Envelope = z.object({ endpointId: z.string(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() })
const refused = (error: unknown) => error instanceof FsError || error instanceof RemoteError && error.status < 500
/** An operation may have crossed the remote effect boundary; callers retain its ID and reconcile instead of rerunning it. */
export class RemoteUncertain extends Error {
  constructor(readonly operationId: string, message: string) { super(`${message} (remote operation ${operationId}); reconcile this receipt before issuing replacement work`) }
}
export interface RemoteConnection { url: string; endpointId: string; credentialFile: string; lifetime?: AbortSignal; timeoutMs?: number }
export interface RemoteEffectHooks {
  prepare(request: RpcInput & { requestId: string }): RpcInput & { requestId: string }
  observed(request: RpcInput, value: unknown): void
  failed(request: RpcInput, error: unknown, ambiguous: boolean): void
}

/** Pinned, bounded RPC for both members of one remote Harness execution world. */
export class RemoteClient {
  private readonly url: string
  private credentialPin?: string
  constructor(readonly connection: RemoteConnection, private readonly authorize?: (request: RpcInput) => void, private readonly effects?: RemoteEffectHooks,
    private readonly credentialReader = () => readFileSync(connection.credentialFile, 'utf8').trim()) {
    const url = new URL(connection.url)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')))
      throw new Error('Execution endpoint must be an HTTPS origin or a loopback HTTP origin reached through a secure tunnel')
    if (!connection.endpointId) throw new Error('Execution endpoint identity must be pinned')
    this.url = url.origin + RPC_PATH
  }
  /** A composed world cannot inherit a replacement grant merely because its credential file was overwritten. */
  bindGrant(grant: { id: string; epoch: number }): void {
    const credential = this.credentialReader()
    if (!credential.startsWith(`grant.${grant.id}.${grant.epoch}.`)) throw new RemoteError(409, 'grant_changed', 'Credential no longer matches this execution world')
    const pin = createHash('sha256').update(credential).digest('hex')
    if (this.credentialPin && this.credentialPin !== pin) throw new RemoteError(409, 'grant_changed', 'Execution world credential changed')
    this.credentialPin = pin
  }
  async call<T>(request: RpcInput, signal?: AbortSignal): Promise<T> {
    if (this.effects && (request.op === 'job.spawn' || request.op === 'fs.write' || request.op === 'fs.edit'))
      return this.intent<T>(request, signal)
    return this.send<T>(request, signal)
  }
  private async send<T>(request: RpcInput, signal?: AbortSignal): Promise<T> {
    this.authorize?.(request)
    const credential = this.credentialReader()
    if (credential.length < 32 || /\s/.test(credential)) throw new Error('Invalid execution credential file')
    if (this.credentialPin && this.credentialPin !== createHash('sha256').update(credential).digest('hex'))
      throw new RemoteError(409, 'grant_changed', 'Execution world credential changed; compose a new world')
    const response = await fetch(this.url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.connection.timeoutMs ?? 10_000), ...[signal, this.connection.lifetime].filter((value): value is AbortSignal => !!value)]),
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', 'x-dsh-endpoint': this.connection.endpointId }, body: JSON.stringify(request) })
    if (!response.body) throw new Error('Endpoint returned no body')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
        if (size > 8 * 1024 * 1024) throw new Error('Endpoint response exceeds 8 MiB'); chunks.push(chunk.value) }
    } finally { await reader.cancel() }
    const envelope = Envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (envelope.endpointId !== this.connection.endpointId) throw new RemoteError(409, 'endpoint_mismatch', 'Endpoint identity changed')
    if (envelope.error) {
      if (envelope.error.code.startsWith('FS_')) throw new FsError(envelope.error.message, envelope.error.code as FsErrorCode)
      throw new RemoteError(response.status, envelope.error.code, envelope.error.message)
    }
    if (!response.ok) throw new RemoteError(response.status, 'http_error', 'Execution endpoint request failed')
    this.effects?.observed(request, envelope.result)
    return envelope.result as T
  }
  /** Reconnect observations by the same command ID. Losing connectivity never starts replacement work. */
  async observe<T>(request: RpcInput, operationId: string): Promise<T> {
    const until = Date.now() + 30_000
    for (;;) {
      try { return await this.call<T>(request) }
      catch (error) {
        if (refused(error)) { this.effects?.failed(request, error, true); throw error }
        if (Date.now() >= until || this.connection.lifetime?.aborted) {
          const uncertain = new RemoteUncertain(operationId, 'Endpoint did not reconnect before the observation deadline')
          this.effects?.failed(request, uncertain, true); throw uncertain
        }
        await new Promise<void>(resolve => setTimeout(resolve, 200))
      }
    }
  }
  /** Retries the identical durable intent, never a fresh ID; a second lost response stays explicitly uncertain. */
  async intent<T>(request: RpcInput & { requestId: string }, signal?: AbortSignal): Promise<T> {
    request = this.effects?.prepare(request) ?? request
    try { return await this.send<T>(request, signal) }
    catch (error) {
      if (refused(error) || signal?.aborted || this.connection.lifetime?.aborted) {
        this.effects?.failed(request, error, !refused(error))
        if (refused(error)) throw error
        throw new RemoteUncertain(request.requestId, 'Delivery interrupted before the remote receipt was confirmed')
      }
      try { return await this.send<T>(request, signal) }
      catch (second) {
        this.effects?.failed(request, second, true)
        if (refused(second)) throw second
        throw new RemoteUncertain(request.requestId, 'Remote receipt could not be confirmed')
      }
    }
  }
  async mutation<T>(request: Omit<Extract<RpcInput, { op: 'fs.write' }>, 'requestId'> | Omit<Extract<RpcInput, { op: 'fs.edit' }>, 'requestId'>, signal?: AbortSignal): Promise<T> {
    const requestId = randomUUID()
    let receipt = await this.intent<RemoteOperation>({ ...request, requestId } as RpcInput & { requestId: string }, signal)
    while (receipt.phase === 'started') {
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      try { receipt = await this.call<RemoteOperation>({ op: 'operation.get', id: requestId }, signal) }
      catch (error) {
        this.effects?.failed({ op: 'operation.get', id: requestId }, error, true)
        throw new RemoteUncertain(requestId, 'File mutation receipt is unavailable')
      }
    }
    if (receipt.phase === 'unknown') throw new RemoteUncertain(requestId, receipt.error?.message ?? 'File mutation outcome is unknown')
    if (receipt.error) throw new FsError(receipt.error.message, receipt.error.code as FsErrorCode)
    return receipt.value as T
  }
}
