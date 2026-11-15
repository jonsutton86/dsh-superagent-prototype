import { exportEndpointStorageSnapshot } from '../src/recovery/endpoint-snapshot.ts'
import { lockSync } from 'proper-lockfile'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { createCheckpoint, verifyCheckpoint, stageCheckpoint } from '../src/recovery/checkpoint.ts'
import { ReceiptImage, sealReceiptImage, verifyReceiptImage, requireInstallableStorageImage } from '../src/recovery/image.ts'
import { createRecoveryKey, recoveryKey, seal, unseal } from '../src/recovery/crypto.ts'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditStorageRecoveryArtifacts } from '../src/recovery/storage-artifacts.ts'
import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { auditStorageRecoveryBindings, readEndpointStorageSnapshot, readHostStorageSnapshot } from '../src/recovery/storage.ts'

function fixture() {
  const endpointId = '11111111-1111-4111-8111-111111111111'
  const policy = { kind: 'linux-xfs-project', filesystemUUID: '22222222-2222-4222-8222-222222222222', mountRoot: '/srv/quota',
    projectIds: { first: 100, last: 109 }, pool: { bytes: 8192, inodes: 20 }, workspace: { bytes: 4096, inodes: 10 } }
  const intent = { endpointId, requestId: 'original', requestHash: 'a'.repeat(64), workspace: 'work', projectId: 100 }
  const roots = ['workspaces', 'verification'].map((name, i) => ({ path: `/srv/quota/dsh-${endpointId}/${name}/work`, device: '1', inode: String(i + 10),
    projectId: 100, inherits: true, realtime: false }))
  const reservation = { ...intent, phase: 'provisioned', createdAt: '2026-11-15T00:00:00.000Z', observation: {
    mountId: 1, filesystemUUID: policy.filesystemUUID, mountRoot: policy.mountRoot, projectId: 100, directories: roots,
    quota: { accounting: true, enforcement: true, usedBytes: 0, hardBytes: 4096, usedInodes: 2, hardInodes: 10 }, observedAt: '2026-11-15T00:00:00.000Z' } }
  const grant = { id: '33333333-3333-4333-8333-333333333333', owner: 'coordinator', workspace: 'work', root: roots[0]!.path,
    rootIdentity: '1:10:12345', operations: ['fs.read'], revision: 1, epoch: 1, enabled: true, leaseUntil: 1, createdAt: '', updatedAt: '' }
  return { endpoint: { endpointId, policy, reservations: [reservation], grants: [grant] },
    host: { endpointId, policy: structuredClone(policy), operations: [{ intent, roots: roots.map(({ device, inode }) => ({ device, inode })) }] } }
}

it('matches retained allocations and grant roots without claiming live enforcement or restore readiness', () => {
  const value = fixture(), before = structuredClone(value)
  expect(auditStorageRecoveryBindings(value.endpoint, value.host)).toMatchObject({ allocations: 1, provisioned: 1, recordBindingsVerified: true,
    liveFilesystemVerified: false, restoreVerified: false })
  expect(value).toEqual(before)
})

it.each(['request', 'project', 'policy', 'identity', 'missing', 'extra', 'grant', 'quota', 'duplicate'])(
  'refuses a mismatched %s binding', kind => {
    const { endpoint, host } = fixture()
    if (kind === 'request') host.operations[0]!.intent.requestHash = 'b'.repeat(64)
    if (kind === 'project') host.operations[0]!.intent.projectId++
    if (kind === 'policy') host.policy.workspace.inodes--
    if (kind === 'identity') host.operations[0]!.roots[0]!.inode = '99'
    if (kind === 'missing') host.operations = []
    if (kind === 'extra') host.operations.push({ ...structuredClone(host.operations[0]!), intent: { ...host.operations[0]!.intent, workspace: 'other', requestId: 'other', projectId: 101 } })
    if (kind === 'grant') endpoint.grants[0]!.rootIdentity = '1:99:12345'
    if (kind === 'quota') endpoint.reservations[0]!.observation.quota.hardBytes = 8192
    if (kind === 'duplicate') endpoint.reservations.push(structuredClone(endpoint.reservations[0]!))
    expect(() => auditStorageRecoveryBindings(endpoint, host)).toThrow()
  })

