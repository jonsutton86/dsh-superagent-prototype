/** Bounded HTTP speech and fixed local commands. No shell, ambient provider key, or implicit cloud fallback. */
import { spawn } from 'node:child_process'
import { constants, lstatSync, realpathSync, statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { credentialDigest, privateCredential, privateDirectory } from '../environments/endpoint-files.ts'
import { VOICE_LIMITS as L, VoiceError, type HttpVoiceAdapter, type VoiceAdapter } from './model.ts'

export function outsideRoots(file: string, roots: string[]): void {
  const canonical = (value: string) => { try { return realpathSync(value) } catch { return resolve(value) } }
  if (roots.some(root => { const rel = relative(canonical(root), canonical(file)); return rel === '' || (!rel.startsWith('../') && rel !== '..' && !rel.startsWith('/')) }))
    throw new VoiceError(409, 'Speech files must be outside every execution workspace')
}
export function audioFormat(audio: Buffer, mime: string): string {
  const head = audio.subarray(0, 12)
  const formats: Record<string, [boolean, string]> = {
    'audio/wav': [head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE', 'wav'],
    'audio/ogg': [head.toString('ascii', 0, 4) === 'OggS', 'ogg'],
    'audio/webm': [head.subarray(0, 4).toString('hex') === '1a45dfa3', 'matroska'],
    'audio/mp4': [head.toString('ascii', 4, 8) === 'ftyp', 'mov'],
  }
  const format = formats[mime]
  if (!format?.[0]) throw new VoiceError(400, 'Audio container does not match its declared format')
  return format[1]
}
async function limited(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new VoiceError(503, `Speech provider refused the request (${response.status})`) }
  const reader = response.body?.getReader()
  if (!reader) throw new VoiceError(503, 'Speech provider returned no content')
  let size = 0; const chunks: Uint8Array[] = []
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength
      if (size > limit) throw new VoiceError(503, 'Speech provider exceeded the response limit')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
/** Wait for process exit even on cancellation before deleting its private working directory. */
async function command(binary: string, argv: string[], directory: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const stat = statSync(binary)
  if (!stat.isFile() || !(stat.mode & 0o111)) throw new VoiceError(503, 'Speech executable is unavailable')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, argv, { cwd: directory, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' } })
    let bytes = 0, overflow = false, timer: ReturnType<typeof setTimeout> | undefined
    const kill = (type: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, type) } catch { /* Already exited. */ } } }
    const abort = () => { kill('SIGTERM'); timer ??= setTimeout(() => kill('SIGKILL'), 1000) }
    child.stderr?.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 128 * 1024) { overflow = true; abort() } })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.once('error', () => { /* close follows error; do not expose paths or provider diagnostics. */ })
    child.once('close', code => {
      // A wrapper can exit before a descendant that ignored TERM and closed its inherited pipes.
      if (signal.aborted || overflow) kill('SIGKILL')
      signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer)
      if (signal.aborted || overflow || code !== 0) reject(new VoiceError(503, 'Local speech failed or was interrupted; text remains available'))
      else resolve()
    })
  })
}
async function smallFile(file: string, limit: number): Promise<Buffer> {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new VoiceError(503, 'Speech output exceeded its limit')
  return readFile(file, { flag: constants.O_RDONLY | constants.O_NOFOLLOW })
}
/** One operator-selected speech provider, with no automatic mode or credential fallback. */
export class SpeechAdapter {
  private readonly pin?: string
  private readonly url?: string
  constructor(readonly config: VoiceAdapter, private readonly directory: string, private readonly roots: () => string[]) {
    if (config.kind === 'http') {
      const url = new URL(config.url)
      if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)
        || (config.mode === 'local' && !['127.0.0.1', '[::1]'].includes(url.hostname))
        || (config.mode === 'cloud' && (url.protocol !== 'https:' || !config.credentialFile)))
        throw new VoiceError(400, 'Speech requires literal loopback in local mode, or HTTPS and a private credential in cloud mode')
      this.url = url.href.replace(/\/$/, '')
      if (config.credentialFile) {
        outsideRoots(config.credentialFile, roots())
        this.pin = credentialDigest(privateCredential(config.credentialFile))
      }
    } else {
      for (const file of [config.binary, config.ffmpeg, ...(config.kind === 'whisper' ? [config.modelFile] : [])]) outsideRoots(file, roots())
      outsideRoots(directory, roots())
      privateDirectory(directory)
    }
  }
  private async http(config: HttpVoiceAdapter, operation: string, body: BodyInit, signal: AbortSignal, json = false): Promise<Response> {
    const headers: Record<string, string> = json ? { 'content-type': 'application/json' } : {}
    if (config.credentialFile) { outsideRoots(config.credentialFile, this.roots()); headers.authorization = `Bearer ${privateCredential(config.credentialFile, this.pin)}` }
    return fetch(`${this.url}/audio/${operation}`, { method: 'POST', headers, body, signal, redirect: 'error' })
  }
  private async local<T>(run: (directory: string) => Promise<T>): Promise<T> {
    const config = this.config
    if (config.kind !== 'http') for (const file of [config.binary, config.ffmpeg, ...(config.kind === 'whisper' ? [config.modelFile] : [])]) outsideRoots(file, this.roots())
    outsideRoots(this.directory, this.roots())
    const directory = await mkdtemp(join(privateDirectory(this.directory), 'speech-'))
    try { return await run(directory) } finally { await rm(directory, { force: true, recursive: true }) }
  }
  async transcribe(audio: Buffer, mime: string, signal: AbortSignal): Promise<string> {
    const format = audioFormat(audio, mime), config = this.config
    let text: unknown
    if (config.kind === 'http') {
      const form = new FormData(); form.set('model', config.model); form.set('response_format', 'json')
      form.set('file', new Blob([new Uint8Array(audio)], { type: mime }), `recording.${mime.split('/')[1]}`)
      const content = await limited(await this.http(config, 'transcriptions', form, signal), 128 * 1024)
      text = (JSON.parse(content.toString()) as { text?: unknown }).text
    } else if (config.kind === 'whisper') {
      text = await this.local(async directory => {
        if (!statSync(config.modelFile).isFile()) throw new VoiceError(503, 'Speech model is unavailable')
        const input = join(directory, 'input'), wav = join(directory, 'input.wav'), output = join(directory, 'transcript')
        await writeFile(input, audio, { mode: 0o600, flag: 'wx' })
        await command(config.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input,
          '-t', '30', '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], directory, signal)
        await command(config.binary, ['-m', config.modelFile, '-f', wav, '-otxt', '-of', output, '-np', '-nt'], directory, signal)
        return (await smallFile(`${output}.txt`, 64 * 1024)).toString()
      })
    } else throw new VoiceError(503, 'Speech input is not configured')
    if (typeof text !== 'string' || !text.trim() || text.length > L.transcriptChars) throw new VoiceError(503, 'Speech returned no usable transcript; use text input')
    return text.trim()
  }
  async speak(text: string, signal: AbortSignal): Promise<Buffer> {
    const config = this.config
    let audio: Buffer
    if (config.kind === 'http') {
      audio = await limited(await this.http(config, 'speech', JSON.stringify({ model: config.model, input: text,
        ...(config.voice ? { voice: config.voice } : {}), response_format: 'wav' }), signal, true), L.outputBytes)
    } else if (config.kind === 'say') {
      audio = await this.local(async directory => {
        const input = join(directory, 'input.txt'), aiff = join(directory, 'speech.aiff'), wav = join(directory, 'speech.wav')
        await writeFile(input, text, { mode: 0o600, flag: 'wx' })
        await command(config.binary, ['-f', input, '-o', aiff, ...(config.voice ? ['-v', config.voice] : [])], directory, signal)
        await command(config.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', 'aiff', '-i', aiff,
          '-t', '120', '-vn', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', wav], directory, signal)
        return smallFile(wav, L.outputBytes)
      })
    } else throw new VoiceError(503, 'Speech output is not configured')
    audioFormat(audio, 'audio/wav')
    if (audio.length < 44) throw new VoiceError(503, 'Speech provider returned empty audio')
    return audio
  }
}
