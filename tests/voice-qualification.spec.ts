import { describe, expect, it } from 'vitest'
import { voiceBrowserSupport } from '../src/client/voice-qualification.ts'

describe('voiceBrowserSupport', () => {
  it('reports the first supported recording format and every required API', () => {
    const support = voiceBrowserSupport({
      MediaRecorder: { isTypeSupported: type => type === 'audio/mp4' },
      mediaDevices: { getUserMedia: () => {} }, Audio: class {}, secureContext: true
    })
    expect(support).toEqual({ mediaRecorder: true, preferredMime: 'audio/mp4', microphoneApi: true, audioElement: true, secureContext: true })
  })

  it('prefers WebM Opus when the browser supports it', () => {
    expect(voiceBrowserSupport({ MediaRecorder: { isTypeSupported: type => type.startsWith('audio/webm') }, secureContext: false }).preferredMime)
      .toBe('audio/webm;codecs=opus')
  })

  it('reports missing APIs as unavailable without inferring permission or device state', () => {
    expect(voiceBrowserSupport({})).toEqual({ mediaRecorder: false, preferredMime: null, microphoneApi: false, audioElement: false, secureContext: false })
    const recorder = voiceBrowserSupport({ MediaRecorder: { isTypeSupported: () => false }, mediaDevices: {}, Audio: class {}, secureContext: true })
    expect(recorder).toMatchObject({ mediaRecorder: true, preferredMime: null, microphoneApi: false, audioElement: true, secureContext: true })
  })
})