it('retains the provisioning-before-host-intent gap without inventing an allocation or success', () => {
  const { endpoint, host } = fixture()
  const { observation: _, ...pending } = endpoint.reservations[0]!
  const captured = { ...endpoint, grants: [], reservations: [{ ...pending, phase: 'provisioning' }] }
  expect(auditStorageRecoveryBindings(captured, { ...host, operations: [] })).toMatchObject({ provisioning: 1, hostMissing: 1, restoreVerified: false })
  expect(auditStorageRecoveryBindings({ ...captured, reservations: [{ ...pending, phase: 'reserved' }] }, { ...host, operations: [] })).toMatchObject({ reserved: 1 })
  expect(() => auditStorageRecoveryBindings({ ...captured, reservations: [{ ...pending, phase: 'reserved' }] }, host)).toThrow()
})


function databases() {
  const value = fixture(), endpoint = new DatabaseSync(':memory:'), host = new DatabaseSync(':memory:')
  endpoint.exec('CREATE TABLE endpoint_meta(key,value); CREATE TABLE remote_storage(workspace,request_id,project_id,value); CREATE TABLE remote_grant(id,value);')
  endpoint.prepare('INSERT INTO endpoint_meta VALUES(?,?)').run('id', value.endpoint.endpointId)
  endpoint.prepare('INSERT INTO endpoint_meta VALUES(?,?)').run('storage-policy', JSON.stringify(value.endpoint.policy))
  const reservation = value.endpoint.reservations[0]!, grant = value.endpoint.grants[0]!, operation = value.host.operations[0]!
  endpoint.prepare('INSERT INTO remote_storage VALUES(?,?,?,?)').run(reservation.workspace, reservation.requestId, reservation.projectId, JSON.stringify(reservation))
  endpoint.prepare('INSERT INTO remote_grant VALUES(?,?)').run(grant.id, JSON.stringify(grant))
  host.exec('CREATE TABLE endpoints(id,filesystem,first,last,config); CREATE TABLE namespaces(endpoint,identities); CREATE TABLE operations(endpoint,request,workspace,filesystem,project,intent,roots); CREATE TABLE repairs(endpoint,id,request,intent,phase);')
  host.prepare('INSERT INTO endpoints VALUES(?,?,?,?,?)').run(value.host.endpointId, value.host.policy.filesystemUUID, 100, 109,
    JSON.stringify({ endpointId: value.host.endpointId, uid: 1001, gid: 1001, policy: value.host.policy }))
  host.prepare('INSERT INTO namespaces VALUES(?,?)').run(value.host.endpointId, JSON.stringify([1, 2, 3].map(inode => ({ device: '1', inode: String(inode) }))))
  host.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(value.host.endpointId, operation.intent.requestId, operation.intent.workspace,
    value.host.policy.filesystemUUID, operation.intent.projectId, JSON.stringify(operation.intent), JSON.stringify(operation.roots))
  return { value, endpoint, host, close() { endpoint.close(); host.close() } }
}

it('reads original SQLite rows without initializing services or changing the captured journals', async () => {
  const db = databases(), signal = new AbortController().signal
  try {
    const before = [db.endpoint, db.host].map(value => value.prepare('SELECT total_changes() AS changes').get())
    const endpoint = await readEndpointStorageSnapshot(db.endpoint, signal), host = await readHostStorageSnapshot(db.host, db.value.host.endpointId, signal)
    expect(endpoint.snapshot).toEqual(db.value.endpoint); expect(host.snapshot).toEqual(db.value.host)
    expect(auditStorageRecoveryBindings(endpoint.snapshot, host.snapshot)).toMatchObject({ provisioned: 1, restoreVerified: false })
    expect(endpoint.digest).toMatch(/^[a-f0-9]{64}$/); expect(host.digest).toMatch(/^[a-f0-9]{64}$/)
    expect([db.endpoint, db.host].map(value => value.prepare('SELECT total_changes() AS changes').get())).toEqual(before)
    db.host.prepare('INSERT INTO repairs VALUES(?,?,?,?,?)').run(db.value.host.endpointId, 'repair', 'original', JSON.stringify({ request: db.value.host.operations[0]!.intent, snapshotHash: 'a'.repeat(64) }), 'started')
    expect((await readHostStorageSnapshot(db.host, db.value.host.endpointId, signal)).digest).not.toBe(host.digest)
  } finally { db.close() }
})

