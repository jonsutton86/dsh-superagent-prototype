import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Voice } from '../src/voice/service.ts'
import { SpeechAdapter } from '../src/voice/adapters.ts'
import { VOICE_LIMITS as L, type VoiceConfig } from '../src/voice/model.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

const directories: string[] = [], voices: Voice[] = [], stores: Store[] = [], servers: Server[] = []
let host: Host | undefined
afterEach(async () => {
  await host?.stop(); host = undefined
  for (const voice of voices.splice(0)) await voice.stop()
  for (const store of stores.splice(0)) store.close()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
function directory() { const value = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-test-'))); directories.push(value); return value }
function wav() { const bytes = Buffer.alloc(32044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes }
async function provider() {
  const calls: { path: string; authorization?: string; body: string }[] = []
  let hang = false, status = 200, large = false, redirect = false
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part))
    calls.push({ path: req.url!, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() })
    if (hang) return
    if (redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end(); return }
    res.writeHead(status, { 'content-type': req.url!.endsWith('speech') ? 'audio/wav' : 'application/json' })
    res.end(large ? Buffer.alloc(L.outputBytes + 1) : status !== 200 ? 'sensitive upstream diagnostic' : req.url!.endsWith('speech') ? wav() : JSON.stringify({ text: 'Prepare a short briefing.' }))
  })
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const config: VoiceConfig = { input: { kind: 'http', mode: 'local', url, model: 'test-stt' }, output: { kind: 'http', mode: 'local', url, model: 'test-tts', voice: 'test' } }
  return { calls, config, set: (value: { hang?: boolean; status?: number; large?: boolean; redirect?: boolean }) => { hang = value.hang ?? hang; status = value.status ?? status; large = value.large ?? large; redirect = value.redirect ?? redirect } }
}
function service(config?: VoiceConfig, now?: () => number) {
  const stateDir = directory(), store = new Store(join(stateDir, 'state.sqlite')); stores.push(store)
  const lifetime = new AbortController(), value = { store, stateDir, config, lifetime: lifetime.signal, roots: () => [join(stateDir, 'workers')] }
  const voice = new Voice(value, now); voices.push(voice); return { voice, store, value, lifetime }
}
async function terminal(voice: Voice, id: string) { await expect.poll(() => voice.get(id).phase, { timeout: 5000 }).not.toBe('running'); return voice.get(id) }

