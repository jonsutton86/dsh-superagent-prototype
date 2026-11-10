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

/** Harness replaces an entry's whole config. Supply its effective config to preserve existing routes and settings. */
export function abliterationPatch(existingConfig: Record<string, unknown> = {}) {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  if (!record(existingConfig)) throw new Error('Existing llm-pi-ai configuration must be an object')
  const providers = existingConfig.providers === undefined ? {} : existingConfig.providers
  if (!record(providers)) throw new Error('Existing llm-pi-ai providers must be an object')
  if (Object.hasOwn(providers, ABLITERATION_ROUTE)) throw new Error('Abliteration is already configured; review the existing route before changing it')
  return [{ id: 'llm-pi-ai', config: { ...existingConfig, providers: { ...providers, [ABLITERATION_ROUTE]: abliterationProvider() } } }]
}
