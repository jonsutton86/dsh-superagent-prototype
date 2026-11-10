/** Bounded, synthetic loopback inference for the real-worker endurance operator. Never a semantic evaluator. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

/** Native tool-jobs completion is the only permission to consume a chunk result or launch the next chunk. */
export function enduranceWorker({ commands, proof }) {
  let phase = 'start', index = 0, jobId = ''
  const counts = { bash: 0, jobOutput: 0, nativeWakes: 0, completedChunks: 0, publish: 0, report: 0 }
  const content = message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n')
  const launch = () => { counts.bash++; phase = 'launched'; jobId = ''; return { name: 'bash', args: {
    description: 'Run synthetic endurance chunk ' + index, command: commands[index], run_in_background: true } } }
  return {
    snapshot: () => ({ ...counts, workerPhase: phase, chunkIndex: index }),
    next(messages) {
      const results = messages.filter(message => message.role === 'tool').map(content)
      if (phase === 'start') return launch()
      if (phase === 'launched' || phase === 'waiting') {
        if (!jobId) jobId = results.at(-1)?.match(/started background job ([^\s]+)/)?.[1] ?? ''
        if (!jobId) throw new Error('missing_job_identity')
        // A fast chunk may already have injected its one notice before the bash-result continuation.
        const notice = messages.some(message => message.role === 'user' && content(message).includes('background job ' + jobId + ' (')
          && content(message).includes('finished [status: completed') && content(message).includes('Read its output with job_output.'))
        if (notice) { counts.nativeWakes++; counts.jobOutput++; phase = 'output'; return { name: 'job_output', args: { job_id: jobId, wait: false } } }
        if (phase === 'waiting') throw new Error('worker_woke_without_native_completion')
        phase = 'waiting'; return { stop: 'The background chunk is running; its native completion notice will resume this assignment.' }
      }
      if (phase === 'output') {
        const result = results.at(-1) ?? ''
        if (!result.includes('ENDURANCE_CHUNK_DONE_' + index) || !result.includes('[status: completed, exit code: 0]')) throw new Error('chunk_output_not_completed')
        counts.completedChunks++; index++
        if (index < commands.length) return launch()
        phase = 'report'; counts.publish++; return { name: 'workspace_publish', args: { requestId: 'endurance-artifact', kind: 'artifact',
          title: 'Synthetic endurance proof', summary: 'Verified separately against the exact bounded local chunks', mime: 'text/plain', filename: 'proof.txt', encoding: 'utf8', content: proof, sources: [] } }
      }
      if (phase === 'report') { phase = 'done'; counts.report++; return { name: 'orchestrator_report', args: { state: 'ready', summary: 'All synthetic endurance chunks completed and the exact final proof artifact is published.' } } }
      return { stop: 'The synthetic mission is complete.' }
    },
  }
}
export async function enduranceProvider({ commands, proof, requestLimit }) {
  const providerKey = 'synthetic-endurance-' + randomUUID(), privateCanary = 'synthetic-endurance-provider-body'
  const counts = { requests: 0, worker: 0, watchdog: 0, coordinator: 0, errors: 0, hangs: 0, aborted: 0, statusRequests: 0 }
  const failures = [], hanging = new Set(), assessments = new Set()
  let mode = 'error'
  const workerScript = enduranceWorker({ commands, proof })
  const fail = code => { if (failures.length < 10) failures.push(code) }
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== `Bearer ${providerKey}`) throw new Error('request_refused')
      if (++counts.requests > requestLimit) throw new Error('request_limit')
      let bytes = 0, parts = []
      for await (const part of incoming) { bytes += part.length; if (bytes > 2 * 1024 * 1024) throw new Error('request_body_limit'); parts.push(part) }
      const request = JSON.parse(Buffer.concat(parts).toString('utf8'))
      const has = name => request.tools?.some(tool => tool.function.name === name)
      const watchdog = has('watchdog_assess'), worker = has('bash') && has('orchestrator_report')
      if (watchdog) counts.watchdog++; else if (worker) counts.worker++; else counts.coordinator++
      if (watchdog && mode === 'error') {
        counts.errors++; response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { type: 'server_error', message: privateCanary } })); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
      if (watchdog && mode === 'hang') { counts.hangs++; hanging.add(response); response.once('close', () => { hanging.delete(response); counts.aborted++ }); return }
      const emit = (delta, finish_reason = null) => response.write('data: ' + JSON.stringify({ id: 'fixture-' + randomUUID(), object: 'chat.completion.chunk', created: 1,
        model: request.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
      const tool = (name, args) => {
        const schema = request.tools?.find(tool => tool.function.name === name)?.function.parameters
        if (!schema || Object.keys(args).some(key => !Object.hasOwn(schema.properties ?? {}, key))
          || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) throw new Error('tool_schema_mismatch')
        if (name === 'watchdog_request_status') counts.statusRequests++
        emit({ tool_calls: [{ index: 0, id: 'call_' + randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }); emit({}, 'tool_calls')
      }
      emit({ role: 'assistant', content: '' })
      if (watchdog) {
        const source = [...request.messages].reverse().find(message => message.role === 'user' && typeof message.content === 'string'
          && message.content.includes('Assess this independent watchdog incident.'))?.content
        if (!source) throw new Error('missing_incident')
        const incident = JSON.parse(source.slice(source.lastIndexOf('\n') + 1))
        if (!assessments.has(incident.revision)) {
          if (assessments.size > 512) throw new Error('assessment_limit')
          assessments.add(incident.revision); tool('watchdog_assess', { incidentId: incident.id, incidentRevision: incident.revision,
            finding: 'unknown', evidence: 'Scripted endurance fixture: the supervised Session has an active local job. Metadata alone does not establish useful progress; the operator verifies the synthetic hash file separately.' })
        } else emit({ content: 'Synthetic assessment recorded; no worker intervention requested.' }, 'stop')
      } else if (worker) {
        const action = workerScript.next(request.messages)
        if (action.stop) emit({ content: action.stop }, 'stop'); else tool(action.name, action.args)
      } else {
        // Only the actual coordinator role is allowed; unexpected compaction/title calls fail closed.
        if (!has('orchestrator_read') || !has('orchestrator_route')) throw new Error('unexpected_model_purpose')
        emit({ content: 'Synthetic coordinator has no routing action.' }, 'stop')
      }
      response.write('data: ' + JSON.stringify({ id: 'fixture-usage', object: 'chat.completion.chunk', created: 1, model: request.model,
        choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n'); response.end('data: [DONE]\n\n')
    } catch (error) { fail(['request_refused', 'request_limit', 'request_body_limit', 'tool_schema_mismatch', 'missing_incident', 'assessment_limit', 'missing_job_identity', 'worker_woke_without_native_completion', 'chunk_output_not_completed', 'unexpected_model_purpose'].includes(error.message) ? error.message : 'fixture_failed'); response.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { url: `http://127.0.0.1:${server.address().port}/v1`, providerKey, privateCanary,
    snapshot: () => ({ ...counts, ...workerScript.snapshot(), activeHangs: hanging.size, failures: [...failures] }),
    mode(value) { if (!['error', 'hang', 'assess'].includes(value)) throw new Error('Invalid synthetic mode'); mode = value },
    async close() { for (const response of hanging) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
  }
}
