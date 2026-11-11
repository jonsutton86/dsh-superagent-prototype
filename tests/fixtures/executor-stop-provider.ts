/** Synthetic loopback model for the installed original-stop boundary; it never executes an external provider request. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

type Request = { model: string; messages: { role: string; content?: unknown }[];
  tools?: { function: { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } } }[] }
export async function executorStopProvider(command: string, replacementCommand: string, inputMarker: string) {
  const providerKey = 'synthetic-stop-' + randomUUID(), failures: string[] = []
  const requests: { at: number; phase: string; replacementCard: boolean; queuedInput: boolean }[] = []
  const calls: { at: number; name: string; phase: string }[] = []
  let phase = 'original_launch', totalRequests = 0
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== 'Bearer ' + providerKey) throw new Error('fixture_request_refused')
      if (++totalRequests > 32) throw new Error('fixture_request_limit')
      let bytes = 0; const chunks: Buffer[] = []
      for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('fixture_request_bytes'); chunks.push(chunk) }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request
      const has = (name: string) => request.tools?.some(tool => tool.function.name === name)
      const worker = has('bash') && has('orchestrator_report')
      const messages = request.messages.map(message => typeof message.content === 'string' ? message.content : Array.isArray(message.content)
        ? message.content.flatMap(part => typeof part?.text === 'string' ? [part.text] : []).join('\n') : '').join('\n')
      const replacementCard = /"assignment"\s*:\s*2\b/.test(messages)
      const queuedInput = messages.includes(inputMarker)
      if (worker) requests.push({ at: Date.now(), phase, replacementCard, queuedInput })
      else if (!has('orchestrator_read') || !has('orchestrator_route')) throw new Error('fixture_unexpected_role')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write('data: ' + JSON.stringify({
        id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n')
      const tool = (name: string, args: Record<string, unknown>) => {
        const schema = request.tools?.find(value => value.function.name === name)?.function.parameters
        if (!schema || Object.keys(args).some(key => !Object.hasOwn(schema.properties ?? {}, key))
          || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) throw new Error('fixture_tool_schema')
        calls.push({ at: Date.now(), name, phase })
        emit({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        emit({}, 'tool_calls')
      }
      emit({ role: 'assistant', content: '' })
      if (!worker) emit({ content: 'Synthetic coordinator has no routing action.' }, 'stop')
      else if (phase === 'original_launch') {
        tool('bash', { command, description: 'Run the original owned stop-boundary heartbeat', run_in_background: true }); phase = 'original_report'
      } else if (phase === 'original_report') {
        tool('orchestrator_report', { state: 'blocked', summary: 'Synthetic stop qualification awaits an explicit operator retry; the original heartbeat remains owned by this assignment.' }); phase = 'original_idle'
      } else if (phase === 'original_idle') {
        phase = 'held'; emit({ content: 'Awaiting the operator while the existing background job runs.' }, 'stop')
      } else if (phase === 'held') {
        if (!replacementCard) throw new Error('fixture_native_wake_without_replacement_assignment')
        tool('bash', { command: replacementCommand, description: 'Write the one replacement execution receipt' }); phase = 'replacement_result'
      } else if (phase === 'replacement_result' || phase === 'waiting_for_input') {
        if (queuedInput) {
          tool('orchestrator_report', { state: 'ready', summary: 'The original job is quiet, the one replacement ran and the one queued input was received.' }); phase = 'done'
        } else { phase = 'waiting_for_input'; emit({ content: 'Waiting for the already accepted queued input.' }, 'stop') }
      } else emit({ content: 'The replacement is complete; no further execution is authorized.' }, 'stop')
      response.write('data: ' + JSON.stringify({ id: 'fixture-usage', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      if (failures.length < 8) failures.push(error instanceof Error && /^fixture_[a-z_]+$/.test(error.message) ? error.message : 'fixture_failed')
      response.destroy()
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1', providerKey, requests, calls, failures,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
