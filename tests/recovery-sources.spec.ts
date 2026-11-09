import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import * as Catalog from '../src/sources/catalog.ts'
import * as Github from '../src/sources/github.ts'
import * as Feishu from '../src/sources/feishu.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { sourceAvailable } from '../src/sources/contracts.ts'
import { recoverySourceHost, sourceConfigurationCheck } from '../src/recovery/sources.ts'
import { SettingsSchema } from '../src/policy.ts'

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(publisher = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-source-recovery-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Catalog)
  const store = new Store(join(directory, 'store.sqlite')); cleanup.push(() => store.close())
  store.set(KV.runtime.ownership, { authorityId: 'authority', coordinatorId: 'coordinator' })
  if (publisher) store.set(KV.runtime.publication, { serviceId: 'publisher' })
  const abort = new AbortController(), host = recoverySourceHost(ctx)
  return { ctx, store, abort, host, catalog: ctx.superagentSources,
    check: () => sourceConfigurationCheck(host, store.db, abort.signal) }
}

it('loads both external source contracts without a coordinator or polling host', async () => {
  const f = await fixture(); await f.ctx.plugin(Github); await f.ctx.plugin(Feishu)
  expect(f.ctx.get('orchestrator')).toBeUndefined()
  expect(f.catalog.snapshot().contracts.map(contract => contract.kind)).toEqual(['conversation', 'feishu', 'github', 'publication', 'workspace'])
  const check = f.check(), result = check.verify()
  expect(result).toEqual({ kinds: 5, enabled: 3, inactive: 2, retained: 0, configuration: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(check.verify()).toEqual(result)
})
it('mounts polling only when its coordinator arrives and keeps the passive contract when it leaves', async () => {
  const f = await fixture(); await f.ctx.plugin(Github)
  const sources = new SourceRegistry(() => SettingsSchema.parse({})), report = vi.fn()
  const source = { ready: Promise.resolve(), configured: () => false, report }
  const runtime = await f.ctx.plugin({ name: 'source-runtime-fixture', apply(ctx: Context) {
    ctx.reflect.provide('orchestrator', { sources, context: () => source } as never)
  } })
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith('github', expect.objectContaining({ code: 'setupPending' })))
  expect(sources.kind('github')).toBe(Github.githubKind)
  await runtime.dispose()
  expect(sources.kind('github')).toBeUndefined()
  expect(f.catalog.snapshot().contracts.some(contract => contract.kind === 'github')).toBe(true)
})
it('rejects duplicate registration and treats repeated disposal as one catalog change', async () => {
  const f = await fixture(), release = f.catalog.register(Github.githubKind), before = f.catalog.snapshot().revision
  expect(() => f.catalog.register(Github.githubKind)).toThrow('already registered')
  release(); release(); expect(f.catalog.snapshot().revision).toBe(before + 1)
  f.catalog.register(Github.githubKind); release()
  expect(f.catalog.snapshot().contracts.some(contract => contract.kind === 'github')).toBe(true)
})
it('derives enabled sources with the same availability rule as the running registry', async () => {
  const f = await fixture(false), contracts = f.catalog.snapshot().contracts
  const registry = new SourceRegistry(() => f.store.settings(), undefined, undefined,
    id => sourceAvailable({ owned: true, publication: false, local: false }, id))
  for (const contract of contracts) registry.register({ ...contract, title: { en: contract.kind, zh: contract.kind }, description: { en: '', zh: '' }, fields: [], health: [] })
  expect(registry.instances().filter(instance => instance.enabled).map(instance => instance.id)).toEqual(['workspace'])
  expect(f.check().verify()).toMatchObject({ kinds: 3, enabled: 1, inactive: 2 })
})
it('keeps explicitly disabled unknown sources opaque without silently accepting enabled or policy-only missing plugins', async () => {
  const f = await fixture(); f.store.saveSettings({ sources: { retired: { enabled: false, config: { opaque: 'preserved' } } }, policy: { sources: { retired: { allowed: [] } } } })
  const before = f.store.settings()
  expect(f.check().verify().retained).toBe(1); expect(f.store.settings()).toEqual(before)
  f.store.saveSettings({ sources: { absent: { enabled: true } } })
  expect(() => f.check().verify()).toThrow('source_configuration_missing')
  f.store.saveSettings({ policy: { sources: { absent: { allowed: [] } } } })
  expect(() => f.check().verify()).toThrow('source_configuration_missing')
})
it.each(['config', 'policy'] as const)('rejects invalid registered %s settings without falling back to defaults or exposing diagnostics', async part => {
  const f = await fixture(); await f.ctx.plugin(Github)
  f.store.saveSettings(part === 'config' ? { sources: { workspace: { config: { invalid: 'synthetic-private-value' } } } }
    : { policy: { sources: { github: { allowed: [{ id: 'synthetic-private-value!' }] } } } })
  expect(() => f.check().verify()).toThrow(/^source_configuration_invalid$/)
})
it('uses the optional service lookup from a restricted maintenance fiber', async () => {
  const f = await fixture()
  await f.ctx.plugin({ name: 'source-maintenance', apply(ctx: Context) {
    expect(() => ctx.superagentSources).toThrow('without inject')
    expect(sourceConfigurationCheck(recoverySourceHost(ctx), f.store.db, f.abort.signal).verify().enabled).toBe(3)
  } })
})
it('detects a source unloading and reloading even when its settings and schema are identical', async () => {
  const f = await fixture(), release = f.catalog.register(Github.githubKind), check = f.check(); check.verify()
  release(); f.catalog.register(Github.githubKind)
  expect(() => check.verify()).toThrow('source_configuration_changed')
})
it('detects changed settings and private defaults between passes', async () => {
  const f = await fixture(), check = f.check(); check.verify()
  f.store.saveSettings({ sources: { workspace: { enabled: false } } })
  expect(() => check.verify()).toThrow('source_configuration_changed')
  let value = 'original'
  f.catalog.register({ kind: 'dynamic', schema: z.object({ value: z.string().default(() => value) }) })
  const changed = f.check(); changed.verify(); value = 'changed'
  expect(() => changed.verify()).toThrow('source_configuration_changed')
})
it('rejects a replaced catalog service rather than adopting its new generation', async () => {
  const f = await fixture(), host = { current: () => f.catalog }, check = sourceConfigurationCheck(host, f.store.db, f.abort.signal); check.verify()
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose()); const replacement = new Catalog.SourceCatalog(ctx)
  host.current = () => replacement
  expect(() => check.verify()).toThrow('source_configuration_changed')
})
it('requires the authenticated settings revision and a live catalog', async () => {
  const f = await fixture(); f.store.set(KV.settings.revision, 99)
  expect(() => f.check().verify()).toThrow('source_configuration_missing')
  expect(() => sourceConfigurationCheck({ current: () => undefined }, f.store.db, f.abort.signal).verify()).toThrow('source_configuration_missing')
})
it('honors cancellation without consulting the catalog or changing settings', async () => {
  const f = await fixture(), current = vi.spyOn(f.host, 'current'); f.abort.abort(new Error('Maintenance canceled'))
  expect(() => f.check().verify()).toThrow('Maintenance canceled'); expect(current).not.toHaveBeenCalled()
})
