/** Installed-Harness role-boundary probe. A denied late local tool would otherwise write only a disposable canary. */
import { z } from 'zod'
import { stat, writeFile } from 'node:fs/promises'
export const name = 'router-authority-qualification'
export const inject = ['orchestrator', 'webServer', 'agents', 'tools']
export const Config = z.object({ token: z.string(), canary: z.string() })
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/qualification-router', handler: async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-qualification-token'] !== config.token) { res.writeHead(403); res.end(); return }
    try {
      const runtime = ctx.orchestrator; await runtime.ready
      const agent = ctx.agents.get(runtime.masterId)
      if (!agent) throw new Error('Coordinator Session unavailable')
      const dispose = agent.ctx.tools.register({ name: 'qualification_execute', description: 'Disposable execution canary', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, execute: async () => { await writeFile(config.canary, 'executed'); return 'executed' } })
      try {
        const call = (name, args) => ctx.tools.execute({ callId: `probe-${name}`, name, arguments: args, agent, signal: new AbortController().signal })
        const denied = await call('qualification_execute', {})
        const context = await call('orchestrator_read', { resource: 'tickets' })
        const canary = await stat(config.canary).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ denied: JSON.stringify(denied).includes('routing authority only'),
          contextRead: !context.isError && JSON.stringify(context).includes('items'), canary }))
      } finally { dispose() }
    } catch (error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(error)) }
  } }))
}
