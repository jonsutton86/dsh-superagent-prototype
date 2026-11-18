/** Browser microphone ownership, final-chunk handling, and bounded recording. No ambient listening. */
export interface Recording { finish(): void; result: Promise<{ audio: string; mime: 'audio/webm' | 'audio/ogg' | 'audio/mp4' }> }
export async function recordMicrophone(signal: AbortSignal, maxBytes: number, maxMs: number): Promise<Recording> {
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type))
  if (!type) throw new Error('This browser does not support microphone recording; use text input')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const release = () => { for (const track of stream.getTracks()) track.stop() }
  if (signal.aborted) { release(); signal.throwIfAborted() }
  let recorder: MediaRecorder
  try { recorder = new MediaRecorder(stream, { mimeType: type }) } catch (error) { release(); throw error }
  const chunks: Blob[] = []; let size = 0, failure = false, done = false
  const finish = () => { if (recorder.state !== 'inactive') recorder.stop() }
  const result = new Promise<{ audio: string; mime: 'audio/webm' | 'audio/ogg' | 'audio/mp4' }>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); release() }
    const cancel = () => { failure = true; finish(); release() }
    const timer = setTimeout(finish, maxMs)
    recorder.ondataavailable = event => { size += event.data.size; if (size > maxBytes) { failure = true; finish() } else chunks.push(event.data) }
    recorder.onerror = () => { failure = true; finish(); if (recorder.state === 'inactive' && !done) { done = true; cleanup(); reject(new Error('Microphone recording failed')) } }
    recorder.onstop = () => {
      if (done) return; done = true; cleanup()
      if (failure || signal.aborted || !size) { reject(new Error('Recording cancelled, empty, or too large; use text input')); return }
      // MediaRecorder emits the last dataavailable event before stop; only now is the Blob complete.
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read the recording'))
      reader.onload = () => resolve({ audio: String(reader.result).split(',')[1]!, mime: type.split(';')[0] as 'audio/webm' | 'audio/ogg' | 'audio/mp4' })
      reader.readAsDataURL(new Blob(chunks, { type }))
    }
    signal.addEventListener('abort', cancel, { once: true })
    try { recorder.start(250) } catch (error) { done = true; cleanup(); reject(error) }
  })
  return { finish, result }
}