it.each(['reservation', 'grant', 'operation', 'configuration', 'missing'])('refuses inconsistent persisted %s row keys', async kind => {
  const db = databases(), signal = new AbortController().signal
  try {
    if (kind === 'reservation') db.endpoint.exec("UPDATE remote_storage SET request_id='different'")
    if (kind === 'grant') db.endpoint.exec("UPDATE remote_grant SET id='different'")
    if (kind === 'operation') db.host.exec("UPDATE operations SET request='different'")
    if (kind === 'configuration') db.host.exec('UPDATE endpoints SET first=101')
    if (kind === 'missing') db.endpoint.exec('DROP TABLE remote_storage')
    if (['operation', 'configuration'].includes(kind)) await expect(readHostStorageSnapshot(db.host, db.value.host.endpointId, signal)).rejects.toThrow('recovery_host_storage_')
    else await expect(readEndpointStorageSnapshot(db.endpoint, signal)).rejects.toThrow('recovery_endpoint_storage_')
  } finally { db.close() }
})

it('honors cancellation before reading either database', async () => {
  const db = databases()
  try {
    await expect(readEndpointStorageSnapshot(db.endpoint, AbortSignal.abort())).rejects.toThrow()
    await expect(readHostStorageSnapshot(db.host, db.value.host.endpointId, AbortSignal.abort())).rejects.toThrow()
  } finally { db.close() }
})


