/** Optional voice on the ordinary inbox. A transcript is a draft, never a send or approval. */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { recordMicrophone } from './voice-media.ts'
import type { VoiceCapabilities, VoiceReceipt } from '../voice/model.ts'

interface VoiceState { capabilities?: VoiceCapabilities; playing?: string; error: boolean; stop(): void; speak(id: string, text: string): Promise<void> }
const VoiceContext = createContext<VoiceState>({ error: false, stop() {}, async speak() {} })
async function wait(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('Speech stopped')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 300)
    signal.addEventListener('abort', abort, { once: true })
  })
}
/** Cancellation also runs after a late POST response so navigation cannot orphan an accepted request. */
async function operation(start: () => Promise<VoiceReceipt>, get: () => Promise<VoiceReceipt>, cancel: () => Promise<unknown>, signal: AbortSignal): Promise<VoiceReceipt> {
  const abort = () => { void cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    let receipt = await start()
    while (receipt.phase === 'running') { await wait(signal); receipt = await get() }
    signal.throwIfAborted()
    if (receipt.phase !== 'completed' || receipt.expired) throw new Error('Speech did not complete')
    return receipt
  } finally { signal.removeEventListener('abort', abort); if (signal.aborted) await cancel().catch(() => {}) }
}
export function VoiceProvider({ children }: { children: ReactNode }) {
  const { call, t } = usePanel(), [capabilities, setCapabilities] = useState<VoiceCapabilities>(), [playing, setPlaying] = useState<string>(), [error, setError] = useState(false)
  const { restarts } = usePanelData()
  const active = useRef<AbortController>(), playback = useRef<HTMLAudioElement>(), objectUrl = useRef<string>()
  const release = () => { playback.current?.pause(); playback.current = undefined; if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = undefined }
  const stop = () => { active.current?.abort(); active.current = undefined; release(); setPlaying(undefined) }
  useEffect(() => {
    let current = true
    setPlaying(undefined)
    void call('GET voice').then(value => { if (current) setCapabilities(value) }).catch(() => {})
    return () => { current = false; active.current?.abort(); active.current = undefined; release() }
  }, [call, restarts])
  const speak = async (id: string, text: string) => {
    stop(); setError(false)
    const controller = new AbortController(), requestId = crypto.randomUUID(); active.current = controller; setPlaying(id)
    try {
      await operation(() => call('POST voice/speak', { body: { requestId, text } }), () => call('GET voice/:id', { id: requestId }),
        () => call('POST voice/:id/cancel', { id: requestId }), controller.signal)
      const response = await fetch(`/orchestrator/api/voice/${requestId}/audio`, { headers: { 'x-orchestrator-request': '1' }, signal: controller.signal })
      if (!response.ok) throw new Error('Speech audio unavailable')
      const blob = await response.blob(); controller.signal.throwIfAborted()
      objectUrl.current = URL.createObjectURL(blob)
      const audio = playback.current = new Audio(objectUrl.current)
      audio.onended = () => { if (active.current === controller) stop() }
      audio.onerror = () => { if (active.current === controller) { setError(true); stop() } }
      await audio.play()
    } catch { if (active.current === controller) { if (!controller.signal.aborted) setError(true); stop() } }
  }
  return <VoiceContext.Provider value={{ capabilities, playing, error, stop, speak }}>{children}{error && <p role="status">{t('voice.error')}</p>}</VoiceContext.Provider>
}
export function SpeakReply({ id, text }: { id: string; text: string }) {
  const { t } = usePanel(), voice = useContext(VoiceContext)
  if (!voice.capabilities?.output) return null
  const playing = voice.playing === id
  const tooLong = text.length > voice.capabilities.textChars
  return <span><Button disabled={!playing && tooLong} title={voice.capabilities.output === 'cloud' ? t('voice.cloudHint') : undefined} onClick={() => { if (playing) voice.stop(); else void voice.speak(id, text) }}>
    {t(playing ? 'voice.stop' : 'voice.speak')} ({t(`voice.${voice.capabilities.output}`)})</Button>
    {tooLong && <span>{t('voice.tooLong', { limit: voice.capabilities.textChars })}</span>}</span>
}
export function Dictation({ disabled, onText, onBusy }: { disabled: boolean; onText(text: string): void; onBusy(busy: boolean): void }) {
  const { t, call } = usePanel(), voice = useContext(VoiceContext), [phase, setPhase] = useState<'idle' | 'permission' | 'recording' | 'transcribing'>('idle'), [error, setError] = useState(false)
  const active = useRef<AbortController>(), finish = useRef<() => void>(), onBusyRef = useRef(onBusy); onBusyRef.current = onBusy
  const onTextRef = useRef(onText); onTextRef.current = onText
  useEffect(() => () => { active.current?.abort(); active.current = undefined; onBusyRef.current(false) }, [])
  const start = async () => {
    const caps = voice.capabilities
    if (!caps?.input || active.current) return
    voice.stop(); setError(false); setPhase('permission'); onBusyRef.current(true)
    const controller = new AbortController(); active.current = controller
    try {
      const recording = await recordMicrophone(controller.signal, caps.inputBytes, caps.recordingMs)
      finish.current = recording.finish; if (!controller.signal.aborted) setPhase('recording')
      const audio = await recording.result; controller.signal.throwIfAborted(); setPhase('transcribing')
      const requestId = crypto.randomUUID()
      const receipt = await operation(() => call('POST voice/transcribe', { body: { requestId, ...audio } }), () => call('GET voice/:id', { id: requestId }),
        () => call('POST voice/:id/cancel', { id: requestId }), controller.signal)
      if (receipt.text) onTextRef.current(receipt.text)
    } catch { if (active.current === controller && !controller.signal.aborted) setError(true) }
    finally { if (active.current === controller) { active.current = undefined; finish.current = undefined; setPhase('idle'); onBusyRef.current(false) } }
  }
  if (!voice.capabilities?.input) return null
  const available = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  return <div className="dt-voice"><p className="dt-hint">{t('voice.draftHint')} {t(`voice.${voice.capabilities.input}`)}</p>
    {voice.capabilities.input === 'cloud' && <p className="dt-hint">{t('voice.cloudHint')}</p>}
    <Button disabled={disabled || !available || phase === 'permission' || phase === 'transcribing'} onClick={() => { if (phase === 'recording') finish.current?.(); else void start() }}>
      {t(phase === 'recording' ? 'voice.finish' : 'voice.record')}</Button>
    {phase !== 'idle' && <><Button onClick={() => { active.current?.abort(); active.current = undefined; setPhase('idle'); onBusyRef.current(false) }}>{t('voice.cancel')}</Button><span role="status">{t(`voice.${phase}`)}</span></>}
    {(error || !available) && <p role="status">{t('voice.error')}</p>}
  </div>
}
