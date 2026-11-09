/** Real Harness inference dispatch with a synthetic provider and a supplied cold projection seam. Installed qualification uses the real Session Controller projection. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { RecoveryInferenceHost } from '../../src/recovery/inference.ts'
import type { RoleModel } from '../../src/policy.ts'

/** Synthetic provider records requests and supports deliberate failure/response changes without real credentials. */
export class InferenceAdapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  chunks: StreamChunk[] = [{ type: 'text-delta', index: 0, text: 'OK' }, { type: 'finish', reason: { kind: 'stop' } }]
  before?: (options: GenerateOptions) => Promise<void>
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options); await this.before?.(options)
    for (const chunk of this.chunks) yield chunk
  }
}

export async function inferenceFixture(ctx: Context): Promise<{ host: RecoveryInferenceHost; adapter: InferenceAdapter; select(model: RoleModel): void; unregister(): void }> {
  await ctx.plugin(LlmRuntime)
  const adapter = new InferenceAdapter(), unregister = ctx.llm.registerAdapter(['fixture'], adapter)
  let current: RoleModel = { provider: 'fixture', model: 'current' }
  const host: RecoveryInferenceHost = { llm: ctx.llm, currentSelection: () => current,
    projections: { restore(checkpoint, events, offset) {
      let pending = (checkpoint.modelSelection?.val as { pending: RoleModel | null } | undefined)?.pending ?? null
      for (const event of events) {
        if (event.type === 'model/selection') pending = event.data
        if (event.type === 'request/header' && pending?.provider === event.data.header.config.provider
          && pending.model === event.data.header.config.model && pending.reasoningEffort === event.data.header.config.reasoningEffort) pending = null
      }
      const seq = offset + events.length === 0 ? -1 : SessionSeq(offset + events.length - 1)
      return { snapshot: { asOfSeq: seq, values: {} }, checkpoint: { modelSelection: { ver: 0, seq, val: { pending } } } }
    } } }
  return { host, adapter, select: model => { current = model }, unregister }
}
