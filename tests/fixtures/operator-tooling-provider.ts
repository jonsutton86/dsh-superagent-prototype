/** OpenAI-compatible local model that emits the operator-tooling tool calls and never calls a network provider. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

type Request = { model: string; messages: { role: string; content?: unknown }[];
  tools?: { function: { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } } }[] }

export async function operatorToolingProvider(attachmentPathFile: string) {
  const providerKey = 'synthetic-tooling-' + randomUUID()
  const failures: string[] = []
  const calls: { at: number; name: string; arguments: Record<string, unknown> }[] = []
  let coordinator = 'triggers'
  let worker = 'read'
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== 'Bearer ' + providerKey)
        throw new Error('fixture_request_refused')
      let bytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of incoming) {
        bytes += chunk.length
        if (bytes > 2 * 1024 * 1024) throw new Error('fixture_request_bytes')
        chunks.push(chunk)
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request
      const has = (name: string) => request.tools?.some(tool => tool.function.name === name)
      const workerTurn = has('orchestrator_file_read') || has('bash') && has('orchestrator_report')
      const text = request.messages.map(message => typeof message.content === 'string' ? message.content
        : Array.isArray(message.content) ? message.content.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('\n') : '').join('\n')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write('data: ' + JSON.stringify({
        id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n')
      const tool = (name: string, args: Record<string, unknown>) => {
        const schema = request.tools?.find(value => value.function.name === name)?.function.parameters
        if (!schema) throw new Error('fixture_tool_missing')
        calls.push({ at: Date.now(), name, arguments: args })
        emit({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        emit({}, 'tool_calls')
      }
      emit({ role: 'assistant', content: '' })
      if (!workerTurn) {
        if (coordinator === 'triggers') { tool('orchestrator_read', { resource: 'triggers' }); coordinator = 'route' }
        else if (coordinator === 'route') {
          const ids = [...text.matchAll(/"trigger_id":"([a-f0-9]{32})"/g)]
          const id = ids.at(-1)?.[1]
          if (!id) throw new Error('fixture_trigger_id_missing')
          tool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: id, title: 'Check the repo', worktree_name: 'check-repo',
            acknowledgement: 'Checking the repository.' }] })
          coordinator = 'repository'
        } else if (coordinator === 'repository') { tool('orchestrator_read', { resource: 'repository/directory/' }); coordinator = 'done' }
        else emit({ content: 'The stored trigger is routed.' }, 'stop')
      } else if (worker === 'read') {
        const path = readFileSync(attachmentPathFile, 'utf8').trim()
        tool('orchestrator_file_read', { path })
        worker = 'report'
      } else if (worker === 'report') {
        tool('orchestrator_report', { state: 'ready', summary: text.includes('attached note') ? 'Read the attached note.' : 'Worker finished without the note text.' })
        worker = 'done'
      } else emit({ content: 'The worker is done.' }, 'stop')
      response.write('data: ' + JSON.stringify({ id: 'fixture-usage', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      if (failures.length < 8) failures.push(error instanceof Error ? error.message : 'fixture_failed')
      response.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', providerKey, calls, failures,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
