/** Durable request identity, short-lived speech content, explicit cancellation, and no restart replay. */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../app/store.ts'
import { SpeechAdapter, audioFormat, outsideRoots } from './adapters.ts'
import { privateDirectory } from '../environments/endpoint-files.ts'
import { Speak, Transcribe, VoiceConfiguration, VoiceError, VOICE_LIMITS as L, type VoiceConfig, type VoiceReceipt, type VoiceCapabilities } from './model.ts'

interface Row { fingerprint: string; receipt: string; audio: Uint8Array | null }
interface VoiceHost { store: Store; stateDir: string; config?: VoiceConfig; lifetime: AbortSignal; roots(): string[] }
/** Host-owned speech service: durable request identity with transient content and no execution authority. */
export class Voice {
  private readonly input?: SpeechAdapter
  private readonly output?: SpeechAdapter
  private readonly active = new Map<string, { abort: AbortController; task: Promise<void> }>()
  private closing = false
  private readonly expiry?: ReturnType<typeof setInterval>
  constructor(private readonly host: VoiceHost, private readonly now = Date.now) {
    const config = VoiceConfiguration.parse(host.config ?? {})
    const directory = join(host.stateDir, 'speech-temporary')
    if (existsSync(directory)) {
      outsideRoots(directory, host.roots()); privateDirectory(directory)
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory() && /^speech-[A-Za-z0-9]{6}$/.test(entry.name)) rmSync(join(directory, entry.name), { recursive: true })
    }
    if (config.input) this.input = new SpeechAdapter(config.input, directory, host.roots)
    if (config.output) this.output = new SpeechAdapter(config.output, directory, host.roots)
    host.store.db.exec('CREATE TABLE IF NOT EXISTS voice_operation (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, audio BLOB)')
    // An upstream cloud request may have completed. Preserve identity and never replay it on restart or restore.
    for (const row of host.store.db.prepare("SELECT receipt FROM voice_operation WHERE json_extract(receipt, '$.phase')='running'").all()) {
      const receipt = JSON.parse(row.receipt as string) as VoiceReceipt
      this.save({ ...receipt, phase: 'interrupted', error: 'Speech was interrupted. Its provider outcome is unknown; create a new request to try again.' })
    }
    this.expire()
    if (this.input || this.output || host.store.db.prepare("SELECT 1 FROM voice_operation WHERE json_extract(receipt, '$.expired') IS NULL LIMIT 1").get()) {
      this.expiry = setInterval(() => this.expire(), 60000); this.expiry.unref()
    }
  }
  capabilities(): VoiceCapabilities {
    const mode = (adapter?: SpeechAdapter) => !adapter ? null : adapter.config.kind === 'http' ? adapter.config.mode : 'local'
    return { input: mode(this.input), output: mode(this.output), recordingMs: L.recordingMs, inputBytes: L.inputBytes, textChars: L.textChars }
  }
  private row(id: string): Row | undefined { return this.host.store.db.prepare('SELECT fingerprint, receipt, audio FROM voice_operation WHERE id=?').get(id) as unknown as Row | undefined }
  private save(receipt: VoiceReceipt, audio?: Buffer): void {
    this.host.store.db.prepare('UPDATE voice_operation SET receipt=?, audio=? WHERE id=?').run(JSON.stringify(receipt), audio ?? null, receipt.id)
  }
  private expire(): void {
    // Keep content-free tombstones so an old retry cannot incur a second provider charge after its content expires.
    for (const row of this.host.store.db.prepare("SELECT receipt FROM voice_operation WHERE json_extract(receipt, '$.expiresAt')<=? AND json_extract(receipt, '$.expired') IS NULL AND json_extract(receipt, '$.phase')!='running'").all(this.now())) {
      const { text: _text, audioBytes: _bytes, ...receipt } = JSON.parse(row.receipt as string) as VoiceReceipt
      this.save({ ...receipt, expired: true })
    }
  }
  get(id: string): VoiceReceipt {
    this.expire(); const row = this.row(id)
    if (!row) throw new VoiceError(404, 'Speech request was not found')
    return JSON.parse(row.receipt) as VoiceReceipt
  }
  audio(id: string): Buffer {
    const receipt = this.get(id), row = this.row(id)
    if (receipt.phase !== 'completed' || receipt.kind !== 'speak' || !row?.audio) throw new VoiceError(409, 'Speech audio is unavailable or expired')
    return Buffer.from(row.audio)
  }
  transcribe(value: unknown): VoiceReceipt {
    const input = Transcribe.parse(value), audio = Buffer.from(input.audio, 'base64')
    if (audio.length > L.inputBytes || audio.toString('base64') !== input.audio) throw new VoiceError(400, 'Invalid or oversized audio')
    audioFormat(audio, input.mime)
    return this.start(input.requestId, 'transcribe', input, this.input, async (adapter, signal) => ({ text: await adapter.transcribe(audio, input.mime, signal) }))
  }
  speak(value: unknown): VoiceReceipt {
    const input = Speak.parse(value)
    return this.start(input.requestId, 'speak', input, this.output, async (adapter, signal) => ({ audio: await adapter.speak(input.text, signal) }))
  }
  private start(id: string, kind: VoiceReceipt['kind'], input: unknown, adapter: SpeechAdapter | undefined,
    run: (adapter: SpeechAdapter, signal: AbortSignal) => Promise<{ text?: string; audio?: Buffer }>): VoiceReceipt {
    this.expire()
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind, input })).digest('hex'), prior = this.row(id)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new VoiceError(409, 'Speech request ID was already used with different content')
      return this.get(id)
    }
    if (this.closing || this.host.lifetime.aborted || !adapter) throw new VoiceError(503, 'Speech is unavailable; text remains available')
    if (this.active.size >= L.concurrent) throw new VoiceError(429, 'Speech is busy; wait for the current request')
    const count = this.host.store.db.prepare('SELECT count(*) AS count FROM voice_operation').get()!.count as number
    if (count >= L.receipts) throw new VoiceError(429, 'Speech receipt capacity reached; operator maintenance is required')
    const receipt: VoiceReceipt = { id, kind, mode: adapter.config.kind === 'http' ? adapter.config.mode : 'local', phase: 'running',
      createdAt: this.now(), expiresAt: this.now() + L.retentionMs }
    this.host.store.db.prepare('INSERT INTO voice_operation (id, fingerprint, receipt) VALUES (?, ?, ?)').run(id, fingerprint, JSON.stringify(receipt))
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.host.lifetime, AbortSignal.timeout(L.timeoutMs)])
    const task = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted()
        const result = await run(adapter, signal); signal.throwIfAborted()
        this.save({ ...receipt, phase: 'completed', ...(result.text ? { text: result.text } : {}), ...(result.audio ? { audioBytes: result.audio.length } : {}) }, result.audio)
      } catch {
        // Never persist arbitrary provider diagnostics, input audio, credentials, or process stderr.
        this.save({ ...receipt, phase: abort.signal.aborted ? 'cancelled' : this.host.lifetime.aborted ? 'interrupted' : 'failed',
          error: 'Speech did not complete. The provider may have processed it; text remains available.' })
      } finally { this.active.delete(id) }
    })
    this.active.set(id, { abort, task })
    return receipt
  }
  async cancel(id: string): Promise<VoiceReceipt> {
    this.get(id)
    const active = this.active.get(id)
    if (active) { active.abort.abort(); await active.task }
    return this.get(id)
  }
  async stop(): Promise<void> {
    this.closing = true
    clearInterval(this.expiry)
    for (const operation of this.active.values()) operation.abort.abort()
    await Promise.all([...this.active.values()].map(operation => operation.task))
  }
}
