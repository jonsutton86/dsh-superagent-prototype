/** Scripted acceptance fixture, never evidence of semantic model quality. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

export async function supervisionEvaluationProvider() {
  const providerKey = 'synthetic-supervision-evaluation-key', privateCanary = 'synthetic-private-evaluation-provider-body'
  const requests: { model: string; body: string }[] = [], failures: string[] = []
  let onRequest: (() => void) | undefined
  let beforeOversized: (() => Promise<void>) | undefined
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== `Bearer ${providerKey}`)
        throw new Error('Unexpected synthetic provider request')
      let body = ''; for await (const part of incoming) { body += part; if (body.length > 2_000_000) throw new Error('Oversized fixture request') }
      const request = JSON.parse(body) as { model: string; messages: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[];
        tools?: { function: { name: string } }[] }
      const prior = request.messages.flatMap(message => message.tool_calls?.map(tool => tool.function.name) ?? [])
      requests.push({ model: request.model, body }); onRequest?.()
      if (request.model === 'provider-error' || request.model === 'post-assessment-error' && prior.includes('watchdog_assess')) {
        response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'server_error', message: privateCanary + ' ' + providerKey } })); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
      if (request.model === 'hanging') return
      const tools = request.tools?.map(tool => tool.function.name).sort()
      if (JSON.stringify(tools) !== JSON.stringify(['watchdog_assess', 'watchdog_observe', 'watchdog_request_status'])) throw new Error('Unexpected assessor tool boundary')
      const source = [...request.messages].reverse().find(message => message.role === 'user' && typeof message.content === 'string'
        && message.content.includes('Assess this independent watchdog incident.'))?.content as string | undefined
      if (!source) throw new Error('Missing actual production incident delivery')
      const incident = JSON.parse(source.slice(source.lastIndexOf('\n') + 1)) as { id: string; revision: string }
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write('data: ' + JSON.stringify({
        id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n')
      const tool = (name: string, args: unknown) => {
        emit({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        emit({}, 'tool_calls')
      }
      emit({ role: 'assistant', content: '' })
      if (request.model === 'oversized') { await beforeOversized?.(); emit({ content: 'x'.repeat(1100000) }, 'stop') }
      else if (request.model === 'incomplete' && prior.includes('watchdog_assess')) emit({ content: 'Synthetic response ended at the token limit.' }, 'length')
      else if (request.model === 'looping' || !prior.includes('watchdog_observe')) tool('watchdog_observe', { incidentId: incident.id })
      else if (!prior.includes('watchdog_assess')) tool('watchdog_assess', { incidentId: incident.id, incidentRevision: incident.revision, finding: 'stalled',
        evidence: 'Synthetic acceptance only: a specific stopped checkpoint is reported. ' + providerKey })
      else if (!prior.includes('watchdog_request_status')) tool('watchdog_request_status', { incidentId: incident.id, incidentRevision: incident.revision })
      else emit({ content: 'Synthetic assessment and inert request recorded.' }, 'stop')
      response.write('data: ' + JSON.stringify({ id: 'fixture-usage', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch { failures.push('Synthetic evaluation provider validation failed'); response.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, providerKey, privateCanary, requests, failures,
    onRequest(callback?: () => void) { onRequest = callback },
    beforeOversized(callback?: () => Promise<void>) { beforeOversized = callback },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
