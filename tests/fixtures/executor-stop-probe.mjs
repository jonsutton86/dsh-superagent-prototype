/** Private installed-test fault: ignore one original kill dispatch; observe real wait/settlement and admission metadata. */
import { openSync, fstatSync, writeSync, fsyncSync, closeSync, constants } from 'node:fs'
import { z } from 'zod'
export const name = 'executor-stop-qualification'
export const inject = ['jobs', 'agents', 'llm', 'orchestrator']
export const Config = z.object({ trace: z.string().startsWith('/') }).strict()
export function apply(ctx, config) {
  const fd = openSync(config.trace, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  const metadata = fstatSync(fd)
  if (!metadata.isFile() || metadata.mode & 0o077 || metadata.size !== 0) { closeSync(fd); throw new Error('stop_trace_unavailable') }
  let bytes = 0, ignoredJob = null, closed = false
  const write = (type, fields = {}) => {
    if (closed) return
    const line = Buffer.from(JSON.stringify({ type, at: Date.now(), ...fields }) + '\n')
    if (bytes + line.length > 1024 * 1024) throw new Error('stop_trace_capacity')
    if (writeSync(fd, line) !== line.length) throw new Error('stop_trace_unavailable')
    fsyncSync(fd); bytes += line.length
  }
  const state = sessionId => {
    const ticketId = sessionId.slice('worker-'.length), runtime = ctx.orchestrator, ticket = runtime.store.tickets.get(ticketId)
    return { sessionId, ticketId, stopHeld: runtime.executor.stops.holds(ticketId).length > 0,
      assignments: ticket?.assignments.map(value => ({ id: value.id, state: value.state })) ?? [] }
  }
  const jobs = ctx.jobs, kill = jobs.kill, wait = jobs.wait
  const wrappedKill = function(id, caller, reason) {
    if (String(caller).startsWith('worker-')) {
      const ignored = ignoredJob === null
      if (ignored) ignoredJob = id
      write('job/kill', { jobId: id, caller, ignored })
      if (ignored) return undefined // Explicit fault injection, not evidence of resistance to an actual OS signal.
    }
    return Reflect.apply(kill, this, [id, caller, reason])
  }
  const wrappedWait = async function(id, timeoutMs, caller, signal) {
    const at = Date.now()
    try {
      const result = await Reflect.apply(wait, this, [id, timeoutMs, caller, signal])
      if (String(caller).startsWith('worker-')) write('job/wait-return', { jobId: id, caller, timeoutMs, elapsedMs: Date.now() - at, status: result.status })
      return result
    } catch (error) {
      if (String(caller).startsWith('worker-')) write('job/wait-aborted', { jobId: id, caller, timeoutMs, elapsedMs: Date.now() - at })
      throw error
    }
  }
  jobs.kill = wrappedKill; jobs.wait = wrappedWait
  ctx.jobs.events.subscribe({ owners: 'scope' }, event => {
    if (!String(event.job?.owner).startsWith('worker-') || !['registered', 'settled', 'removed'].includes(event.type)) return
    write('job/' + event.type, { jobId: event.job.id, status: event.job.status, awaited: event.awaited ?? null,
      cause: event.cause ?? null, ...state(event.job.owner) })
  })
  ctx.on('session/event', (session, event) => {
    if (!String(session.id).startsWith('worker-')) return
    const selected = state(session.id)
    if (['turn/start', 'turn/end', 'step/start'].includes(event.type)) write(event.type, { ...selected, turn: event.data.turn, step: event.data.step })
    if (event.type === 'user/message') write(event.type, { ...selected, messageId: event.data.id, source: event.data.source.kind })
    if (event.type === 'tool/call') write(event.type, { ...selected, name: ['bash', 'orchestrator_report'].includes(event.data.name) ? event.data.name : 'other' })
  })
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (String(agent.id).startsWith('worker-')) write('inbox/claimed', { ...state(agent.id), messageId: message.id, source: message.source.kind })
  })
  ctx.on('agent/request', ({ agent, turn, step }, next) => {
    if (String(agent.id).startsWith('worker-')) write('agent/request', { ...state(agent.id), turn, step })
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (options, next) {
    if (String(options.sessionId).startsWith('worker-')) write('llm/stream', state(options.sessionId))
    yield* next()
  }, { prepend: true })
  ctx.on('agent/error', ({ agent }) => { if (String(agent.id).startsWith('worker-')) write('agent/error', state(agent.id)) })
  ctx.effect(() => () => {
    if (jobs.kill === wrappedKill) jobs.kill = kill
    if (jobs.wait === wrappedWait) jobs.wait = wait
    if (!closed) { write('probe/closed'); closed = true; closeSync(fd) }
  })
  write('probe/ready', { fault: 'ignore_exactly_one_original_jobs_kill_dispatch' })
}
