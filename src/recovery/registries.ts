/** Read-only historical identity and execution-grant verification in a held recovery image. */
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ExecutionLocation, Ticket, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { PersonaDefinition, PersonaRef, CreatePersona, SavePersona, ArchivePersona, type PersonaRecord } from '../personas/model.ts'
import { GrantMetadata } from '../environments/endpoint-model.ts'
import { fingerprint } from '../remote/journal.ts'
import { remotePresetBinding } from '../remote/presets.ts'
import { worldBinding, type WorldRecord } from '../remote/world-journal.ts'
import { RepositorySource, repositoryCredential } from '../environments/repository-model.ts'

const id = z.string().min(1).max(4096), uuid = z.string().uuid(), at = z.iso.datetime({ offset: true })
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), digest = z.string().regex(/^[a-f0-9]{64}$/)
const requestId = CreatePersona.shape.requestId, absolute = id.refine(value => isAbsolute(value) && !value.includes('\0'))
const object = z.record(z.string(), z.unknown())
const personaVersion = PersonaRef.extend({ definition: PersonaDefinition, createdAt: at, digest }).strict()
const personaRecord = personaVersion.extend({ revision: positive, archived: z.boolean(), updatedAt: at }).strict()
const personaEvent = z.object({ at, revision: positive, version: positive, archived: z.boolean(), reason: ArchivePersona.shape.reason }).strict()
const environmentRecord = z.object({ id: uuid, name: z.string().trim().min(1).max(160), kind: z.enum(['local', 'remote']),
  root: absolute, configuredRoot: absolute, mode: z.enum(['local', 'repository']), identity: id, revision: positive, epoch: positive,
  enabled: z.boolean(), createdAt: at, updatedAt: at, retired: z.literal(true).optional(), remote: z.object({ binding: digest,
    endpointId: uuid, grantId: uuid, epoch: positive, credentials: GrantMetadata.shape.credentials }).strict().optional() }).strict()
const environmentEvent = z.object({ at, enabled: z.boolean(), revision: positive, epoch: positive, reason: z.string().min(1).max(2000) }).strict()
const worldRecord = z.object({ id: digest, name: z.string().trim().min(1).max(160), endpointId: uuid, grantId: uuid,
  epoch: positive, root: absolute, revision: positive, enabled: z.boolean(), createdAt: at, updatedAt: at, credentialPin: digest,
  grant: GrantMetadata, config: z.object({ endpointId: uuid, url: id, credentialFile: absolute, stateDir: absolute,
    timeoutMs: z.number().int().min(100).max(60000).optional() }).strict(),
  revoke: z.object({ requestId, reason: z.string().trim().min(1).max(2000) }).strict().optional(), repository: RepositorySource.optional() }).strict()
const executionGrant = z.object({ environmentId: id, revision: positive, epoch: positive, world: digest.optional() }).strict()

export interface RegistryStateVerification {
  version: 1; records: number; personas: number; personaVersions: number; personaCommands: number; personaReferences: number; unresolvedTemplateReferences: number;
  environments: number; environmentEvents: number; managedWorlds: number; opaqueCommandReceipts: number;
  executions: number; personaExecutions: number; historicalGrants: number; legacyGrants: number;
  sessions: number; personaPins: number; worldPins: number; pendingPins: number; legacySessionPins: number; digest: string
}
export interface RegistryStateContext { sessions: readonly { id: string; header: SessionHeader }[]; masterId: string; worlds: readonly WorldRecord[] }
/** Relation-only diagnostics deliberately exclude definitions, workspace paths and private configuration. */
export class RegistryStateError extends Error {
  constructor(readonly code: string, readonly relation: string) { super(`recovery_registries_${code}: ${relation}`) }
}