it('sends multipart audio and JSON synthesis, keeps draft text separate from Engine, and replays the same receipt without provider calls', async () => {
  const upstream = await provider(), { voice, store } = service(upstream.config)
  const request = { requestId: randomUUID(), mime: 'audio/wav', audio: wav().toString('base64') }
  voice.transcribe(request); expect((await terminal(voice, request.requestId)).text).toBe('Prepare a short briefing.')
  expect(voice.transcribe(request).phase).toBe('completed'); expect(upstream.calls).toHaveLength(1)
  expect(upstream.calls[0]!.body).toContain('name="model"'); expect(upstream.calls[0]!.body).toContain('test-stt')
  expect(store.tickets.list()).toEqual([])
  expect(() => voice.transcribe({ ...request, audio: Buffer.from('other').toString('base64') })).toThrow()
  const spoken = { requestId: randomUUID(), text: 'Hello world' }; voice.speak(spoken)
  expect((await terminal(voice, spoken.requestId)).audioBytes).toBe(wav().length); expect(voice.audio(spoken.requestId)).toEqual(wav())
  expect(JSON.parse(upstream.calls[1]!.body)).toEqual({ model: 'test-tts', input: 'Hello world', voice: 'test', response_format: 'wav' })
  expect(() => voice.speak({ ...spoken, text: 'Changed' })).toThrow(/different content/)
  expect(JSON.stringify(voice.capabilities())).not.toContain('test-tts')
})
it('cancels in-flight HTTP, bounds concurrency, and never reissues interrupted work after reopening', async () => {
  const upstream = await provider(); upstream.set({ hang: true })
  const { voice, value, store } = service(upstream.config)
  const a = { requestId: randomUUID(), text: 'A' }, b = { requestId: randomUUID(), text: 'B' }
  voice.speak(a); voice.speak(b)
  expect(() => voice.speak({ requestId: randomUUID(), text: 'C' })).toThrow(/busy/)
  await expect.poll(() => upstream.calls.length).toBe(2)
  expect((await voice.cancel(a.requestId)).phase).toBe('cancelled'); expect((await voice.cancel(a.requestId)).phase).toBe('cancelled')
  await voice.stop()
  // Simulate the persisted running receipt left by sudden process death after upstream acceptance.
  store.db.prepare("UPDATE voice_operation SET receipt=json_set(receipt, '$.phase', 'running') WHERE id=?").run(b.requestId)
  const restarted = new Voice(value); voices.push(restarted)
  expect(restarted.speak(b).phase).toBe('interrupted'); expect(upstream.calls).toHaveLength(2)
})
it('expires speech content while retaining retry tombstones and deletes crash-left temporary audio on restart', async () => {
  let now = 1000
  const upstream = await provider(), { voice, value, store } = service(upstream.config, () => now)
  const request = { requestId: randomUUID(), text: 'Private transient speech' }; voice.speak(request); await terminal(voice, request.requestId)
  now += L.retentionMs + 1
  expect(voice.get(request.requestId)).toMatchObject({ expired: true, phase: 'completed' }); expect(() => voice.audio(request.requestId)).toThrow(/expired/)
  expect(voice.speak(request).expired).toBe(true); expect(upstream.calls).toHaveLength(1)
  expect(store.db.prepare('SELECT audio FROM voice_operation').get()!.audio).toBeNull()
  await voice.stop()
  const { mkdirSync } = await import('node:fs'); const temporary = join(value.stateDir, 'speech-temporary')
  mkdirSync(join(temporary, 'speech-aB1234'), { recursive: true, mode: 0o700 }); writeFileSync(join(temporary, 'speech-aB1234', 'input'), 'private')
  const restarted = new Voice(value); voices.push(restarted); expect(readdirSync(temporary)).toEqual([])
})
it.each(['redirect', 'large', 'status'] as const)('refuses %s provider responses without saving upstream content or automatic retry', async kind => {
  const upstream = await provider(); upstream.set({ [kind]: kind === 'status' ? 401 : true })
  const { voice } = service(upstream.config), request = { requestId: randomUUID(), text: 'Read this' }
  voice.speak(request); expect((await terminal(voice, request.requestId)).phase).toBe('failed')
  expect(JSON.stringify(voice.get(request.requestId))).not.toContain('sensitive'); voice.speak(request); expect(upstream.calls).toHaveLength(1)
})
it('pins private credentials, excludes them from capabilities, and refuses worker-readable credential locations', async () => {
  const upstream = await provider(), root = directory(), credentialFile = join(root, 'key'), secret = randomUUID() + randomUUID()
  writeFileSync(credentialFile, secret, { mode: 0o600 })
  const config: VoiceConfig = { input: { ...upstream.config.input!, credentialFile } as VoiceConfig['input'] }
  const { voice } = service(config), input = { requestId: randomUUID(), mime: 'audio/wav', audio: wav().toString('base64') }
  voice.transcribe(input); await terminal(voice, input.requestId); expect(upstream.calls[0]!.authorization).toBe(`Bearer ${secret}`)
  writeFileSync(credentialFile, randomUUID() + randomUUID()); const changed = { ...input, requestId: randomUUID() }; voice.transcribe(changed)
  expect((await terminal(voice, changed.requestId)).phase).toBe('failed'); expect(upstream.calls).toHaveLength(1)
  expect(() => new SpeechAdapter(config.input!, root, () => [root])).toThrow(/outside/)
})
it('requires explicit cloud HTTPS credentials and literal-loopback local endpoints', () => {
  const root = directory()
  for (const [mode, url] of [['cloud', 'http://example.com'], ['cloud', 'https://example.com'], ['local', 'http://localhost:8000'], ['local', 'https://example.com']] as const)
    expect(() => new SpeechAdapter({ kind: 'http', mode, url, model: 'speech' }, root, () => [])).toThrow()
})
it('uses the explicit cloud endpoint and private key without consulting Harness credentials', async () => {
  const root = directory(), credentialFile = join(root, 'cloud-key'), key = randomUUID() + randomUUID()
  writeFileSync(credentialFile, key, { mode: 0o600 })
  const request = vi.fn(async () => new Response(new Uint8Array(wav()), { headers: { 'content-type': 'audio/wav' } })); vi.stubGlobal('fetch', request)
  const { voice } = service({ output: { kind: 'http', mode: 'cloud', url: 'https://speech.example.invalid/v1', model: 'tts', credentialFile } })
  const requestId = randomUUID(); voice.speak({ requestId, text: 'An explicit cloud request' }); await terminal(voice, requestId)
  expect(request).toHaveBeenCalledWith('https://speech.example.invalid/v1/audio/speech', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ authorization: `Bearer ${key}` }) }))
  expect(voice.get(requestId).mode).toBe('cloud'); expect(JSON.stringify(voice.get(requestId))).not.toContain(key)
})
it('handles maximum-size base64 without parser recursion and refuses a full receipt ledger', () => {
  const { voice, store } = service(), audio = Buffer.alloc(L.inputBytes); wav().copy(audio)
  expect(() => voice.transcribe({ requestId: randomUUID(), mime: 'audio/wav', audio: audio.toString('base64') })).toThrow(/unavailable/)
  const config: VoiceConfig = { output: { kind: 'http', mode: 'local', url: 'http://127.0.0.1:1', model: 'tts' } }
  const enabled = new Voice({ store, stateDir: directory(), config, lifetime: new AbortController().signal, roots: () => [] }); voices.push(enabled)
  store.db.exec(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<${L.receipts})
    INSERT INTO voice_operation(id, fingerprint, receipt) SELECT CAST(n AS TEXT), 'test', '{"phase":"completed","expired":true}' FROM ids`)
  expect(() => enabled.speak({ requestId: randomUUID(), text: 'Capacity request' })).toThrow(/capacity/)
})
it('terminates a local command and its child before deleting temporary input', async () => {
  const root = directory(), binary = join(root, 'local-speech'), modelFile = join(root, 'model')
  writeFileSync(binary, '#!/bin/sh\n(trap "" TERM; while :; do sleep 1; done) >/dev/null 2>&1 &\necho $! > child.pid\nwait\n', { mode: 0o700 }); writeFileSync(modelFile, 'test')
  const { voice, value } = service({ input: { kind: 'whisper', binary: '/bin/false', ffmpeg: binary, modelFile } })
  const requestId = randomUUID(); voice.transcribe({ requestId, mime: 'audio/wav', audio: wav().toString('base64') })
  let pid = 0
  await expect.poll(() => { try { const temporary = join(value.stateDir, 'speech-temporary'); const name = readdirSync(temporary)[0]!; pid = Number(readFileSync(join(temporary, name, 'child.pid'), 'utf8')); return pid > 0 } catch { return false } }).toBe(true)
  expect((await voice.cancel(requestId)).phase).toBe('cancelled')
  await expect.poll(() => { try { process.kill(pid, 0); return false } catch { return true } }).toBe(true)
  expect(readdirSync(join(value.stateDir, 'speech-temporary'))).toEqual([])
})
it('fails closed on invalid audio, unavailable adapters, and oversized text', () => {
  const { voice } = service()
  expect(() => voice.speak({ requestId: randomUUID(), text: 'hello' })).toThrow(/unavailable/)
  expect(() => voice.transcribe({ requestId: randomUUID(), mime: 'audio/wav', audio: Buffer.from('#EXTM3U remote').toString('base64') })).toThrow(/container/)
  expect(() => voice.speak({ requestId: randomUUID(), text: 'a'.repeat(L.textChars + 1) })).toThrow()
})
it('routes speech through the real Runtime HTTP host without creating a task until the operator sends text', async () => {
  const upstream = await provider(); host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, voice: upstream.config })
  expect((await host.api('GET', 'voice')).body).toMatchObject({ input: 'local', output: 'local' })
  const requestId = randomUUID(), start = await host.api('POST', 'voice/transcribe', { requestId, mime: 'audio/wav', audio: wav().toString('base64') })
  expect(start.status).toBe(200); const receipt = await terminal(host.runtime.voice, requestId)
  expect(host.runtime.store.tickets.list()).toEqual([])
  const task = await host.api('POST', 'inbox', { requestId: randomUUID(), text: receipt.text })
  expect(task.status).toBe(200); expect(host.runtime.store.tickets.list()).toHaveLength(1)
})

it.skipIf(!process.env.DSH_VOICE_QUALIFICATION)('qualifies actual macOS synthesis, FFmpeg decoding, and whisper.cpp transcription through durable Voice', async () => {
  const config: VoiceConfig = { input: { kind: 'whisper', binary: '/opt/homebrew/bin/whisper-cli', ffmpeg: '/opt/homebrew/bin/ffmpeg', modelFile: process.env.DSH_VOICE_MODEL! },
    output: { kind: 'say', binary: '/usr/bin/say', ffmpeg: '/opt/homebrew/bin/ffmpeg', voice: 'Samantha' } }
  const { voice, value } = service(config), output = randomUUID()
  voice.speak({ requestId: output, text: 'Prepare a short briefing about the project.' })
  await expect.poll(() => voice.get(output).phase, { timeout: 60000 }).toBe('completed')
  const input = randomUUID(); voice.transcribe({ requestId: input, mime: 'audio/wav', audio: voice.audio(output).toString('base64') })
  await expect.poll(() => voice.get(input).phase, { timeout: 90000 }).toBe('completed')
  expect(voice.get(input).text?.toLowerCase()).toContain('briefing'); expect(readdirSync(join(value.stateDir, 'speech-temporary'))).toEqual([])
  expect(readFileSync(config.input!.kind === 'whisper' ? config.input!.modelFile : '').length).toBeGreaterThan(70000000)
}, 160000)
