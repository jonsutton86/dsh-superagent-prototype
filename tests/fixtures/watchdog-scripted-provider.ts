/** Scripted OpenAI wire responses, not an evaluator of diagnosis quality. All requests and credentials are synthetic. */
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

type Request = { model: string; messages: { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }[];
  tools?: { function: { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } } }[] }
export async function watchdogScriptedProvider(command: string, proof: string) {
  const requests: Request[] = [], calls: { name: string; args: Record<string, unknown> }[] = [], failures: string[] = []
  const hanging = new Set<ServerResponse>(), assessments = new Set<string>()
  let mode: 'error' | 'hang' | 'assess' = 'error', workerPhase: 'start' | 'job' | 'publish' | 'report' | 'done' = 'start', jobId = ''
  let errors = 0, hangs = 0, aborted = 0
  const providerKey = 'synthetic-watchdog-process-key', privateCanary = 'synthetic-provider-body-do-not-persist'
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== `Bearer ${providerKey}`)
        throw new Error('Unexpected synthetic provider request')
      let body = ''; for await (const part of incoming) { body += part; if (body.length > 2_000_000) throw new Error('Oversized fixture request') }
      const request = JSON.parse(body) as Request; requests.push(request)
      const has = (name: string) => request.tools?.some(tool => tool.function.name === name)
      if (has('watchdog_assess') && mode === 'error') {
        errors++; response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: privateCanary, type: 'server_error' } })); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
      if (has('watchdog_assess') && mode === 'hang') {
        hangs++; hanging.add(response); response.once('close', () => { hanging.delete(response); aborted++ }); return
      }
      const emit = (delta: unknown, finish_reason: string | null = null) => response.write('data: ' + JSON.stringify({
        id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [{ index: 0, delta, finish_reason }],
      }) + '\n\n')
      const tool = (name: string, args: Record<string, unknown>) => {
        const schema = request.tools?.find(tool => tool.function.name === name)?.function.parameters
        if (!schema) throw new Error('Harness did not advertise fixture tool ' + name)
        for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties ?? {}, key)) throw new Error('Harness tool does not accept ' + name + '.' + key)
        for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error('Fixture omitted required ' + name + '.' + key)
        calls.push({ name, args }); emit({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
        emit({}, 'tool_calls')
      }
      emit({ role: 'assistant', content: '' })
      if (has('watchdog_assess')) {
        const source = [...request.messages].reverse().find(message => message.role === 'user' && typeof message.content === 'string'
          && message.content.includes('Assess this independent watchdog incident.'))?.content as string | undefined
        if (!source) throw new Error('Missing actual watchdog incident delivery')
        const incident = JSON.parse(source.slice(source.lastIndexOf('\n') + 1)) as { id: string; revision: string }
        if (!assessments.has(incident.revision)) {
          assessments.add(incident.revision)
          tool('watchdog_assess', { incidentId: incident.id, incidentRevision: incident.revision, finding: 'progressing',
            evidence: 'Scripted fixture: the authorized local sampling job is still producing its output. Quiet reports alone are not a deadlock.' })
        } else emit({ content: 'Synthetic assessment recorded.' }, 'stop')
      } else if (has('bash') && has('orchestrator_report')) {
        const results = request.messages.filter(message => message.role === 'tool').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))
        if (workerPhase === 'start') {
          tool('bash', { description: 'Produce the local qualification artifact over time', command, run_in_background: true }); workerPhase = 'job'
        } else if (workerPhase === 'job') {
          jobId ||= results.join('\n').match(/started background job ([^\s]+)/)?.[1] ?? ''
          if (!jobId) throw new Error('Actual Harness bash response did not contain its background job ID')
          const last = results.at(-1) ?? ''
          if (last.includes('QUALIFICATION_DONE') && /completed/.test(last)) {
            tool('workspace_publish', { requestId: 'productive-job-artifact', kind: 'artifact', title: 'Productive watchdog qualification',
              summary: 'Output from the real Harness background job', mime: 'text/plain', filename: 'proof.txt', encoding: 'utf8', content: proof, sources: [] }); workerPhase = 'report'
          } else tool('job_output', { job_id: jobId, wait: true, timeout_ms: 1000 })
        } else if (workerPhase === 'report') {
          tool('orchestrator_report', { state: 'ready', summary: 'The local job finished and its checked artifact is published.' }); workerPhase = 'done'
        } else emit({ content: 'Fixture task completed.' }, 'stop')
      } else emit({ content: 'Synthetic coordinator has no routing action.' }, 'stop')
      response.write('data: ' + JSON.stringify({ id: 'fixture-usage', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    } catch (error) { failures.push(String(error)); response.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, providerKey, privateCanary, requests, calls, failures,
    mode(value: typeof mode) { mode = value }, counts: () => ({ errors, hangs, aborted }),
    async close() { for (const response of hanging) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
