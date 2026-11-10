/** Uses an explicitly supplied installed Harness package; every HTTP request stays on a loopback mock. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { abliterationProvider } from '../../src/providers/abliteration-config.ts'
import { installAbliterationGuard } from '../../src/providers/abliteration-guard.ts'

const requireHarness = createRequire(join(process.argv[2], 'package.json'))
const load = name => import(pathToFileURL(requireHarness.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: LlmRuntime } = await load('@deepseek-ai/dsh-llm')
const pi = await load('@deepseek-ai/dsh-llm-pi-ai')
const version = JSON.parse(await readFile(join(process.argv[2], 'package.json'), 'utf8')).version
const requests = [], key = 'synthetic-loopback-key'
let mode = 'text', configured = true
const server = createServer(async (request, response) => {
  let text = ''; for await (const part of request) text += part
  assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions')
  assert.equal(request.headers.authorization, `Bearer ${key}`)
  requests.push(JSON.parse(text))
  if (mode === 'error') { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Unavailable', type: 'server_error' } })); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (delta, finish_reason = null, usage) => response.write('data: ' + JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1,
    model: requests.at(-1).model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n')
  emit({ role: 'assistant', content: '' })
  if (mode === 'tool') {
    emit({ tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }] })
    emit({ tool_calls: [{ index: 0, function: { arguments: '"evidence"}' } }] })
    emit({}, 'tool_calls')
  } else { emit({ content: 'mock ' }); emit({ content: 'answer' }); emit({}, 'stop') }
  emit({}, null, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
  response.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ctx = new Context()
try {
  ctx.reflect.provide('credentials', { resolve: async ref => configured && ref === 'ABLIT_KEY' ? { value: key } : undefined,
    readRecord: async () => undefined, listRecords: async () => [] })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1l0AAAAASUVORK5CYII=', 'base64')
  ctx.reflect.provide('attachments', { imageHostPath: () => undefined, readImageRequest: async ref => ({ variantId: 'mock-image', attachment: ref,
    data: png, mediaType: 'image/png', bytes: png.length, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: true }) })
  await ctx.plugin(LlmRuntime)
  const profile = abliterationProvider(); profile.baseURL = `http://127.0.0.1:${server.address().port}/v1`
  await ctx.plugin(pi, { providers: { abliteration: profile } })
  installAbliterationGuard(ctx)
  const models = await ctx.llm.listModels('abliteration')
  assert.deepEqual(models.map(model => model.id).sort(), ['abliterated-model', 'abliterated-model-large-flash'].sort())
  const selected = await ctx.llm.resolveCallConfig({ provider: 'abliteration', model: 'abliterated-model-large-flash' })
  assert.equal(selected.maxTokens, 8192)
  const stream = async (input = {}) => {
    // Normal AgentLoop calls prepareCall before logging/freezing its request header, then uses this handle.
    const prepared = await ctx.llm.prepareCall({ provider: 'abliteration', model: 'abliterated-model-large-flash' })
    assert.equal(prepared.config.maxTokens, 8192); assert.equal(prepared.retryPolicy.maxRetries, 0)
    const chunks = []
    for await (const chunk of prepared.stream(Object.freeze({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], ...input }))) chunks.push(chunk)
    return chunks
  }
  const text = await stream()
  assert.equal(text.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'mock answer')
  assert.ok(text.some(chunk => chunk.type === 'usage' && chunk.usage.inputTokens === 12 && chunk.usage.outputTokens === 3))
  assert.equal(requests.at(-1).max_tokens, 8192); assert.equal(requests.at(-1).stream, true)
  assert.equal(requests.at(-1).reasoning_effort, 'low')
  mode = 'tool'
  const tools = await stream({ tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] })
  const tool = tools.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(tool?.block.name, 'lookup'); assert.deepEqual(JSON.parse(tool.block.arguments), { query: 'evidence' })
  assert.equal(requests.at(-1).tools[0].function.name, 'lookup')
  mode = 'text'
  const image = { type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } }
  const images = [image, image, image, image]
  const withOffloaded = [{ role: 'user', content: [...images, { ...image, offloaded: true }] }]
  await stream({ messages: withOffloaded })
  const sentImages = requests.at(-1).messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url')
  assert.equal(sentImages.length, 4); assert.match(sentImages[0].image_url.url, /^data:image\/png;base64,/)
  const before = requests.length
  await assert.rejects(stream({ messages: [{ role: 'user', content: images }, { role: 'tool', toolCallId: 'old-call', content: [image] }] }), /four retained images/)
  assert.equal(requests.length, before)
  mode = 'error'
  const failed = await stream()
  assert.ok(failed.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'))
  assert.equal(requests.length, before + 1)
  configured = false
  const missing = await stream()
  assert.ok(missing.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'MISSING_CREDENTIAL'))
  assert.equal(requests.length, before + 1)
  process.stdout.write(JSON.stringify({ status: 'passed', harnessAdapter: version, cases: ['model-resolution', 'streaming-text', 'usage', 'output-cap',
    'tool-call-fragments', 'four-images', 'offloaded-image-omitted', 'tool-history-image-limit', 'single-failed-request', 'missing-credential'] }) + '\n')
} finally {
  await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
