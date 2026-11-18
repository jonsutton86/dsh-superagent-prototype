/** Qualification through the installed Harness loader and persistence backend, after its coordinator has stopped. */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { createRecoveryKey } from '../../src/recovery/crypto.ts'
import type { CheckpointManifest } from '../../src/recovery/checkpoint.ts'
import { Store } from '../../src/app/store.ts'
import { KV } from '../../src/kv.ts'
import { OwnershipClient, type OwnershipConnection } from '../../src/ownership/client.ts'
import type { OwnershipView } from '../../src/ownership/protocol.ts'
import type { ReserveCheckpointOwnership } from '../../src/recovery/ownership.ts'
import { verifyReceiptImage } from '../../src/recovery/image.ts'
import type { AuditCheckpointReceipts } from '../../src/recovery/audit.ts'
import { privateCredential } from '../../src/environments/endpoint-files.ts'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { WorldRecord } from '../../src/remote/world-journal.ts'
import { readInstallation } from '../../src/recovery/installation.ts'
import { inside } from '../../src/remote/journal.ts'

export async function qualifyRecovery(input: { verifyInputs?: () => Promise<void>; cli: string; home: string; profile: string; directory: string; temporary: string;
  stateDir: string; sessionRoot: string; port: number; worldDirectories: string[]; worker: string; worlds: number;
  authority?: OwnershipConnection & { coordinatorId: string }; originalClaimantFile?: string;
  audit?: Pick<AuditCheckpointReceipts, 'endpoints' | 'worlds' | 'publication'>; unrecordedPublications?: string[]; expectedRecoveredRevocations?: number; expectedPublicationDestinations?: number }) {
  const root = await realpath(input.temporary), keyFile = join(root, 'recovery-key'), outputDir = join(root, 'checkpoints')
  createRecoveryKey(keyFile)
  const destination = join(root, 'restored'), importedRoot = join(root, 'imported-sessions'), patch = join(input.directory, 'recovery.json')
  let child: ChildProcess | undefined, log = '', invocation = 0
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, exited = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const run = async (mode: 'checkpoint' | 'verify' | 'stage' | 'import-sessions' | 'reserve-ownership' | 'audit-receipts' | 'prepare-receipts' | 'install', checkpoint?: string,
    reservation?: Pick<ReserveCheckpointOwnership, 'requestId' | 'epoch' | 'generation' | 'authority'>, preparation?: { requestId: string; auditId: string },
    installation?: { requestId: string; preparationId: string; target: string; launch: { port: number; sessionRoot: string } }) => {
    const receiptFile = join(root, 'maintenance-receipt-' + invocation++ + '.json')
    const config = { mode, keyFile, outputDir, stateDir: input.stateDir, worldDirectories: input.worldDirectories, checkpoint, destination, receiptFile,
      ...(reservation ? { reservation } : {}), ...(preparation ? { preparation } : {}), ...(installation ? { installation } : {}),
      ...(['audit-receipts', 'prepare-receipts', 'install'].includes(mode) ? { audit: { authority: input.authority, ...input.audit } } : {}) }
    await writeFile(patch, JSON.stringify([
      { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
      { id: 'dsh-superagent', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-persistence-jsonl', config: { root: mode === 'import-sessions' || mode === 'prepare-receipts' ? importedRoot : input.sessionRoot, compression: 'none' } },
      { insert: [{ id: 'checkpoint-qualification', name: 'dsh-superagent/recovery', config }] },
    ]), { mode: 0o600 })
    log = ''
    child = spawn(input.cli, ['--profile', input.profile, '--patch', patch, '--no-open'], {
      cwd: resolve('.'), env: { ...process.env, DSH_HOME: input.home }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
    child.stderr!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
    try {
      if (mode === 'prepare-receipts' && input.unrecordedPublications?.length) {
        await vi.waitFor(() => expect(log).toContain('Preparing receipts requires the selected complete matched audit'), { timeout: 30_000, interval: 250 })
        await expect(readFile(receiptFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        return
      }
      await vi.waitFor(async () => {
        if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('Maintenance Harness exited before completion')
        const receipt = JSON.parse(await readFile(receiptFile, 'utf8'))
        expect(receipt).toMatchObject({ version: 1, mode, executionOwnership: false })
        expect(receipt.checkpoint).toMatch(/^[a-f0-9-]{36}$/)
      }, { timeout: 30_000, interval: 250 })
    } catch {
      const safe = log.split('\n').filter(line => !/api.?key|authorization|secret|credential|token/i.test(line)).slice(-40).join('\n')
      throw new Error('Recovery qualification failed during ' + mode + ':\n' + safe)
    } finally { await stop() }
  }
  try {
    await run('checkpoint')
    const names = (await readdir(outputDir)).filter(name => !name.startsWith('.')); expect(names).toHaveLength(1)
    const checkpoint = join(outputDir, names[0]!)
    await run('verify', checkpoint); await run('stage', checkpoint)
    // Validate plugin events in the installed Harness catalog, not this test process's older/minimal registry.
    const manifest = JSON.parse(await readFile(join(destination, 'restore-manifest.json'), 'utf8')) as CheckpointManifest
    expect(manifest.sessions.some(session => session.id === input.worker && session.eventCount > 0)).toBe(true)
    expect(manifest.files.filter(file => file.kind === 'world')).toHaveLength(input.worlds)
    await run('import-sessions', checkpoint); await run('import-sessions', checkpoint)
    const store = new Store(join(destination, 'orchestrator.sqlite'))
    try { expect(store.get(KV.recovery.hold)).toMatchObject({ checkpoint: manifest.id, state: 'staged' }) } finally { store.close() }
    expect((await readdir(importedRoot)).length).toBeGreaterThan(0)
    if (input.authority) {
      const admin = new OwnershipClient(input.authority), before = await admin.call<OwnershipView>({ op: 'coordinator.inspect', id: input.authority.coordinatorId })
      expect(before.phase).toBe('vacant')
      const reservation = { requestId: randomUUID(), epoch: before.epoch, generation: before.recovery?.generation ?? 0, authority: input.authority }
      await run('reserve-ownership', checkpoint, reservation); await run('reserve-ownership', checkpoint, reservation)
      const held = new Store(join(destination, 'orchestrator.sqlite'))
      try {
        const value = held.get(KV.recovery.reservation)!
        expect(value).toMatchObject({ phase: 'reserved', request: { requestId: reservation.requestId }, recovery: { checkpoint: manifest.id, generation: 1 } })
        expect(held.get(KV.recovery.hold)?.state).toBe('staged')
        expect(JSON.stringify(value)).not.toContain(privateCredential(value.credentialFile))
        expect((await admin.call<OwnershipView>({ op: 'coordinator.inspect', id: input.authority.coordinatorId })).recovery).toEqual(value.recovery)
      } finally { held.close() }
      await expect(new OwnershipClient({ ...input.authority, credentialFile: input.originalClaimantFile! }).call({ op: 'lease.acquire',
        requestId: randomUUID(), instanceId: randomUUID(), leaseMs: 3000 })).rejects.toThrow('replaced')
      if (input.audit) {
        await run('audit-receipts', checkpoint); await run('audit-receipts', checkpoint)
        const store = new Store(join(destination, 'orchestrator.sqlite'))
        let auditId: string, administrative = 0, activeWorlds = 0, activeBindings = 0
        const revokedWorlds = new Map<string, WorldRecord>()
        try {
          const audit = store.get(KV.recovery.audit)!
          auditId = audit.id
          administrative = Number(store.db.prepare("SELECT count(*) AS n FROM operator_endpoint_command WHERE value ->> '$.phase' <> 'refused'").get()!.n)
          expect(audit).toMatchObject({ phase: 'complete', complete: true, executionOwnership: false })
          expect(audit.resources).toHaveLength(2); expect(audit.matched).toBeGreaterThan(0)
          expect(audit.resources.every(resource => resource.quiescent)).toBe(true)
          expect(audit.issues.filter(issue => issue.code !== 'unrecorded_effect')).toEqual([])
          const publications = ['workspace_publication', 'channel_publication'].flatMap(table => store.db.prepare(`SELECT id FROM ${table}`).all().map(row => String(row.id)))
          expect(publications.length).toBeGreaterThan(0)
          const originals = new Set(publications); let commands = 0
          for (const file of manifest.files.filter(file => file.kind === 'world')) {
            const world = new DatabaseSync(join(destination, file.member), { readOnly: true })
            try {
              const original = JSON.parse(String(world.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value)) as WorldRecord
              if (original.revocation) revokedWorlds.set(file.member, original)
              else { activeWorlds++; activeBindings += original.grant.credentials?.length ?? 0 }
              for (const row of world.prepare('SELECT id FROM execution_effect').all()) { originals.add(String(row.id)); commands++ }
            }
            finally { world.close() }
          }
          expect(commands).toBeGreaterThan(0)
          expect(audit.issues.filter(issue => originals.has(issue.id ?? ''))).toEqual([])
          expect(audit.issues.filter(issue => issue.kind === 'publication').map(issue => issue.id).sort()).toEqual([...(input.unrecordedPublications ?? [])].sort())
          expect(audit.status).toBe(audit.issueCount ? 'blocked' : 'matched')
          expect(store.get(KV.recovery.hold)?.state).toBe('staged')
        } finally { store.close() }
        const preparation = { requestId: randomUUID(), auditId: auditId! }
        await run('prepare-receipts', checkpoint, undefined, preparation)
        const preparedPath = join(destination, 'prepared-' + preparation.requestId)
        if (!input.unrecordedPublications?.length) {
          const image = await verifyReceiptImage(preparedPath, keyFile)
          expect(image.executionOwnership).toBe(false); expect(image.applied.commands).toBeGreaterThan(0); expect(image.applied.publications).toBeGreaterThan(0)
          expect(image.administration?.verified).toBe(administrative)
          if (input.worlds > 1) expect(administrative).toBeGreaterThan(0)
          else expect(administrative).toBe(0) // Dedicated enrollment lives in the separate operator Store.
          expect(image.revocations).toEqual({ verified: revokedWorlds.size, recovered: input.expectedRecoveredRevocations ?? 0 })
          expect(image.executionConfiguration).toEqual({ worlds: activeWorlds, bindings: activeBindings })
          expect(image.sessionBackend).toEqual({ sessions: manifest.sessions.length, events: manifest.sessions.reduce((total, session) => total + session.eventCount, 0) })
          expect(image.inferenceConfiguration).toMatchObject({ routes: 1, selections: expect.stringMatching(/^[a-f0-9]{64}$/), resolved: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.inferenceConfiguration!.sessions).toBeGreaterThan(0)
          expect(image.consumedInputs!.tickets).toBeGreaterThan(0)
          expect(image.consumedInputs!.inputs).toBeGreaterThan(0)
          expect(image.consumedInputs!.consumed).toBeGreaterThan(0)
          expect(image.stateGraph).toMatchObject({ version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.stateGraph!.triggers).toBeGreaterThan(0)
          expect(image.stateGraph!.tickets).toBeGreaterThan(0)
          expect(image.stateGraph!.assignments).toBeGreaterThanOrEqual(image.stateGraph!.tickets)
          expect(image.stateGraph!.decisions).toBeGreaterThanOrEqual(image.stateGraph!.tickets)
          const originalInputs = new DatabaseSync(join(input.stateDir, 'orchestrator.sqlite'), { readOnly: true })
          try {
            let readNonTriggers = 0
            for (const row of originalInputs.prepare('SELECT value FROM ticket').iterate()) {
              const ticket = JSON.parse(String(row.value)) as { inputs: { kind: string; readAt?: string | null }[] }
              readNonTriggers += ticket.inputs.filter(item => item.kind !== 'trigger' && item.kind !== 'reopen' && !!item.readAt).length
            }
            expect(readNonTriggers).toBeGreaterThan(0)
          } finally { originalInputs.close() }
          expect(image.sourceConfiguration).toMatchObject({ enabled: 3, configuration: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.sourceConfiguration!.kinds).toBeGreaterThanOrEqual(3)
          expect(image.connectorState).toMatchObject({ version: 1, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.connectorState!.bindings).toBeGreaterThan(0)
          expect(image.connectorState!.messages).toBeGreaterThan(0)
          expect(image.connectorState!.nativeMessages).toBe(image.connectorState!.messages)
          expect(image.connectorState!.legacyMessages).toBe(0)
          expect(image.workspaceState).toMatchObject({ version: 1, legacyPlanVersions: 0, legacyTriggers: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.workspaceState!.missions).toBeGreaterThan(0)
          if (input.worlds > 1) {
            expect(image.workspaceState!.schedules).toBeGreaterThan(0)
            expect(image.workspaceState!.scheduledExecutions).toBeGreaterThan(0)
          } else expect(image.workspaceState!.scheduledExecutions).toBe(0)
          expect(image.resultState).toMatchObject({ version: 1, legacyReviewSeals: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.resultState!.artifacts).toBeGreaterThan(0)
          expect(image.resultState!.successfulRuns).toBeGreaterThan(0)
          expect(image.resultState!.reviews).toBeGreaterThan(0)
          expect(image.resultState!.completions).toBeGreaterThan(0)
          expect(image.registryState).toMatchObject({ version: 1, legacyGrants: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.registryState!.personas).toBeGreaterThan(0)
          expect(image.registryState!.personaVersions).toBeGreaterThan(1)
          expect(image.registryState!.personaExecutions).toBeGreaterThan(0)
          expect(image.registryState!.environments + image.registryState!.managedWorlds).toBeGreaterThan(0)
          if (revokedWorlds.size) expect(image.registryState!.historicalGrants).toBeGreaterThan(0)
          expect(image.contextState).toMatchObject({ version: 1, legacySnapshots: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.contextState!.recallAttempts).toBeGreaterThan(0)
          if (input.worlds > 1) {
            expect(image.contextState!.reflectionRuns).toBeGreaterThan(0)
            expect(image.contextState!.proposals).toBeGreaterThan(0)
            expect(image.contextState!.readCalls).toBeGreaterThan(0)
          }
          expect(image.budgetState).toMatchObject({ version: 1, legacyAssignments: 0, missingSessionHeaders: 0, legacyPolicies: 0, legacyCommands: 0,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.budgetState!.calls).toBeGreaterThan(0)
          expect(image.budgetState!.tokens).toBeGreaterThan(0)
          expect(image.publicationState).toMatchObject({ version: 1, unresolved: 0, missingOutbox: 0, legacyApprovals: 0,
            legacyDestinations: 0, legacyGrantRequests: 0, legacyPlanBindings: 0, legacyReviewSeals: 0, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
          expect(image.publicationState!.checkedArtifacts).toBeGreaterThan(0)
          expect(image.publicationState!.seals).toBeGreaterThan(0)
          expect(image.publicationState!.deliveryGrants).toBeGreaterThan(0)
          expect(image.publicationState!.deliveries).toBeGreaterThan(0)
          expect(image.publicationState!.sent).toBeGreaterThan(0)
          expect(image.controlConfiguration).toEqual({ claimant: true, publication: true, destinations: input.expectedPublicationDestinations ?? 1 })
          expect(activeWorlds).toBeGreaterThan(0); expect(activeBindings).toBeGreaterThan(0)
          for (const [member, original] of revokedWorlds) {
            const world = new DatabaseSync(join(preparedPath, member), { readOnly: true })
            try {
              expect(JSON.parse(String(world.prepare('SELECT value FROM execution_world WHERE id=1').get()!.value))).toEqual({ ...original,
                phase: 'revoked', revocation: { ...original.revocation, receipt: { grantId: original.grant.id, epoch: original.grant.epoch, at: expect.any(String), quiescent: true } } })
            } finally { world.close() }
          }
          expect(image.files.filter(file => file.kind === 'world')).toHaveLength(input.worlds)
          expect(image.files.filter(file => file.kind === 'session')).toHaveLength(manifest.sessions.length)
          await run('prepare-receipts', checkpoint, undefined, preparation)
          expect(await verifyReceiptImage(preparedPath, keyFile)).toEqual(image)
          const prepared = new DatabaseSync(join(preparedPath, 'orchestrator.sqlite'), { readOnly: true })
          try {
            expect(JSON.parse(String(prepared.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)!.value))).toMatchObject({ state: 'prepared', requestId: preparation.requestId })
            for (const row of prepared.prepare('SELECT value FROM channel_publication').all()) expect(JSON.parse(String(row.value))).toMatchObject({ phase: 'observed', receipt: { phase: 'sent' } })
            for (const row of prepared.prepare('SELECT value FROM operator_endpoint_command').all()) {
              const command = JSON.parse(String(row.value))
              expect(['done', 'superseded']).toContain(command.phase)
              expect(command.recovery).toMatchObject({ originalPhase: 'done', requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
            }
          } finally { prepared.close() }
          const installation = { requestId: randomUUID(), preparationId: preparation.requestId, target: join(root, 'installed'), launch: { port: input.port, sessionRoot: importedRoot } }
          await run('install', checkpoint, undefined, undefined, installation)
          await run('install', checkpoint, undefined, undefined, installation)
          const installed = await readInstallation(installation.target, keyFile, new AbortController().signal)
          expect(installed.launch).toMatchObject(installation.launch)
          const launchPatch = join(installed.root, 'harness.patch.json'), originalPatch = await readFile(launchPatch, 'utf8')
          // The replacement must run without its predecessor's Store, Session files or journals. Independent services
          // and the explicitly selected inference provider remain separate deployments, with their existing configuration.
          const oldRoots = [...new Set([input.stateDir, input.sessionRoot, ...input.worldDirectories])]
          for (const directory of oldRoots.filter(path => !oldRoots.some(other => other !== path && inside(other, path))))
            await rename(directory, directory + '-retired-' + randomUUID())
          const api = async (path: string, body?: unknown) => {
            const response = await fetch(`http://127.0.0.1:${input.port}/orchestrator/api/${path}`, { method: body ? 'POST' : 'GET',
              headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) })
            if (!response.ok) throw new Error(`Restored Runtime HTTP ${response.status} at ${path}`)
            return await response.json() as any
          }
          const start = async () => {
            expect(await readFile(launchPatch, 'utf8')).toBe(originalPatch); log = ''
            child = spawn(input.cli, ['--profile', input.profile, '--patch', launchPatch, '--no-open'], { cwd: resolve('.'), env: { ...process.env, DSH_HOME: input.home }, stdio: ['ignore', 'pipe', 'pipe'] })
            child.stdout!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
            child.stderr!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
            try {
              await vi.waitFor(async () => {
                const state = await api('state')
                expect(state.health.runtime.state, state.health.runtime.detail).toBe('ready')
                expect(state.ownership.phase).toBe('active'); expect(state.environment.ready).toBe(true)
              }, { timeout: 45_000, interval: 250 })
            } catch (error) {
              throw new Error('Restored startup failed: ' + String(error) + '\n' + log.split('\n').filter(line => !/api.?key|authorization|secret|credential|token/i.test(line)).slice(-50).join('\n'))
            }
          }
          await start()
          await input.verifyInputs?.()
          const available = (await api('worlds')).items.find((item: any) => item.enabled && item.ready)
          let mission = await api('missions', { requestId: 'restored-mission', title: 'Restored execution proof', objective: 'Execute through the restored Harness world', acceptance: 'Verified artifact' })
          mission = await api(`missions/${mission.id}/actions`, { requestId: 'restored-action', revision: mission.revision, title: 'Write recovery proof', owner: 'agent',
            ...(available ? { environment: available.id } : {}), instructions: 'Use bash in your assigned directory to write exactly recovery-complete to restored.txt with no newline. Read the file back and publish that exact content with workspace_publish as an artifact, then report ready. Do not use external services or background work.' })
          const running = await api(`missions/${mission.id}/actions/${mission.actions[0].id}`, { requestId: 'restored-run', revision: mission.revision, command: 'run' })
          const task = running.actions[0].ticket.id
          await vi.waitFor(async () => expect((await api(`inbox/${task}`)).item.status).toBe('review'), { timeout: 90_000, interval: 500 })
          const conversation = await api(`inbox/${task}`)
          const artifacts = await Promise.all(conversation.artifacts.map((item: { id: string }) => api(`library/${item.id}`)))
          expect(artifacts.some((item: any) => item.content === 'recovery-complete')).toBe(true)
          const active = new DatabaseSync(join(installed.stateDir, 'orchestrator.sqlite'), { readOnly: true })
          try { expect(active.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)).toBeUndefined(); expect(active.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.activation)).toBeDefined() }
          finally { active.close() }
          await stop(); await start()
          expect((await api(`missions/${mission.id}`)).actions[0].ticket.id).toBe(task)
          expect((await api(`inbox/${task}`)).item.status).toBe('review')
          await stop()
        } else expect((await readdir(destination)).some(name => name.startsWith('prepared-'))).toBe(false)
      }
    }
  } finally { await stop() }
}
