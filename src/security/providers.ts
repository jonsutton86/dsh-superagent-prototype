/** Validated model-provider configuration. Configuration never asserts verification; live checks remain explicit. */
import { z } from 'zod'
import type { CredentialVault } from './credentials.ts'
import { routeCandidates } from './model-routing.ts'
import type { RoutingCandidatesResult } from './model-routing.ts'

export const ProviderId = z.enum(['openai', 'deepseek', 'openrouter', 'openai-compatible'])
export type ProviderId = z.infer<typeof ProviderId>

const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const safeBaseUrl = z.string().trim().max(2048).superRefine((value, ctx) => {
  let url: URL
  try { url = new URL(value) } catch { ctx.addIssue({ code: 'custom', message: 'must be an absolute URL' }); return }
  if (url.username || url.password) ctx.addIssue({ code: 'custom', message: 'must not embed credentials' })
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && loopback.has(url.hostname)) return
  ctx.addIssue({ code: 'custom', message: 'must use https, or http only for a loopback host' })
})

export const ProviderConfig = z.object({
  id: ProviderId,
  /** Operator-supplied base URL; endpoints are not assumed. Confirm the provider's current API documentation first. */
  baseUrl: safeBaseUrl,
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  defaultModel: z.string().trim().min(1).max(200).optional(),
  /** Vault entry name; the secret itself is never part of configuration. */
  credential: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/).optional(),
  monthlyBudgetUsd: z.number().nonnegative().max(1_000_000).optional(),
}).strict().superRefine((provider, ctx) => {
  if (provider.defaultModel && !provider.models.includes(provider.defaultModel))
    ctx.addIssue({ code: 'custom', path: ['defaultModel'], message: 'must be one of models' })
})

export const ProvidersConfig = z.array(ProviderConfig).max(20).superRefine((providers, ctx) => {
  const seen = new Set<string>()
  providers.forEach((provider, index) => {
    if (seen.has(provider.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'must be unique' })
    seen.add(provider.id)
  })
})
export type ProvidersConfig = z.infer<typeof ProvidersConfig>
export type ProviderConfig = z.infer<typeof ProviderConfig>

export interface ProviderView extends Omit<ProviderConfig, 'credential'> {
  credential: { name: string; present: boolean } | null
  /** Always false in configuration views: no live endpoint, model or credential check has been recorded. */
  verified: false
}

/** Reads `DSH_ORCHESTRATOR_PROVIDERS` as a JSON array. Malformed configuration fails startup with a path, never a secret. */
export function readProviders(env: NodeJS.ProcessEnv = process.env): ProvidersConfig {
  const raw = env.DSH_ORCHESTRATOR_PROVIDERS?.trim()
  if (!raw) return []
  let value: unknown
  try { value = JSON.parse(raw) as unknown }
  catch { throw new Error('DSH_ORCHESTRATOR_PROVIDERS must be a JSON array of provider configurations') }
  const parsed = ProvidersConfig.safeParse(value)
  if (!parsed.success) throw new Error(`Invalid provider configuration (${parsed.error.issues.map(issue => issue.path.join('.') || 'value').join(', ')}). Endpoints and model identifiers must be confirmed against provider documentation before use.`)
  return parsed.data
}

/** Read-only registry. It deliberately has no method that calls a provider or claims a successful verification. */
export class ProviderRegistry {
  constructor(private readonly providers: readonly ProviderConfig[], private readonly credentials?: Pick<CredentialVault, 'has'>) {}

  view(): ProviderView[] {
    return this.providers.map(provider => ({
      ...provider,
      credential: provider.credential ? { name: provider.credential, present: this.credentials?.has(provider.credential) ?? false } : null,
      verified: false,
    }))
  }

  /** Ordered local fallback candidates. It never calls a provider or asserts capability. */
  route(task: unknown, options: { monthlyBudgetUsd?: number; spentUsd?: Readonly<Record<string, number>> } = {}): RoutingCandidatesResult {
    return routeCandidates(this.providers, task, options)
  }

  get(id: string): ProviderConfig | undefined { return this.providers.find(provider => provider.id === id) }

  require(id: string): ProviderConfig {
    const provider = this.get(id)
    if (!provider) throw new Error(`Provider ${id} is not configured`)
    return provider
  }
}
