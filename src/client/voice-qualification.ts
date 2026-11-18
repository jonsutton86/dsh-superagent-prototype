/** Browser capability probe for voice. It reports API presence only: never permission, device or provider verification. */
export interface VoiceBrowserSupport {
  mediaRecorder: boolean
  preferredMime: string | null
  microphoneApi: boolean
  audioElement: boolean
  secureContext: boolean
}

interface ProbeEnvironment {
  MediaRecorder?: { isTypeSupported(type: string): boolean }
  mediaDevices?: { getUserMedia?: unknown }
  Audio?: unknown
  secureContext?: boolean
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

/** Report what this browser exposes; an unavailable API is reported as unavailable, not inferred from the user agent. */
export function voiceBrowserSupport(environment: ProbeEnvironment = {
  MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
  mediaDevices: typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  Audio: typeof Audio === 'undefined' ? undefined : Audio,
  secureContext: typeof window === 'undefined' ? undefined : window.isSecureContext
}): VoiceBrowserSupport {
  const recorder = environment.MediaRecorder
  return {
    mediaRecorder: !!recorder,
    preferredMime: recorder ? MIME_CANDIDATES.find(type => recorder.isTypeSupported(type)) ?? null : null,
    microphoneApi: !!environment.mediaDevices?.getUserMedia,
    audioElement: !!environment.Audio,
    secureContext: environment.secureContext === true
  }
}
