/** Synthetic OpenAI endpoint. Worker requests fail; unrelated coordinator requests finish without tools. */
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'

export async function executorRecoveryProvider() {
  const providerKey = 'synthetic-executor-recovery-key', privateCanary = 'synthetic-private-provider-body-' + randomUUID()
  const failures: string[] = [], workerRequests: { at: number; sha256: string }[] = []
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== `Bearer ${providerKey}`)
        throw new Error('Unexpected synthetic provider request')
      let body = ''
      for await (const part of incoming) { body += part; if (body.length > 2_000_000) throw new Error('Oversized fixture request') }
      const request = JSON.parse(body) as { model: string; tools?: { function: { name: string } }[] }
      if (request.tools?.some(tool => tool.function.name === 'orchestrator_report')) {
        workerRequests.push({ at: Date.now(), sha256: createHash('sha256').update(body).digest('hex') })
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: privateCanary, type: 'server_error' } })); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish_reason: string | null) => response.write('data: ' + JSON.stringify({
        id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n')
      chunk({ role: 'assistant', content: 'Synthetic coordinator has no routing action.' }, null)
      chunk({}, 'stop'); response.end('data: [DONE]\n\n')
    } catch { failures.push('Synthetic provider request failed validation'); response.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, providerKey, privateCanary, failures, workerRequests,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
