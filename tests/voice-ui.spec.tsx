// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { InboxPage } from '../src/client/inbox.tsx'
import { Dictation, SpeakReply, VoiceProvider } from '../src/client/voice.tsx'
import { recordMicrophone } from '../src/client/voice-media.ts'
import { PanelProvider } from '../src/client/provider.tsx'
import { en } from '../src/client/locales.ts'
import { translator } from './fixtures/panel.tsx'
import { startRuntime, type Host } from './fixtures/host.ts'

let root: Root | undefined, element: HTMLDivElement, host: Host | undefined
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; element?.remove(); await host?.stop(); host = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })
class Recorder {
  static latest: Recorder
  static isTypeSupported(type: string) { return type.startsWith('audio/webm') }
  state = 'inactive'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  onerror?: () => void
  constructor() { Recorder.latest = this }
  start() { this.state = 'recording' }
  stop() { if (this.state === 'inactive') return; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['final chunk']) }); this.onstop?.() }
}
function microphone() {
  const stop = vi.fn(), stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
  vi.stubGlobal('MediaRecorder', Recorder); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } })
  return { stop, stream }
}
async function click(text: string) {
  const button = [...element.querySelectorAll('button')].find(button => button.textContent?.startsWith(text))
  expect(button, text).toBeTruthy(); await act(async () => button!.click())
}
async function fixture(children: React.ReactNode) {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const requests: { path: string; body?: Record<string, unknown> }[] = []
  let pendingSpeech = false
  const pause = vi.fn(), play = vi.fn(async () => {})
  vi.stubGlobal('Audio', class { pause = pause; play = play; onended?: () => void; onerror?: () => void })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:speech') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url).replace('/orchestrator/api/', ''), body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ path, body })
    if (path === 'voice') return new Response(JSON.stringify({ input: 'local', output: 'local', recordingMs: 30000, inputBytes: 2097152, textChars: 2000 }))
    if (path.endsWith('/audio')) return new Response(new Blob(['audio'], { type: 'audio/wav' }))
    if (path.startsWith('voice/')) return new Response(JSON.stringify({ id: body?.requestId ?? path.split('/')[1], phase: pendingSpeech ? 'running' : 'completed', text: 'Spoken addition.' }))
    const result = await host!.api(init?.method ?? 'GET', path, body)
    return new Response(JSON.stringify(result.body), { status: result.status })
  })
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  await act(async () => root!.render(<PanelProvider t={translator(en)} navigate={vi.fn()}>{children}</PanelProvider>))
  return { requests, pause, play, pending: () => { pendingSpeech = true } }
}
it('waits for the final recording chunk, appends to an edited draft, and requires the ordinary Send action', async () => {
  const mic = microphone(), { requests } = await fixture(<InboxPage />)
  await click('New task')
  const textarea = element.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Existing draft'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Record'); expect(Recorder.latest.state).toBe('recording')
  expect([...element.querySelectorAll('button')].find(button => button.textContent === 'Start task')?.disabled).toBe(true)
  Recorder.latest.ondataavailable?.({ data: new Blob(['first chunk ']) })
  await click('Finish recording')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  const transcription = requests.find(request => request.path === 'voice/transcribe')!
  expect(atob(String(transcription.body!.audio))).toBe('first chunk final chunk')
  expect(textarea.value).toBe('Existing draft\nSpoken addition.'); expect(mic.stop).toHaveBeenCalled()
  expect(host!.runtime.store.tickets.list()).toEqual([])
  await click('Start task'); expect(host!.runtime.store.tickets.list()).toHaveLength(1)
})
it('cancels microphone recording and preserves text without submitting audio', async () => {
  const mic = microphone(), { requests } = await fixture(<InboxPage />)
  await click('New task'); await click('Record'); await click('Cancel voice')
  expect(mic.stop).toHaveBeenCalled(); expect(requests.some(request => request.path === 'voice/transcribe')).toBe(false)
  expect(element.querySelector('textarea')!.disabled).toBe(false)
})
it('preserves a full draft and exposes the complete transcript instead of truncating either', async () => {
  microphone(); await fixture(<InboxPage />); await click('New task'); await click('Record')
  const textarea = element.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'a'.repeat(12000)); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Finish recording'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
  expect(textarea.value).toBe('a'.repeat(12000)); expect(element.querySelector<HTMLTextAreaElement>('textarea[readonly]')!.value).toBe('Spoken addition.')
  expect(element.textContent).toContain('The draft is full')
})
it('releases a late permission grant after navigation and never starts listening', async () => {
  const mic = microphone(); let grant!: (stream: MediaStream) => void
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(() => new Promise(resolve => { grant = resolve }))
  const { requests } = await fixture(<InboxPage />); await click('New task'); await click('Record')
  await act(async () => root!.unmount()); root = undefined
  await act(async () => { grant(mic.stream); await Promise.resolve() })
  expect(mic.stop).toHaveBeenCalled(); expect(requests.some(request => request.path === 'voice/transcribe')).toBe(false)
})
function AudioPage() { const [busy, setBusy] = useState(false); return <VoiceProvider><SpeakReply id="reply" text="A reply" /><Dictation disabled={false} onBusy={setBusy} onText={() => {}} /><span>{busy ? 'busy' : 'idle'}</span></VoiceProvider> }
it('interrupts active playback when microphone input starts and revokes audio on navigation', async () => {
  microphone(); const { pause, play } = await fixture(<AudioPage />)
  await click('Read aloud'); expect(play).toHaveBeenCalledOnce()
  await click('Record'); expect(pause).toHaveBeenCalledOnce(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:speech')
  await click('Cancel voice'); await click('Read aloud'); await act(async () => root!.unmount()); root = undefined
  expect(pause).toHaveBeenCalledTimes(2)
})
it('cancels pending synthesis by its original request ID on Stop', async () => {
  microphone(); const state = await fixture(<AudioPage />); state.pending()
  await click('Read aloud'); await click('Stop speaking')
  const original = state.requests.find(request => request.path === 'voice/speak')!.body!.requestId
  expect(state.requests.some(request => request.path === `voice/${original}/cancel`)).toBe(true); expect(state.play).not.toHaveBeenCalled()
})
it('stops automatically at the duration limit and releases tracks when the byte cap is exceeded', async () => {
  const mic = microphone(), first = await recordMicrophone(new AbortController().signal, 100, 5)
  expect((await first.result).audio).toBe(btoa('final chunk')); expect(mic.stop).toHaveBeenCalledOnce()
  const second = await recordMicrophone(new AbortController().signal, 2, 30000), rejected = expect(second.result).rejects.toThrow(/too large/)
  Recorder.latest.ondataavailable?.({ data: new Blob(['exceeds limit']) }); await rejected
  expect(mic.stop).toHaveBeenCalledTimes(2)
})
