/** OpenAI-compatible chat-completions transport for ordered fallback execution. No endpoint is assumed or verified. */
import type { ExecutionRequest, ExecutionResult, ExecutionTransport } from './provider-execution.ts'
import type { RouteCandidate } from './model-routing.ts'

/** The narrow input shape this transport can encode; other task adapters must provide their own transport. */
export interface ChatInput {
  prompt?: string
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

/** Reads a credential only when the provider configuration names one; values never enter errors or results. */
export interface CredentialReader {
  get(name: string): string
}

/** Options for the HTTP transport. `fetch` is injectable so tests never contact a provider. */
export interface HttpProviderOptions {
  fetch?: typeof fetch
  credentials?: CredentialReader
  timeoutMs?: number
}

const reportedUsage = (value: unknown): ExecutionResult['reported'] => {
  if (!value || typeof value !== 'object') return undefined
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
  const input = usage.prompt_tokens, output = usage.completion_tokens, total = usage.total_tokens
  if (![input, output, total].every(item => item === undefined || Number.isSafeInteger(item) && (item as number) >= 0)) return undefined
  if (input === undefined && output === undefined && total === undefined) return undefined
  return {
    ...(input !== undefined ? { inputTokens: input as number } : {}),
    ...(output !== undefined ? { outputTokens: output as number } : {}),
    ...(total !== undefined ? { totalTokens: total as number } : {})
  }
}

/** Encode only the documented shapes; refuse anything else instead of guessing a provider request. */
function messages(input: unknown): ChatInput['messages'] {
  if (!input || typeof input !== 'object') throw new Error('Provider request input must be an object')
  const value = input as ChatInput
  if (value.messages !== undefined) {
    if (!Array.isArray(value.messages) || value.messages.length === 0) throw new Error('Provider messages must be a non-empty array')
    for (const message of value.messages) {
      if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
        throw new Error('Provider messages must contain role and string content')
    }
    return value.messages
  }
  if (typeof value.prompt === 'string' && value.prompt.trim()) return [{ role: 'user', content: value.prompt }]
  throw new Error('Provider request input requires prompt or messages')
}

/** Executes one candidate against `<baseUrl>/chat/completions`; callers must still reserve budget around the attempt. */
export class HttpProviderTransport implements ExecutionTransport {
  constructor(private readonly options: HttpProviderOptions = {}) {}

  async execute(candidate: RouteCandidate, request: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const provider = candidate.provider
    const secret = provider.credential ? this.options.credentials?.get(provider.credential) : undefined
    if (provider.credential && !secret) throw new Error(`Provider ${provider.id} credential is unavailable`)
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 120_000)
    const combined = AbortSignal.any([signal, timeout])
    const payload = JSON.stringify({ model: candidate.model, messages: messages(request.input), stream: false })
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
        body: payload,
        signal: combined
      })
    } catch {
      throw new Error(combined.aborted ? 'Provider request aborted' : `Provider ${provider.id} request failed`)
    }
    if (!response.ok) throw new Error(`Provider ${provider.id} returned HTTP ${response.status}`)
    let body: unknown
    try { body = await response.json() } catch { throw new Error(`Provider ${provider.id} returned invalid JSON`) }
    const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error(`Provider ${provider.id} returned no text content`)
    return { output: content, reported: reportedUsage((body as { usage?: unknown }).usage) }
  }
}
