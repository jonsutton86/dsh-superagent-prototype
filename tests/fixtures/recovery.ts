/** Qualification through the installed Harness loader and persistence backend, after its coordinator has stopped. */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { createRecoveryKey } from '../../src/recovery/crypto.ts'
import type { CheckpointManifest } from '../../src/recovery/checkpoint.ts'
import { Store } from '../../src/app/store.ts'
import { KV } from '../../src/kv.ts'
import { OwnershipClient, type OwnershipConnection } from '../../src/ownership/client.ts'
import type { OwnershipView } from '../../src/ownership/protocol.ts'
import type { ReserveCheckpointOwnership } from '../../src/recovery/ownership.ts'
import type { AuditCheckpointReceipts } from '../../src/recovery/audit.ts'
import { privateCredential } from '../../src/environments/endpoint-files.ts'
import { randomUUID } from 'node:crypto'

export async function qualifyRecovery(input: { cli: string; home: string; profile: string; directory: string; temporary: string;
  stateDir: string; sessionRoot: string; port: number; worldDirectories: string[]; worker: string; worlds: number;
  authority?: OwnershipConnection & { coordinatorId: string }; originalClaimantFile?: string;
  audit?: Pick<AuditCheckpointReceipts, 'endpoints' | 'publication'> }) {
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
  const run = async (mode: 'checkpoint' | 'verify' | 'stage' | 'import-sessions' | 'reserve-ownership' | 'audit-receipts', checkpoint?: string,
    reservation?: Pick<ReserveCheckpointOwnership, 'requestId' | 'epoch' | 'generation' | 'authority'>) => {
    const receiptFile = join(root, 'maintenance-receipt-' + invocation++ + '.json')
    const config = { mode, keyFile, outputDir, stateDir: input.stateDir, worldDirectories: input.worldDirectories, checkpoint, destination, receiptFile,
      ...(reservation ? { reservation } : {}), ...(mode === 'audit-receipts' ? { audit: { authority: input.authority, ...input.audit } } : {}) }
    await writeFile(patch, JSON.stringify([
      { id: 'webserver', config: { host: '127.0.0.1', port: input.port } },
      { id: 'dsh-superagent', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'session-persistence-jsonl', config: { root: mode === 'import-sessions' ? importedRoot : input.sessionRoot, compression: 'none' } },
      { insert: [{ id: 'checkpoint-qualification', name: 'dsh-superagent/recovery', config }] },
    ]), { mode: 0o600 })
    log = ''
    child = spawn(input.cli, ['--profile', input.profile, '--patch', patch, '--no-open'], {
      cwd: resolve('.'), env: { ...process.env, DSH_HOME: input.home }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
    child.stderr!.on('data', bytes => { log = (log + bytes.toString()).slice(-100_000) })
    try {
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
        try {
          const audit = store.get(KV.recovery.audit)!
          expect(audit).toMatchObject({ phase: 'complete', complete: true, executionOwnership: false })
          expect(audit.resources).toHaveLength(2); expect(audit.matched).toBeGreaterThan(0)
          expect(audit.issues.filter(issue => issue.code !== 'unrecorded_effect')).toEqual([])
          expect(audit.status).toBe(audit.issueCount ? 'blocked' : 'matched')
          expect(store.get(KV.recovery.hold)?.state).toBe('staged')
        } finally { store.close() }
      }
    }
  } finally { await stop() }
}
