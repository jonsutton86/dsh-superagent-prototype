/** Opt-in Harness configuration only. No credentials, inferred prices, runtime replacement, or default-model changes. */
export const ABLITERATION_ROUTE = 'abliteration'
export const ABLITERATION_BASE_URL = 'https://api.abliteration.ai/v1'
export const ABLITERATION_MODELS = ['abliterated-model', 'abliterated-model-large-flash'] as const
export const ABLITERATION_LIMITS = { outputTokens: 8192, images: 4, imageBytes: 12_000_000 } as const

/** Fresh mutable data for the existing llm-pi-ai schema; it must be applied explicitly by the operator. */
export function abliterationProvider() {
  return {
    displayName: 'Abliteration', apiKeyEnv: 'ABLIT_KEY', api: 'openai-completions', baseURL: ABLITERATION_BASE_URL,
    reasoning: 'low', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 60_000, streamIdleTimeoutMs: 30_000,
    requestImageMaxBytes: 1_048_576, maxRequestImageBytes: 8_388_608,
    models: ABLITERATION_MODELS.map((id, index) => ({ id, name: index ? 'Abliterated Large Flash' : 'Abliterated Model',
      contextWindow: index ? 1_048_576 : 262_144, maxTokens: ABLITERATION_LIMITS.outputTokens,
      input: ['text', 'image'], reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' } })),
  }
}

/** Cordis merges this route into llm-pi-ai; no agent-default-model or unrelated plugin entry is emitted. */
export function abliterationPatch() {
  return [{ id: 'llm-pi-ai', config: { providers: { [ABLITERATION_ROUTE]: abliterationProvider() } } }]
}