/** Preserve original definitions and revoked generations without consulting providers, opening credentials or admitting work. */
export async function verifyRegistryState(db: DatabaseSync, context: RegistryStateContext, signal: AbortSignal): Promise<RegistryStateVerification> {
  const fail = (code: string, label: string): never => { throw new RegistryStateError(code, label) }
  const same = (a: unknown, b: unknown, label: string) => { if (!isDeepStrictEqual(a, b)) fail('conflict', label) }
  const parse = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
    const result = schema.safeParse(value)
    if (!result.success || !isDeepStrictEqual(result.data, value)) fail('shape', label)
    return value as T
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)))
  const hash = createHash('sha256'); let records = 0, bytes = 0, links = 0, ticks = 0, personaReferences = 0,
    environmentEvents = 0, opaqueCommandReceipts = 0, executions = 0, personaExecutions = 0, historicalGrants = 0,
    legacyGrants = 0, personaPins = 0, worldPins = 0, pendingPins = 0, legacySessionPins = 0, unresolvedTemplateReferences = 0
  const checkpoint = async () => { signal.throwIfAborted(); if (++links > 2_000_000) fail('limit', 'relations'); if (++ticks % 64 === 0) await setImmediate(undefined, { signal }) }
  function charge(value: string, label: string) {
    const size = Buffer.byteLength(value)
    if (++records > 250000 || size > 8 * 1024 * 1024 || (bytes += size) > 256 * 1024 * 1024) fail('limit', label)
  }
  function json<T>(raw: unknown, schema: z.ZodType<T>, label: string): T {
    charge(String(raw), label)
    let value: unknown; try { value = JSON.parse(String(raw)) } catch { fail('shape', label) }
    return parse(schema, value, label)
  }
  function* rows(table: string): Generator<Record<string, SQLOutputValue>> {
    if (!tables.has(table)) return
    for (const row of db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).iterate()) {
      const encoded = JSON.stringify([table, row]); charge(encoded, table); hash.update(encoded + '\n'); yield row
    }
  }
  const needed = <T>(map: Map<string, T>, identity: string, label: string): T => map.get(identity) ?? fail('reference', label)
  const personas = new Map<string, z.infer<typeof personaRecord>>(), versions = new Map<string, z.infer<typeof personaVersion>>()
  for (const row of rows('persona')) { await checkpoint(); const value = json(row.value, personaRecord, 'persona'); same(row.id, value.id, 'persona_id'); personas.set(value.id, value) }
  for (const row of rows('persona_version')) {
    await checkpoint(); const value = json(row.value, personaVersion, 'persona_version'), head = needed(personas, value.id, 'persona_head')
    same([row.id, row.version], [value.id, value.version], 'persona_version_id')
    if (value.version > head.version) fail('history', 'persona_version')
    same(value.digest, fingerprint({ id: value.id, version: value.version, definition: value.definition }), 'persona_digest')
    versions.set(`${value.id}:${value.version}`, value)
  }
  const events = new Map<string, z.infer<typeof personaEvent>>(), eventCounts = new Map<string, number>()
  for (const row of rows('persona_event')) {
    await checkpoint(); const value = json(row.value, personaEvent, 'persona_event'), persona = String(row.persona)
    needed(personas, persona, 'persona_event_owner'); const next = (eventCounts.get(persona) ?? 0) + 1
    same(value.revision, next, 'persona_event_order'); eventCounts.set(persona, next); events.set(`${persona}:${next}`, value)
  }
  const commands = new Map<string, PersonaRecord>(); let personaCommands = 0
  for (const row of rows('persona_command')) {
    await checkpoint(); const value = json(row.value, personaRecord, 'persona_command'), previous = commands.get(value.id)
    const event = needed(events, `${value.id}:${value.revision}`, 'persona_command_event')
    parse(requestId, row.id, 'persona_request'); needed(personas, value.id, 'persona_command_owner')
    same(value.revision, (previous?.revision ?? 0) + 1, 'persona_command_order')
    same([event.at, event.archived, event.version], [value.updatedAt, value.archived, value.version], 'persona_command_event')
    const { revision: _, archived: __, updatedAt: ___, ...snapshot } = value
    same(snapshot, needed(versions, `${value.id}:${value.version}`, 'persona_snapshot'), 'persona_snapshot')
    let request: unknown
    if (!previous) {
      same([value.revision, value.version, value.archived, value.createdAt, event.reason], [1, 1, false, value.updatedAt, 'Created persona'], 'persona_create')
      request = { op: 'create', ...CreatePersona.parse({ requestId: row.id, definition: value.definition }) }
    } else if (value.version === previous.version + 1) {
      same([value.archived, value.createdAt, event.reason], [previous.archived, value.updatedAt, 'Saved persona version'], 'persona_update')
      request = { op: 'update', id: value.id, ...SavePersona.parse({ requestId: row.id, revision: previous.revision, definition: value.definition }) }
    } else {
      same([value.version, value.createdAt, value.definition, value.digest], [previous.version, previous.createdAt, previous.definition, previous.digest], 'persona_archive')
      request = { op: 'archive', id: value.id, ...ArchivePersona.parse({ requestId: row.id, revision: previous.revision, archived: value.archived, reason: event.reason }) }
    }
    same(row.fingerprint, fingerprint(request), 'persona_request_hash'); commands.set(value.id, value); personaCommands++
  }
  for (const head of personas.values()) {
    await checkpoint(); same(head, needed(commands, head.id, 'persona_history'), 'persona_head')
    same(head.revision, eventCounts.get(head.id), 'persona_event_count')
    for (let version = 1; version <= head.version; version++) { await checkpoint(); needed(versions, `${head.id}:${version}`, 'persona_version_gap') }
  }
  function reference(value: unknown) {
    const ref = parse(PersonaRef, value, 'persona_reference'); personaReferences++
    return needed(versions, `${ref.id}:${ref.version}`, 'persona_reference')
  }
  const originals = new Map<string, WorldRecord>()
  for (const world of context.worlds) {
    await checkpoint(); const binding = worldBinding(world.endpointId, world.grant)
    if (originals.has(binding)) fail('duplicate', 'world_journal')
    charge(JSON.stringify(world), 'world_journal'); hash.update(JSON.stringify(['world_journal', world]) + '\n'); originals.set(binding, world)
  }
  const managed = new Map<string, z.infer<typeof worldRecord>>()
  for (const row of rows('managed_world')) {
    await checkpoint(); const value = json(row.value, worldRecord, 'managed_world'), original = needed(originals, value.id, 'managed_world_journal')
    same([row.id, value.id, value.endpointId, value.grantId, value.epoch, value.root],
      [value.id, worldBinding(value.config.endpointId, value.grant), value.config.endpointId, value.grant.id, value.grant.epoch, value.grant.root], 'managed_world_binding')
    same(value.id, worldBinding(original.endpointId, original.grant), 'managed_world_authority')
    if (!value.grant.enabled || !value.grant.operations.includes('fs.read') || !value.grant.operations.includes('process.spawn')) fail('authority', 'managed_world_original_grant')
    if (value.repository) try { repositoryCredential(value.repository, value.grant) } catch { fail('authority', 'managed_repository_grant') }
    same([value.revision, value.enabled], value.revoke ? [2, false] : [1, true], 'managed_world_generation')
    same(value.revoke ?? null, original.revocation ? { requestId: original.revocation.requestId, reason: original.revocation.reason } : null, 'managed_world_revocation')
    if (!value.revoke) same(value.createdAt, value.updatedAt, 'managed_world_time')
    managed.set(value.id, value)
  }
  const environments = new Map<string, z.infer<typeof environmentRecord>>()
  for (const row of rows('execution_environment')) {
    await checkpoint(); const value = json(row.value, environmentRecord, 'environment')
    same([row.id, value.revision, value.configuredRoot], [value.id, value.epoch, resolve(value.configuredRoot)], 'environment_identity')
    if (value.kind === 'local') { parse(uuid, value.identity, 'environment_marker'); if (value.remote) fail('conflict', 'local_remote') }
    else {
      if (!value.remote) fail('reference', 'environment_world')
      const remote = value.remote!, original = needed(originals, remote.binding, 'environment_world')
      same([value.identity, value.root, value.configuredRoot, remote.endpointId, remote.grantId, remote.epoch, remote.credentials ?? []],
        [remote.binding, original.grant.root, original.grant.root, original.endpointId, original.grant.id, original.grant.epoch, original.grant.credentials ?? []], 'environment_world_binding')
    }
    if (value.retired && value.enabled) fail('conflict', 'retired_environment')
    environments.set(value.id, value)
  }
  const generations = new Set<string>(), envEvents = new Map<string, z.infer<typeof environmentEvent>>(), envEventCounts = new Map<string, number>()
  for (const row of rows('execution_environment_event')) {
    await checkpoint(); const value = json(row.value, environmentEvent, 'environment_event'), owner = String(row.environment)
    const head = needed(environments, owner, 'environment_event_owner'), previous = envEvents.get(owner)
    if (!previous) same([value.revision, value.epoch, value.enabled, value.at, value.reason], [1, 1, true, head.createdAt, 'Enrolled configured execution environment'], 'environment_enrollment')
    else {
      const replacement = head.retired && value.revision === head.revision && value.reason === 'Replaced execution environment enrollment'
      const advance = value.enabled !== previous.enabled || replacement ? 1 : 0
      same([value.revision, value.epoch], [previous.revision + advance, previous.epoch + advance], 'environment_event_generation')
      if (previous.reason === 'Replaced execution environment enrollment' && head.retired && previous.revision === head.revision) fail('history', 'retired_environment_events')
    }
    if (value.enabled) generations.add(`${owner}:${value.revision}:${value.epoch}`)
    envEvents.set(owner, value); envEventCounts.set(owner, (envEventCounts.get(owner) ?? 0) + 1); environmentEvents++
  }
  for (const head of environments.values()) {
    await checkpoint(); const last = needed(envEvents, head.id, 'environment_history')
    same([head.revision, head.epoch, head.enabled, head.updatedAt], [last.revision, last.epoch, last.enabled, last.at], 'environment_head')
    if (head.retired) same(last.reason, 'Replaced execution environment enrollment', 'environment_retirement')
  }
  // These older registries retain only request fingerprints and result IDs, not reconstructable requests.
  // Validate references and count that evidence limit explicitly; a digest is not a replacement request.
  for (const [table, column, catalog, schema] of [
    ['execution_environment_command', 'environment', environments, z.string().regex(/^[a-f0-9]{32}$/)],
    ['managed_world_command', 'world', managed, digest],
  ] as const) {
    const counts = new Map<string, number>()
    for (const row of rows(table)) {
      await checkpoint(); parse(requestId, row.id, 'registry_request'); parse(schema, row.fingerprint, 'registry_request_hash')
      if (!catalog.has(String(row[column]))) fail('reference', 'registry_command_owner')
      counts.set(String(row[column]), (counts.get(String(row[column])) ?? 0) + 1); opaqueCommandReceipts++
    }
    for (const identity of catalog.keys()) {
      await checkpoint()
      const minimum = table === 'execution_environment_command' ? envEventCounts.get(identity)! - (environments.get(identity)!.retired ? 1 : 0) : managed.get(identity)!.revision
      if ((counts.get(identity) ?? 0) < minimum) fail('reference', 'registry_command_history')
    }
  }
  for (const world of managed.values()) if (world.revoke) {
    await checkpoint(); const receipt = db.prepare('SELECT fingerprint,world FROM managed_world_command WHERE id=?').get(world.revoke.requestId)
    if (!receipt) fail('reference', 'managed_world_revoke_receipt')
    same([receipt!.world, receipt!.fingerprint], [world.id, fingerprint({ op: 'revoke', id: world.id, requestId: world.revoke.requestId,
      revision: 1, reason: world.revoke.reason })], 'managed_world_revoke_receipt')
    opaqueCommandReceipts--
  }
  function grant(value: unknown, location?: ExecutionLocation) {
    const binding = parse(executionGrant, value, 'execution_grant')
    let root: string, mode: string, current: boolean
    if (binding.world && binding.environmentId === binding.world) {
      const world = needed(managed, binding.world, 'execution_managed_world')
      same([binding.revision, binding.epoch], [1, world.epoch], 'execution_world_generation')
      root = world.root; mode = 'local'; current = world.enabled
    } else {
      const env = needed(environments, binding.environmentId, 'execution_environment')
      if (!generations.has(`${env.id}:${binding.revision}:${binding.epoch}`)) fail('authority', 'execution_generation')
      same(binding.world, env.remote?.binding, 'execution_world'); root = env.configuredRoot; mode = env.mode
      current = env.enabled && !env.retired && binding.revision === env.revision
    }
    if (location) {
      same([resolve(dirname(location.directory)), location.mode ?? 'repository'], [root, mode], 'execution_location')
      if (resolve(location.directory) === root) fail('authority', 'execution_root')
    }
    if (!current) historicalGrants++
    return binding
  }
  const tickets = new Map<string, Ticket>()
  for (const row of rows('ticket')) {
    await checkpoint(); const ticket = json(row.value, object, 'ticket') as unknown as Ticket
    same(row.id, ticket.id, 'ticket_id'); tickets.set(ticket.id, ticket)
    if (ticket.mandate.environment) grant(ticket.mandate.environment)
    const execution = ticket.execution
    if (!execution) continue
    executions++; parse(absolute, execution.directory, 'execution_directory')
    if (execution.environment) {
      same(basename(execution.directory), execution.name, 'execution_name')
      grant(execution.environment, execution)
      if (ticket.mandate.environment) same(execution.environment, ticket.mandate.environment, 'execution_mandate')
      else legacyGrants++ // Older local tickets may have been pinned after their immutable mandate was accepted.
    } else { if (ticket.mandate.environment) fail('reference', 'execution_grant'); legacyGrants++ }
    const triggerRow = db.prepare('SELECT value FROM trigger WHERE id=?').get(ticket.origin.triggerId)
    if (!triggerRow) fail('reference', 'execution_trigger')
    const trigger = json(triggerRow!.value, object, 'execution_trigger') as unknown as Trigger
    hash.update(JSON.stringify(['execution_trigger', trigger]) + '\n')
    const expected = trigger.source === 'workspace' ? trigger.meta.persona : undefined
    if (execution.persona) {
      const snapshot = parse(personaVersion, execution.persona, 'execution_persona')
      if (!expected) fail('authority', 'execution_persona_origin')
      same(snapshot, reference(expected), 'execution_persona'); personaExecutions++
    } else if (expected) fail('reference', 'execution_persona')
    if (trigger.source === 'workspace' && trigger.meta.environment) same(execution.environment?.world, trigger.meta.environment, 'execution_selected_world')
    for (const assignment of ticket.assignments) {
      await checkpoint()
      if (assignment.execution?.environment) {
        grant(assignment.execution.environment, assignment.execution)
        same(assignment.execution.environment, execution.environment, 'assignment_grant')
      } else if (assignment.execution && execution.environment) legacyGrants++
    }
  }
  for (const table of ['workspace_mission', 'workspace_plan_version', 'workspace_schedule', 'workspace_schedule_version']) {
    for (const row of rows(table)) {
      await checkpoint(); const value = json(row.value, object, 'plan_registry_reference') as { actions?: { persona?: unknown; environment?: string }[];
        plan?: { actions: { persona?: unknown; environment?: string }[] }; definition?: { plan: { actions: { persona?: unknown; environment?: string }[] } } }
      for (const action of value.actions ?? value.plan?.actions ?? value.definition?.plan.actions ?? []) {
        await checkpoint(); const template = table.startsWith('workspace_schedule')
        // Schedule admission validates a template's shape; resource selection happens only when it mints a mission.
        if (action.persona) {
          const ref = parse(PersonaRef, action.persona, 'persona_reference')
          if (template && !versions.has(`${ref.id}:${ref.version}`)) unresolvedTemplateReferences++
          else reference(ref)
        }
        if (action.environment) {
          parse(digest, action.environment, 'plan_world_reference')
          if (template && !managed.has(action.environment)) unresolvedTemplateReferences++
          else needed(managed, action.environment, 'plan_world_reference')
        }
      }
    }
  }
  const pins = new Map<string, { persona?: string; owner?: string; world?: string; router?: string }>()
  const families = [[KV.sessions.personaOwner, 'owner'], [KV.sessions.persona, 'persona'],
    [KV.sessions.world, 'world'], [KV.sessions.routerOwner, 'router']] as const
  for (const row of rows('kv')) {
    await checkpoint(); const key = String(row.key), match = families.find(([family]) => key.startsWith(family.prefix))
    if (!match) continue
    const sessionId = parse(id, key.slice(match[0].prefix.length), 'session_pin_id')
    const value = json(row.value, id, 'session_pin'), pin = pins.get(sessionId) ?? {}
    pin[match[1]] = value; pins.set(sessionId, pin)
  }
  const sessions = new Map<string, SessionHeader>()
  for (const session of context.sessions) {
    await checkpoint(); if (sessions.has(session.id)) fail('duplicate', 'session_header')
    same(session.id, session.header.id, 'session_id'); sessions.set(session.id, session.header)
    const encoded = JSON.stringify(['session_header', session]); charge(encoded, 'session_header'); hash.update(encoded + '\n')
  }
  const roots = new Map<string, string>([[context.masterId, context.masterId], ...[...tickets].map(([identity]) => [`worker-${identity}`, identity] as const)])
  const owners = new Map(roots)
  // Memoized ancestry establishes actual immutable lineage, including teams deeper than the runtime's bounded lookup.
  for (const sessionId of sessions.keys()) {
    await checkpoint(); const chain: string[] = [], seen = new Set<string>(); let cursor = sessionId
    while (!owners.has(cursor)) {
      await checkpoint(); if (seen.has(cursor)) fail('cycle', 'session_lineage'); seen.add(cursor); chain.push(cursor)
      const parent = needed(sessions, cursor, 'session_parent').parentSession
      if (!parent) fail('reference', 'session_root')
      needed(sessions, parent!, 'session_parent')
      cursor = parent!
    }
    for (const child of chain) owners.set(child, owners.get(cursor)!)
  }
  for (const sessionId of new Set([...sessions.keys(), ...pins.keys()])) {
    await checkpoint(); const header = sessions.get(sessionId), pin = pins.get(sessionId), owner = owners.get(sessionId)
    if (!owner) fail('reference', 'session_pin_owner')
    if (!header) { if (!roots.has(sessionId)) fail('reference', 'session_pin_header'); pendingPins++ }
    const ticket = owner === context.masterId ? undefined : needed(tickets, owner!, 'session_ticket')
    const persona = ticket?.execution?.persona
    if (pin?.persona) { same(pin.persona, persona?.digest ?? 'default', 'session_persona'); personaPins++ }
    else if (persona && header && roots.has(sessionId)) fail('reference', 'session_persona_pin')
    else if (header) legacySessionPins++
    if (pin?.owner) { if (!persona || !pin.persona) fail('authority', 'session_persona_owner'); same(pin.owner, ticket!.id, 'session_persona_owner') }
    else if (persona && header) {
      if (roots.has(sessionId)) fail('reference', 'session_persona_owner')
      if (pin?.persona) legacySessionPins++ // A child header can commit before its decoration/lineage anchor.
    }
    if (pin?.router) { same([pin.router, owner], [context.masterId, context.masterId], 'session_router_owner') }
    const expectedWorld = ticket?.execution?.environment?.world, recordedWorld = remotePresetBinding(header?.agentPreset)
    if (pin?.world) { parse(z.union([digest, z.literal('local')]), pin.world, 'session_world_pin'); worldPins++ }
    if (expectedWorld) {
      if (header) same(recordedWorld, expectedWorld, 'session_world_preset')
      if (pin?.world) same(pin.world, expectedWorld, 'session_world_pin')
    } else if (ticket && (recordedWorld || pin?.world && pin.world !== 'local')) fail('authority', 'local_session_world')
    if (recordedWorld) needed(originals, recordedWorld, 'session_world_journal')
    if (header && pin?.world) same(pin.world, recordedWorld ?? 'local', 'session_world_header')
    if (header && ticket?.execution && roots.has(sessionId)) {
      if (expectedWorld) same(header.cwd, ticket.execution.directory, 'session_remote_directory')
      else if (header.cwd) {
        const env = ticket.execution.environment && environments.get(ticket.execution.environment.environmentId)
        if (header.cwd !== ticket.execution.directory && (!env || header.cwd !== join(env.root, basename(ticket.execution.directory)))) fail('conflict', 'session_local_directory')
      }
    }
  }
  signal.throwIfAborted()
  return { version: 1, records, personas: personas.size, personaVersions: versions.size, personaCommands, personaReferences, unresolvedTemplateReferences,
    environments: environments.size, environmentEvents, managedWorlds: managed.size, opaqueCommandReceipts,
    executions, personaExecutions, historicalGrants, legacyGrants, sessions: sessions.size, personaPins, worldPins, pendingPins, legacySessionPins, digest: hash.digest('hex') }
}
