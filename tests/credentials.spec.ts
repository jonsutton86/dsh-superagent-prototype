import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CredentialVault } from '../src/security/credentials.ts'
import { ProviderRegistry, readProviders } from '../src/security/providers.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
const KEYS = ['DSH_ORCHESTRATOR_ADMIN_TOKEN', 'DSH_ORCHESTRATOR_ROLE', 'DSH_ORCHESTRATOR_PROVIDERS'] as const
const TOKEN = 'credential-test-token-0123456789abcdef'
const SECRET = 'sk-test-value-must-not-leak'

afterEach(async () => {
  await host?.stop(); host = undefined
  for (const key of KEYS) delete process.env[key]
  vi.restoreAllMocks()
})

function vaultFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'credential-vault-'))
  return { directory, vault: new CredentialVault(directory) }
}

it('stores credentials atomically with 0600 files and lists names and metadata only', () => {
  const { directory, vault } = vaultFixture()
  try {
    const stored = vault.set('openai-key', SECRET)
    expect(stored).toMatchObject({ name: 'openai-key', bytes: Buffer.byteLength(SECRET) })
    expect(vault.get('openai-key')).toBe(SECRET)
    expect(vault.has('openai-key')).toBe(true)
    expect(statSync(join(directory, 'credentials', 'openai-key.secret')).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, 'credentials')).mode & 0o777).toBe(0o700)
    const listed = vault.list()
    expect(listed).toEqual([expect.objectContaining({ name: 'openai-key', bytes: Buffer.byteLength(SECRET) })])
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    expect(readFileSync(join(directory, 'credentials', 'openai-key.secret'), 'utf8')).toBe(SECRET)
    // Rotation replaces the value, still exactly one entry.
    vault.set('openai-key', 'rotated-secret')
    expect(vault.get('openai-key')).toBe('rotated-secret')
    expect(vault.list()).toHaveLength(1)
    expect(vault.delete('openai-key')).toBe(true)
    expect(vault.delete('openai-key')).toBe(false)
    expect(vault.get('openai-key')).toBeUndefined()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('rejects traversal names, empty or oversized values, and symlinked entries', () => {
  const { directory, vault } = vaultFixture()
  try {
    for (const name of ['../escape', 'UPPER', 'a/b', 'a b', '', '-leading']) expect(() => vault.set(name, 'x')).toThrow()
    expect(() => vault.set('valid-name', '')).toThrow('cannot be empty')
    expect(() => vault.set('valid-name', 'x'.repeat(16 * 1024 + 1))).toThrow('cannot exceed')
    const target = join(directory, 'outside.txt')
    writeFileSync(target, 'outside')
    symlinkSync(target, join(directory, 'credentials', 'linked.secret'))
    expect(() => vault.get('linked')).toThrow('symlink')
    expect(() => vault.set('linked', 'new')).toThrow('symlink')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('validates provider endpoints and models without claiming live verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'provider-config-'))
  const vault = new CredentialVault(directory)
  try {
    vault.set('openai-key', SECRET)
    const providers = readProviders({ DSH_ORCHESTRATOR_PROVIDERS: JSON.stringify([
      { id: 'openai', baseUrl: 'https://api.example.test/v1', models: ['model-a'], defaultModel: 'model-a', credential: 'openai-key', monthlyBudgetUsd: 10 },
      { id: 'deepseek', baseUrl: 'http://127.0.0.1:8080/v1', models: ['model-b'] },
    ]) } as NodeJS.ProcessEnv)
    const view = new ProviderRegistry(providers, vault).view()
    expect(view[0]).toMatchObject({ id: 'openai', verified: false, credential: { name: 'openai-key', present: true } })
    expect(view[1]).toMatchObject({ id: 'deepseek', verified: false, credential: null })
    expect(JSON.stringify(view)).not.toContain(SECRET)

    const invalid = (value: unknown) => () => readProviders({ DSH_ORCHESTRATOR_PROVIDERS: JSON.stringify(value) } as NodeJS.ProcessEnv)
    expect(invalid([{ id: 'openai', baseUrl: 'http://remote.example.test/v1', models: ['m'] }])).toThrow(/Invalid provider configuration/)
    expect(invalid([{ id: 'openai', baseUrl: 'https://user:pass@example.test/v1', models: ['m'] }])).toThrow(/Invalid provider configuration/)
    expect(invalid([{ id: 'openai', baseUrl: 'https://example.test/v1', models: ['m'], defaultModel: 'other' }])).toThrow(/Invalid provider configuration/)
    expect(invalid([{ id: 'openai', baseUrl: 'https://example.test/v1', models: ['m'] }, { id: 'openai', baseUrl: 'https://example.test/v2', models: ['m'] }]))
      .toThrow(/Invalid provider configuration/)
    expect(invalid([{ id: 'unknown-provider', baseUrl: 'https://example.test/v1', models: ['m'] }])).toThrow(/Invalid provider configuration/)
    expect(() => readProviders({ DSH_ORCHESTRATOR_PROVIDERS: '{not json' } as NodeJS.ProcessEnv)).toThrow(/JSON array/)
    expect(readProviders({} as NodeJS.ProcessEnv)).toEqual([])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('exposes redacted credential and provider views through the management API', async () => {
  process.env.DSH_ORCHESTRATOR_PROVIDERS = JSON.stringify([
    { id: 'openai-compatible', baseUrl: 'https://llm.example.test/v1', models: ['model-a'], defaultModel: 'model-a', credential: 'provider-key', monthlyBudgetUsd: 5 },
  ])
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const written = await h.api('POST', 'credentials/provider-key', { requestId: 'credential-1', value: SECRET })
  expect(written.status).toBe(200)
  expect(written.body).toMatchObject({ name: 'provider-key', bytes: Buffer.byteLength(SECRET) })
  const listed = await h.api('GET', 'credentials')
  expect(listed.body).toEqual({ items: [expect.objectContaining({ name: 'provider-key' })] })
  expect(JSON.stringify(listed.body)).not.toContain(SECRET)
  const providers = await h.api('GET', 'providers')
  expect(providers.body).toMatchObject({ verified: false, items: [expect.objectContaining({ id: 'openai-compatible', verified: false,
    credential: { name: 'provider-key', present: true } })] })
  expect(JSON.stringify(providers.body)).not.toContain(SECRET)
  const state = await h.api('GET', 'state')
  expect(JSON.stringify(state.body)).not.toContain(SECRET)
  const audit = h.runtime.audit.list(20, undefined)
  expect(audit.items).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'credential.write', resource: 'provider-key' })]))
  expect(JSON.stringify(audit.items)).not.toContain(SECRET)
  expect(h.runtime.audit.verify()).toBe(true)
  expect((await h.api('DELETE', 'credentials/provider-key')).body).toEqual({ deleted: true })
  expect(h.runtime.credentials.get('provider-key')).toBeUndefined()
})

it('denies credential writes to a viewer while allowing provider reads', async () => {
  process.env.DSH_ORCHESTRATOR_ADMIN_TOKEN = TOKEN
  process.env.DSH_ORCHESTRATOR_ROLE = 'viewer'
  const h = host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const headers = { authorization: `Bearer ${TOKEN}` }
  expect((await h.api('GET', 'providers', undefined, headers)).status).toBe(200)
  const denied = await h.api('POST', 'credentials/viewer-key', { requestId: 'viewer-1', value: SECRET }, headers)
  expect(denied.status).toBe(403)
  expect(h.runtime.credentials.get('viewer-key')).toBeUndefined()
  expect((await h.api('GET', 'credentials', undefined, headers)).status).toBe(403)
})
