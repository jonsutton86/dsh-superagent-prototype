/** Speech transports are optional operator services; they never receive execution authority. */
import { z } from 'zod'

export const VOICE_LIMITS = { inputBytes: 2 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, textChars: 2000,
  transcriptChars: 12000, recordingMs: 30000, timeoutMs: 120000, retentionMs: 15 * 60000, concurrent: 2, receipts: 10000 } as const
const path = z.string().startsWith('/')
const http = z.object({ kind: z.literal('http'), mode: z.enum(['local', 'cloud']), url: z.string().url(),
  model: z.string().trim().min(1).max(200), credentialFile: path.optional(), voice: z.string().min(1).max(100).optional() }).strict()
export const VoiceConfiguration = z.object({
  input: z.union([http, z.object({ kind: z.literal('whisper'), binary: path, modelFile: path, ffmpeg: path }).strict()]).optional(),
  output: z.union([http, z.object({ kind: z.literal('say'), binary: z.literal('/usr/bin/say'), ffmpeg: path, voice: z.string().regex(/^[\w -]{1,80}$/).optional() }).strict()]).optional(),
}).strict()
export type VoiceConfig = z.infer<typeof VoiceConfiguration>
export type VoiceAdapter = NonNullable<VoiceConfig['input'] | VoiceConfig['output']>
export type HttpVoiceAdapter = z.infer<typeof http>
export const Transcribe = z.object({ requestId: z.string().uuid(), mime: z.enum(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4']),
  audio: z.string().min(4).max(Math.ceil(VOICE_LIMITS.inputBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict()
export const Speak = z.object({ requestId: z.string().uuid(), text: z.string().trim().min(1).max(VOICE_LIMITS.textChars) }).strict()
export type TranscribeInput = z.infer<typeof Transcribe>
export type SpeakInput = z.infer<typeof Speak>
export interface VoiceCapabilities { input: 'local' | 'cloud' | null; output: 'local' | 'cloud' | null; recordingMs: number; inputBytes: number; textChars: number }
export interface VoiceReceipt { id: string; kind: 'transcribe' | 'speak'; mode: 'local' | 'cloud'; phase: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: number; expiresAt: number; text?: string; audioBytes?: number; error?: string; expired?: boolean }
/** Safe operator-facing speech error, without raw transport or process diagnostics. */
export class VoiceError extends Error { constructor(readonly status: 400 | 404 | 409 | 429 | 503, message: string) { super(message) } }
