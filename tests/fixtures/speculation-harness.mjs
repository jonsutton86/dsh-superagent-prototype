/** Test-only admission and message sink. Uses the real Runtime/Engine/Harness worker, with no real external channel. */
import { z } from 'zod'
import { appendFile } from 'node:fs/promises'
export const name = 'speculation-qualification'
export const inject = ['orchestrator', 'webServer']
export const Config = z.object({ sink: z.string(), token: z.string(), proof: z.string() })
export function apply(ctx, config) {
  const runtime = ctx.orchestrator
  ctx.effect(() => runtime.sources.register({ kind: 'probe', title: { en: 'Qualification sink', zh: '测试' }, description: { en: '', zh: '' },
    schema: z.object({}), fields: [], health: [], scope: () => ({ listened: true, observed: true }),
    channel: { send: async (_host, message) => { await appendFile(config.sink, JSON.stringify(message) + '\n'); return 'sent' },
      link: () => ({ url: '', label: { en: 'Fixture sink', zh: '测试' } }) } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/qualification', handler: async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-qualification-token'] !== config.token) { res.writeHead(403); res.end(); return }
    try {
      await runtime.ready
      const settings = runtime.store.settings()
      await runtime.settings.save('eval', { ...settings.eval, mode: 'auto' }, runtime.store.blockRevision('eval'), 'panel')
      await runtime.settings.save('policy', { ...settings.policy, sources: { ...settings.policy.sources, probe: { allowed: [{ id: 'fixture' }], admission: {} } },
        rules: [{ id: 'probe', name: 'Local preparation', enabled: true, instruction: 'Prepare the synthetic local result; use no external services.' }] }, runtime.store.blockRevision('policy'), 'panel')
      const trigger = { id: 'qualification-speculation', source: 'probe', actor: { source: 'probe', id: 'fixture' }, human: true,
        threads: [{ source: 'probe', id: 'result' }], at: new Date().toISOString(), meta: {},
        text: 'Prepare a local result using bash to write result.txt with exactly ' + config.proof + ', without a newline. Publish that exact content as an artifact in the workspace library, then report ready. Use no external services and do not delegate. Report failed if any operation fails.',
        channel: { source: 'probe', thread: 'probe:result', address: { id: 'synthetic-sink' } } }
      runtime.engine.receive(trigger)
      // Deterministic test assessment; the inferred worker, tools, model accounting and publication path are real.
      const decision = runtime.engine.decide(trigger.id, { kind: 'accept', title: 'Qualify speculative preparation', name: 'speculation-proof',
        scope: trigger.text, reason: 'Synthetic positive assessment', rules: ['probe'], acknowledgement: 'Synthetic queued acknowledgement' })
      runtime.passes.request()
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(decision))
    } catch (error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(error)) }
  } }))
}
