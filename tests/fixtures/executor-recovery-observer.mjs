/** Read-only installed Harness event probe. Records identities/counts, never provider errors, prompts or credentials. */
import { appendFileSync } from 'node:fs'
import { z } from 'zod'
export const name = 'executor-recovery-observer'
export const inject = ['agents']
export const Config = z.object({ trace: z.string() })
export function apply(ctx, config) {
  const write = (session, type, data = {}) => {
    if (!String(session.id).startsWith('worker-')) return
    appendFileSync(config.trace, JSON.stringify({ sessionId: session.id, type, at: Date.now(), ...data }) + '\n', { mode: 0o600 })
  }
  ctx.on('session/event', (session, event) => {
    if (!['turn/start', 'turn/end', 'step/start', 'llm/retry', 'llm/retry-started'].includes(event.type)) return
    const data = event.data, selected = {}
    for (const key of ['turn', 'step', 'retry', 'maxRetries', 'delayMs']) if (Number.isFinite(data[key])) selected[key] = data[key]
    if (typeof data.retryId === 'string') selected.retryId = data.retryId
    write(session, event.type, selected)
  })
  ctx.on('agent/request', ({ agent, turn, step }, next) => { write(agent.session, 'agent/request', { turn, step }); return next() })
  ctx.on('agent/error', ({ agent, turn, step }) => { write(agent.session, 'agent/error', { turn, step }) })
}
