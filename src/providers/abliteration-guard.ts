/** Enforce documented provider limits at Harness's public immutable-request boundary, before network dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ABLITERATION_LIMITS, ABLITERATION_MODELS, ABLITERATION_ROUTE } from './abliteration-config.ts'

export function assertAbliterationRequest(options: GenerateOptions): void {
  if (options.provider !== ABLITERATION_ROUTE) return
  if (!(ABLITERATION_MODELS as readonly string[]).includes(options.model))
    throw new LlmError('Select a configured Abliteration model before dispatch', 'UNSUPPORTED_MODEL')
  if (options.maxTokens === undefined || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > ABLITERATION_LIMITS.outputTokens)
    throw new LlmError('Abliteration requests are limited to 8192 output tokens', 'INVALID_REQUEST')
  let images = 0
  for (const message of options.messages) for (const block of message.content) {
    // Harness projects offloaded references to text before its OpenAI wire conversion.
    if (block.type !== 'image' || block.offloaded === true) continue
    if (++images > ABLITERATION_LIMITS.images)
      throw new LlmError('Abliteration accepts at most four retained images across the complete request history. Offload older images or start a new task.', 'UNSUPPORTED_CONTENT')
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.attachment.mediaType)
      || !Number.isSafeInteger(block.attachment.bytes) || block.attachment.bytes < 1 || block.attachment.bytes > ABLITERATION_LIMITS.imageBytes)
      throw new LlmError('Abliteration images must be PNG, JPEG, WebP or GIF and no larger than 12 MB', 'UNSUPPORTED_CONTENT')
  }
}

/** Reads the same history sent to the adapter, including tool-result images; never mutates or silently truncates it. */
export function installAbliterationGuard(ctx: Context): () => void {
  return ctx.on('llm/stream', async function* (options, next): AsyncIterable<StreamChunk> {
    assertAbliterationRequest(options)
    yield* next()
  }, { prepend: true })
}
