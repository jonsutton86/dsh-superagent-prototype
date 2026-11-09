/** Validate the selected maintenance host's passive source contracts against authenticated owned-coordinator settings. */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { SourceCatalog } from '../sources/catalog.ts'
import { sourceAvailable } from '../sources/contracts.ts'
import { SettingsSchema } from '../policy.ts'
import { KV } from '../kv.ts'
import { fingerprint } from '../remote/journal.ts'

export interface RecoverySourceHost { current(): SourceCatalog | undefined }
export interface SourceConfigurationVerification { kinds: number; enabled: number; inactive: number; retained: number; configuration: string }
/** Source validation failures expose no stored configuration or plugin diagnostics. */
export class SourceConfigurationError extends Error {
  constructor(readonly code: 'source_configuration_missing' | 'source_configuration_invalid' | 'source_configuration_changed') { super(code) }
}
/** Offline modes and original-ID retries do not require source plugins to remain loaded. */
export const recoverySourceHost = (ctx: Context): RecoverySourceHost => ({ current: () => ctx.get('superagentSources') })
const get = (db: DatabaseSync, key: string): unknown => {
  const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key)
  return row ? JSON.parse(String(row.value)) : undefined
}

export function sourceConfigurationCheck(host: RecoverySourceHost, db: DatabaseSync, signal: AbortSignal): { verify(): SourceConfigurationVerification } {
  let generation: string | undefined, revision: number | undefined, selected: string | undefined
  return { verify: () => {
    signal.throwIfAborted()
    try {
      const catalog = host?.current()
      if (!catalog) throw new SourceConfigurationError('source_configuration_missing')
      const snapshot = catalog.snapshot()
      if (generation && generation !== snapshot.generation) throw new SourceConfigurationError('source_configuration_changed')
      if (revision !== undefined && revision !== snapshot.revision) throw new SourceConfigurationError('source_configuration_changed')
      const contracts = new Map(snapshot.contracts.map(contract => [contract.kind, contract]))
      if (contracts.size !== snapshot.contracts.length || !contracts.has('workspace') || !contracts.has('publication') || !contracts.has('conversation'))
        throw new SourceConfigurationError('source_configuration_missing')
      const owner = get(db, KV.runtime.ownership)
      if (!owner || typeof owner !== 'object' || !('coordinatorId' in owner)) throw new SourceConfigurationError('source_configuration_missing')
      const publisher = get(db, KV.runtime.publication)
      if (publisher !== undefined && (!publisher || typeof publisher !== 'object' || !('serviceId' in publisher) || typeof publisher.serviceId !== 'string'))
        throw new SourceConfigurationError('source_configuration_invalid')
      const settingsRevision = get(db, KV.settings.revision)
      const version = settingsRevision === undefined ? undefined : get(db, KV.settings.version(z.number().int().nonnegative().parse(settingsRevision)))
      if (settingsRevision !== undefined && (!version || typeof version !== 'object' || !('settings' in version))) throw new SourceConfigurationError('source_configuration_missing')
      const settings = SettingsSchema.parse(version ? (version as { settings: unknown }).settings : {})
      const retained = [...new Set([...Object.keys(settings.sources), ...Object.keys(settings.policy.sources)])].filter(id => !contracts.has(id)).sort()
      if (retained.some(id => settings.sources[id]?.enabled !== false)) throw new SourceConfigurationError('source_configuration_missing')
      const mode = { owned: true, publication: publisher !== undefined, local: true }
      const configurations = [...contracts].map(([id, contract]) => {
        const stored = settings.sources[id], part = settings.policy.sources[id]
        const { admission, ...rest } = part ?? {}
        return { id, enabled: sourceAvailable(mode, id) && (stored?.enabled ?? true), config: contract.schema.parse(stored?.config ?? {}),
          policy: contract.policy ? { ...contract.policy.schema.parse(rest), admission: admission ?? {} } : part }
      }).sort((a, b) => a.id.localeCompare(b.id))
      const configuration = fingerprint({ mode, settingsRevision, sources: configurations,
        retained: retained.map(id => ({ id, source: settings.sources[id], policy: settings.policy.sources[id] })) })
      if (selected && selected !== configuration) throw new SourceConfigurationError('source_configuration_changed')
      generation = snapshot.generation; revision = snapshot.revision; selected = configuration
      const enabled = configurations.filter(item => item.enabled).length
      return { kinds: contracts.size, enabled, inactive: contracts.size - enabled, retained: retained.length, configuration }
    } catch (error) {
      if (error instanceof SourceConfigurationError) throw error
      throw new SourceConfigurationError('source_configuration_invalid')
    }
  } }
}