it('verifies expected artifact bytes before reading isolated SQLite copies', async () => {
  const db = databases(), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-storage-artifact-test-')))
  try {
    const capture = async (source: DatabaseSync, name: string) => {
      const path = join(directory, name)
      source.prepare('VACUUM INTO ?').run(path); await chmod(path, 0o600)
      const bytes = await readFile(path)
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const endpoint = await capture(db.endpoint, 'endpoint.sqlite'), host = await capture(db.host, 'host.sqlite')
    const input = { endpointId: db.value.endpoint.endpointId, endpoint, host }, signal = new AbortController().signal
    const result = await auditStorageRecoveryArtifacts(input, signal)
    expect(result).toMatchObject({ recordBindingsVerified: true, restoreVerified: false, liveFilesystemVerified: false,
      hostRegistryAudit: { recordBindingsVerified: true, restoreVerified: false }, endpointArtifact: { sha256: endpoint.sha256 }, hostArtifact: { sha256: host.sha256 } })
    expect(createHash('sha256').update(await readFile(endpoint.path)).digest('hex')).toBe(endpoint.sha256)
    await expect(auditStorageRecoveryArtifacts({ ...input, host: { ...host, sha256: 'f'.repeat(64) } }, signal)).rejects.toThrow('digest')
    await expect(auditStorageRecoveryArtifacts({ ...input, endpoint: { ...endpoint, bytes: endpoint.bytes - 1 } }, signal)).rejects.toThrow('size')
    await expect(auditStorageRecoveryArtifacts(input, AbortSignal.abort())).rejects.toThrow()
    const image = join(directory, 'image'), keyFile = join(directory, 'recovery.key')
    await mkdir(image, { mode: 0o700 }); createRecoveryKey(keyFile)
    await copyFile(endpoint.path, join(image, 'endpoint.bin')); await copyFile(host.path, join(image, 'host.bin'))
    await writeFile(join(image, 'orchestrator.sqlite'), 'held', { mode: 0o600 })
    const checkpoint = randomUUID(), manifest = ReceiptImage.parse({ version: 1, requestId: randomUUID(), requestHash: 'a'.repeat(64),
      checkpoint, digest: 'b'.repeat(64), auditId: randomUUID(), at: new Date().toISOString(),
      recovery: { checkpoint, digest: 'b'.repeat(64), generation: 1 }, epoch: 0, executionOwnership: false,
      resources: [{ identity: { id: input.endpointId, kind: 'endpoint', authorityId: randomUUID(), coordinatorId: 'coordinator', resourceId: 'endpoint' },
        revision: 'c'.repeat(32), total: 1, quiescent: true }], applied: { commands: 0, mutations: 0, publications: 0 },
      files: [{ member: 'orchestrator.sqlite', kind: 'store', bytes: 4, sha256: createHash('sha256').update('held').digest('hex') },
        { member: 'endpoint.bin', kind: 'storage-endpoint', bytes: endpoint.bytes, sha256: endpoint.sha256 },
        { member: 'host.bin', kind: 'storage-host', bytes: host.bytes, sha256: host.sha256 }],
      storage: [{ endpointId: input.endpointId, endpointMember: 'endpoint.bin', hostMember: 'host.bin' }] })
    const key = recoveryKey(keyFile)
    try {
      const signed = sealReceiptImage(manifest, key)
      await writeFile(join(image, 'prepared.json'), signed, { mode: 0o600 })
      expect(await verifyReceiptImage(image, keyFile, signal)).toEqual(manifest)
      expect(() => requireInstallableStorageImage(manifest)).toThrow('fencing and restore integration')
      expect(() => sealReceiptImage({ ...manifest, storage: undefined }, key)).toThrow('unbound storage')
      const tampered = JSON.parse(signed); tampered.manifest.storage[0].endpointId = randomUUID()
      await writeFile(join(image, 'prepared.json'), JSON.stringify(tampered))
      await expect(verifyReceiptImage(image, keyFile, signal)).rejects.toThrow('authentication failed')
    } finally { key.fill(0) }
    const walHeader = await readFile(endpoint.path); walHeader[18] = 2; walHeader[19] = 2
    await writeFile(endpoint.path, walHeader)
    const walInput = { ...input, endpoint: { ...endpoint, sha256: createHash('sha256').update(walHeader).digest('hex') } }
    await expect(auditStorageRecoveryArtifacts(walInput, signal)).rejects.toThrow('standalone SQLite')
    walHeader[18] = 1; walHeader[19] = 1; await writeFile(endpoint.path, walHeader)
    await chmod(host.path, 0o644)
    await expect(auditStorageRecoveryArtifacts(input, signal)).rejects.toThrow('private owned')
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})

it.each(['orphan-repair', 'changed-repair', 'duplicate-repair', 'overlap', 'unrelated-config', 'partial-namespace', 'capacity', 'unknown-schema'])(
  'audits the whole shared host registry and rejects %s', async kind => {
    const db = databases(), id = db.value.host.endpointId, operation = db.value.host.operations[0]!
    try {
      if (kind.includes('repair')) {
        const request = kind === 'changed-repair' ? { ...operation.intent, requestHash: 'f'.repeat(64) } : operation.intent
        db.host.prepare('INSERT INTO repairs VALUES(?,?,?,?,?)').run(id, 'repair', kind === 'orphan-repair' ? 'missing' : 'original',
          JSON.stringify({ request, snapshotHash: 'a'.repeat(64) }), 'started')
        if (kind === 'duplicate-repair') db.host.exec('INSERT INTO repairs SELECT * FROM repairs')
      }
      if (kind === 'overlap' || kind === 'unrelated-config') {
        const otherId = '44444444-4444-4444-8444-444444444444'
        const policy = structuredClone(db.value.host.policy)
        if (kind === 'unrelated-config') policy.projectIds = { first: 200, last: 209 }
        db.host.prepare('INSERT INTO endpoints VALUES(?,?,?,?,?)').run(otherId, policy.filesystemUUID, policy.projectIds.first, policy.projectIds.last,
          JSON.stringify({ endpointId: otherId, uid: kind === 'unrelated-config' ? 0 : 1002, gid: 1002, policy }))
      }
      if (kind === 'unknown-schema') db.host.exec('CREATE TABLE unknown_authority(value)')
      if (kind === 'partial-namespace') db.host.exec("UPDATE namespaces SET identities='[null,null,null]'")
      if (kind === 'capacity') for (let i = 1; i <= 2; i++) {
        const intent = { ...operation.intent, requestId: `extra-${i}`, workspace: `extra-${i}`, projectId: 100 + i }
        db.host.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(id, intent.requestId, intent.workspace, db.value.host.policy.filesystemUUID,
          intent.projectId, JSON.stringify(intent), JSON.stringify(operation.roots))
      }
      await expect(readHostStorageSnapshot(db.host, id, new AbortController().signal)).rejects.toThrow('recovery_host_storage_')
    } finally { db.close() }
  })


it('retains an uninitialized namespace when no host operation has been admitted', async () => {
  const db = databases()
  try {
    db.host.exec("DELETE FROM operations; UPDATE namespaces SET identities='[null,null,null]'")
    const result = await readHostStorageSnapshot(db.host, db.value.host.endpointId, new AbortController().signal)
    expect(result.audit).toMatchObject({ allocations: 0, incompleteNamespaces: 1, restoreVerified: false })
  } finally { db.close() }
})


it('captures verified storage pairs in an encrypted checkpoint and preserves their bindings in held staging', async () => {
  const db = databases(), ctx = new Context(), directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-storage-checkpoint-test-')))
  try {
    const stateDir = join(directory, 'state'), outputDir = join(directory, 'backups'), keyFile = join(directory, 'key')
    await mkdir(stateDir, { mode: 0o700 }); createRecoveryKey(keyFile)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.set(KV.runtime.masterId, 'storage-master')
    store.db.exec('CREATE TABLE IF NOT EXISTS operator_endpoint(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO operator_endpoint VALUES(?,?)').run(db.value.endpoint.endpointId,
      JSON.stringify({ id: db.value.endpoint.endpointId, credentialFile: keyFile }))
    store.close()
    await ctx.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
    const writer = await ctx.sessionPersistence.create(Session.create(SessionId('storage-master')).header)
    await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append',
      data: { role: 'user', id: MessageId('storage-message'), source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Storage checkpoint fixture' }] } }])
    await writer.close()
    const capture = async (source: DatabaseSync, name: string) => {
      const path = join(directory, name); source.prepare('VACUUM INTO ?').run(path); await chmod(path, 0o600)
      const bytes = await readFile(path)
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const pair = { endpointId: db.value.endpoint.endpointId, endpoint: await capture(db.endpoint, 'endpoint.sqlite'), host: await capture(db.host, 'host.sqlite') }
    const options = { stateDir, outputDir, keyFile, persistence: ctx.sessionPersistence, storageArtifacts: [pair] }
    const checkpoint = await createCheckpoint(options)
    expect(checkpoint.manifest.storage).toHaveLength(1)
    expect(checkpoint.manifest.files.filter(file => file.kind.startsWith('storage-'))).toHaveLength(2)
    expect(await verifyCheckpoint(checkpoint.path, keyFile)).toEqual(checkpoint.manifest)
    const target = join(directory, 'held'); await stageCheckpoint(checkpoint.path, keyFile, target)
    const restored = new DatabaseSync(join(target, 'orchestrator.sqlite'), { readOnly: true })
    try { expect(restored.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)).toBeTruthy() } finally { restored.close() }
    await expect(createCheckpoint({ ...options, storageArtifacts: [{ ...pair, host: { ...pair.host, sha256: 'f'.repeat(64) } }] })).rejects.toThrow('digest')
    await expect(createCheckpoint({ ...options, storageArtifacts: [pair, pair] })).rejects.toThrow('unique original registered endpoint')
    // Authentication alone is insufficient: a validly sealed archive must retain source ownership references.
    const key = recoveryKey(keyFile), signal = new AbortController().signal
    try {
      const manifest = structuredClone(checkpoint.manifest), storeMember = manifest.files.find(file => file.kind === 'store')!
      const plain = join(directory, 'altered-store.sqlite')
      await unseal(join(checkpoint.path, storeMember.member), plain, key, manifest.id, storeMember, signal)
      const altered = new DatabaseSync(plain)
      try { altered.exec('DELETE FROM operator_endpoint; PRAGMA wal_checkpoint(TRUNCATE)') } finally { altered.close() }
      await rm(join(checkpoint.path, storeMember.member))
      Object.assign(storeMember, await seal(plain, join(checkpoint.path, storeMember.member), key, manifest.id, storeMember.member, signal))
      const manifestPath = join(directory, 'altered-manifest.json')
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
      await rm(join(checkpoint.path, 'manifest.bin'))
      const sealed = await seal(manifestPath, join(checkpoint.path, 'manifest.bin'), key, manifest.id, 'manifest.bin', signal)
      await writeFile(join(checkpoint.path, 'checkpoint.json'), JSON.stringify({ version: 1, id: manifest.id, manifest: sealed }), { mode: 0o600 })
      await expect(verifyCheckpoint(checkpoint.path, keyFile)).rejects.toThrow('absent from the original coordinator')
      await expect(stageCheckpoint(checkpoint.path, keyFile, join(directory, 'rejected-stage'))).rejects.toThrow('absent from the original coordinator')
    } finally { key.fill(0) }

  } finally { db.close(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})


it('exports endpoint storage under its writer lock without initializing or altering source records', async () => {
  const db = databases(), directory = await realpath(await mkdtemp(join(tmpdir(), 'endpoint-storage-export-')))
  try {
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 })
    const source = join(state, 'endpoint.sqlite'); db.endpoint.prepare('VACUUM INTO ?').run(source); await chmod(source, 0o600)
    const before = await readFile(source), target = join(directory, 'snapshot')
    const release = lockSync(state)
    try { await expect(exportEndpointStorageSnapshot(state, target)).rejects.toThrow() } finally { release() }
    const receipt = await exportEndpointStorageSnapshot(state, target)
    expect(receipt).toMatchObject({ endpointId: db.value.endpoint.endpointId, writerLockHeld: true, executionQuiescenceVerified: false,
      workspaceFilesIncluded: false, hostRegistryIncluded: false, restoreVerified: false })
    expect(await readFile(source)).toEqual(before)
    const artifact = await readFile(receipt.endpoint.path)
    expect(artifact[18]).toBe(1); expect(artifact[19]).toBe(1)
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(receipt.endpoint.sha256)
    expect(JSON.parse(await readFile(join(target, 'snapshot.json'), 'utf8'))).toEqual(receipt)
    await expect(exportEndpointStorageSnapshot(state, target)).rejects.toThrow()
    await expect(exportEndpointStorageSnapshot(state, join(state, 'nested'))).rejects.toThrow('separate')
    await expect(exportEndpointStorageSnapshot(state, join(directory, 'cancelled'), AbortSignal.abort())).rejects.toThrow()
    expect(await readFile(source)).toEqual(before)
  } finally { db.close(); await rm(directory, { recursive: true, force: true }) }
})


it('includes committed WAL records and retains uncertain operations without replaying them', async () => {
  const fixture = databases(), directory = await realpath(await mkdtemp(join(tmpdir(), 'endpoint-storage-wal-')))
  let source: DatabaseSync | undefined
  try {
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 })
    const path = join(state, 'endpoint.sqlite'); fixture.endpoint.prepare('VACUUM INTO ?').run(path); await chmod(path, 0o600)
    source = new DatabaseSync(path)
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE remote_operation(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
    const operation = JSON.stringify({ id: 'original-operation', phase: 'unknown', error: 'Response lost; effect unsettled' })
    source.prepare('INSERT INTO remote_operation VALUES(?,?)').run('original-operation', operation)
    const before = source.prepare('SELECT * FROM remote_storage').all()
    const receipt = await exportEndpointStorageSnapshot(state, join(directory, 'snapshot'))
    const copy = new DatabaseSync(receipt.endpoint.path, { readOnly: true })
    try {
      expect(copy.prepare('SELECT value FROM remote_operation WHERE id=?').get('original-operation')?.value).toBe(operation)
      expect(copy.prepare('SELECT * FROM remote_storage').all()).toEqual(before)
    } finally { copy.close() }
    expect(source.prepare('SELECT value FROM remote_operation WHERE id=?').get('original-operation')?.value).toBe(operation)
    expect(source.prepare('SELECT * FROM remote_storage').all()).toEqual(before)
    expect(receipt.executionQuiescenceVerified).toBe(false)
  } finally { source?.close(); fixture.close(); await rm(directory, { recursive: true, force: true }) }
})

it('retains a failed snapshot without a success receipt and releases the source lock', async () => {
  const fixture = databases(), directory = await realpath(await mkdtemp(join(tmpdir(), 'endpoint-storage-failed-')))
  try {
    const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 })
    const path = join(state, 'endpoint.sqlite'); fixture.endpoint.prepare('VACUUM INTO ?').run(path); await chmod(path, 0o600)
    const source = new DatabaseSync(path)
    try { source.exec("DELETE FROM endpoint_meta WHERE key='storage-policy'") } finally { source.close() }
    const target = join(directory, 'failed'), before = await readFile(path)
    await expect(exportEndpointStorageSnapshot(state, target)).rejects.toThrow('storage_configuration')
    await expect(readFile(join(target, 'snapshot.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(target, 'endpoint.sqlite'))).toBeTruthy()
    expect(await readFile(path)).toEqual(before)
    const release = lockSync(state); release()
    await expect(exportEndpointStorageSnapshot(state, target)).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { fixture.close(); await rm(directory, { recursive: true, force: true }) }
})

it.runIf(!!process.env.DSH_STORAGE_CAPTURE_PAIR)('captures a live endpoint pair in a verified encrypted checkpoint with held staging', async () => {
  const pair = JSON.parse(process.env.DSH_STORAGE_CAPTURE_PAIR!), ctx = new Context()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'live-storage-checkpoint-')))
  try {
    const audit = await auditStorageRecoveryArtifacts(pair, new AbortController().signal)
    expect(audit).toBeTruthy()
    const stateDir = join(directory, 'state'), keyFile = join(directory, 'key')
    await mkdir(stateDir, { mode: 0o700 }); createRecoveryKey(keyFile)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.set(KV.runtime.masterId, 'live-storage-master')
    store.db.exec('CREATE TABLE IF NOT EXISTS operator_endpoint(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO operator_endpoint VALUES(?,?)').run(pair.endpointId, JSON.stringify({ id: pair.endpointId, credentialFile: keyFile }))
    store.close()
    await ctx.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
    const writer = await ctx.sessionPersistence.create(Session.create(SessionId('live-storage-master')).header)
    await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: {
      role: 'user', id: MessageId('live-storage-message'), source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Native capture checkpoint' }] } }])
    await writer.close()
    const checkpoint = await createCheckpoint({ stateDir, outputDir: join(directory, 'backups'), keyFile, persistence: ctx.sessionPersistence, storageArtifacts: [pair] })
    expect((await verifyCheckpoint(checkpoint.path, keyFile)).storage?.[0]?.endpointId).toBe(pair.endpointId)
    const target = join(directory, 'held'); await stageCheckpoint(checkpoint.path, keyFile, target)
    const restored = new DatabaseSync(join(target, 'orchestrator.sqlite'), { readOnly: true })
    try { expect(restored.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)).toBeTruthy() } finally { restored.close() }
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})
