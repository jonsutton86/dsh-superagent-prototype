/** Evaluation-only Harness probe: exact Session request budget and bounded metadata, never model text or tool arguments. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { constants, openSync, fstatSync, closeSync, writeSync, fsyncSync } from 'node:fs'
import { z } from 'zod'
import { WATCHDOG_TOOL_NAMES } from './assessment-contract.ts'

export const name = 'dsh-supervision-evaluation-probe'
export const inject = ['agents', 'llm']
export const Config = z.object({ sessionId: z.string().min(1).max(200), trace: z.string().startsWith('/'), maxRequests: z.number().int().min(1).max(64), expectedContract: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const Usage = z.object({ inputTokens: counter, outputTokens: counter, cacheReadTokens: counter.optional(), cacheWriteTokens: counter.optional() })
export const EVALUATION_STREAM_LIMITS = { attemptBytes: 1024 * 1024, caseBytes: 4 * 1024 * 1024 } as const
const endReasons = new Set(['completed', 'error', 'blocked', 'max-tokens', 'aborted', 'interrupted', 'forked'])
export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  let fd: number
  try {
    fd = openSync(config.trace, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.mode & 0o077 || stat.size !== 0 || process.getuid && stat.uid !== process.getuid()) { closeSync(fd); throw new Error() }
  } catch { throw new Error('evaluation_trace_unavailable') }
  let closed = false, bytes = 0, requests = 0, contractVerified = false, streamBytes = 0, streamLimited = false
  const write = (type: string, fields: Record<string, unknown> = {}) => {
    if (closed) return
    const line = Buffer.from(JSON.stringify({ type, at: Date.now(), ...fields }) + '\n')
    if (bytes + line.length > 1024 * 1024) throw new Error('evaluation_trace_capacity')
    try {
      if (writeSync(fd, line) !== line.length) throw new Error()
      fsyncSync(fd); bytes += line.length
    } catch { throw new Error('evaluation_trace_unavailable') }
  }
  const stream = async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (closed) throw new Error('evaluation_stopped')
    if (!contractVerified) { write('contract_refused'); throw new Error('evaluation_contract_unverified') }
    if (options.sessionId !== config.sessionId) { write('scope_refused'); throw new Error('evaluation_session_refused') }
    if (streamLimited) { write('stream_limit'); throw new Error('evaluation_stream_limit') }
    if (requests >= config.maxRequests) { write('request_limit'); throw new Error('evaluation_request_limit') }
    const ordinal = ++requests; write('request', { ordinal })
    let usage: z.infer<typeof Usage> | null = null, positiveUsage: z.infer<typeof Usage> | null = null, terminal = false, attemptBytes = 0
    try {
      for await (const chunk of next()) {
        let size: number
        try { size = Buffer.byteLength(JSON.stringify(chunk)) } catch { streamLimited = true; write('stream_limit'); throw new Error('evaluation_stream_unserializable') }
        if (attemptBytes + size > EVALUATION_STREAM_LIMITS.attemptBytes || streamBytes + size > EVALUATION_STREAM_LIMITS.caseBytes) {
          streamLimited = true; write('stream_limit'); throw new Error('evaluation_stream_limit')
        }
        attemptBytes += size; streamBytes += size
        if (chunk.type === 'usage') {
          const parsed = Usage.safeParse(chunk.usage); usage = parsed.success ? parsed.data : null
          if (usage && Object.values(usage).some(value => value > 0)) positiveUsage = usage
        }
        if (chunk.type === 'finish') terminal = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind)
        yield chunk
      }
    } catch (error) { terminal = false; throw error }
    finally {
      // pi-ai synthesizes zero usage on failures; that is not evidence of zero consumption.
      if (!terminal) usage = positiveUsage
      write('settled', { ordinal, terminal, usage })
    }
  }
  ctx.on('llm/stream', stream, { prepend: true })
  ctx.on('superagent/watchdog-contract', contract => {
    if (contract.sessionId !== config.sessionId) return
    contractVerified = contract.version === 1 && contract.digest === config.expectedContract
    write(contractVerified ? 'contract_verified' : 'contract_refused', { version: contract.version, digest: contract.digest })
  })
  ctx.on('session/event', (session, event) => {
    if (session.id !== config.sessionId) return
    if (event.type === 'turn/start') write(event.type, { turn: event.data.turn })
    if (event.type === 'turn/end') write(event.type, { turn: event.data.turn, reason: endReasons.has(event.data.reason.kind) ? event.data.reason.kind : 'unknown' })
    if (event.type === 'tool/call') write('tool', { name: WATCHDOG_TOOL_NAMES.includes(event.data.name) ? event.data.name : 'other' })
  })
  ctx.on('agent/error', ({ agent }) => { if (agent.id === config.sessionId) write('agent/error') })
  ctx.provide('superagentEvaluationGate', { authorize: (sessionId, digest) => !closed && sessionId === config.sessionId && digest === config.expectedContract })
  ctx.effect(() => () => { if (!closed) { closed = true; closeSync(fd) } })
}
