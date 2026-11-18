/** Harness settings schema for explicit speech input/output selection. */
import s from '@deepseek-ai/schemastery'
import type { VoiceConfig } from './model.ts'
const path = () => s.string().pattern(/^\//).required()
const http = s.object({ kind: s.const('http').required(), mode: s.union(['local', 'cloud']).required(), url: s.string().required(),
  model: s.string().required(), credentialFile: s.string().pattern(/^\//), voice: s.string() })
export const VoiceSettings: s<VoiceConfig> = s.object({
  input: s.union([http, s.object({ kind: s.const('whisper').required(), binary: path(), modelFile: path(), ffmpeg: path() })]),
  output: s.union([http, s.object({ kind: s.const('say').required(), binary: s.const('/usr/bin/say').required(), ffmpeg: path(), voice: s.string() })]),
})
