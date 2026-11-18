#!/usr/bin/env node
// Run only against an owned disposable endpoint, before and after an actual VM/host power interruption.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteClient } from '../../lib/remote-client.js'

assert.equal(process.env.DSH_DISPOSABLE_QUALIFICATION, '1', 'This driver is only for a disposable qualification host')
assert.equal(process.platform, 'linux')
const [mode, directory] = process.argv.slice(2)
assert.ok(['begin', 'verify'].includes(mode) && directory?.startsWith('/'))
process.umask(0o077)
const file = join(directory, 'boot-proof.json'), tokenFile = join(directory, 'boot-grant.token')
const metadata = JSON.parse(readFileSync(join(directory, 'enrollment.json'), 'utf8'))
const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
const admin = new RemoteClient({ url: metadata.url, endpointId: metadata.endpointId, credentialFile: metadata.credentialFile })
const identity = await admin.call({ op: 'identity' })
assert.equal(identity.id, metadata.endpointId)
assert.equal(identity.confinement, 'linux-bubblewrap')
assert.equal(identity.resources?.ready, true)

function save(target, value) {
  const temporary = target + '.' + process.pid + '.tmp'
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 })
  let fd = openSync(temporary, 'r'); fsyncSync(fd); closeSync(fd)
  renameSync(temporary, target)
  fd = openSync(directory, 'r'); fsyncSync(fd); closeSync(fd)
}
const persist = value => save(file, JSON.stringify(value, null, 2) + '\n')
const client = () => new RemoteClient({ url: metadata.url, endpointId: metadata.endpointId, credentialFile: tokenFile })
async function until(check) {
  const deadline = Date.now() + 15000
  for (;;) {
    try { return await check() }
    catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
}

if (mode === 'begin') {
  const record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
    seed: randomUUID(), bootId, endpointId: identity.id, policy: identity.resources.policy,
  }
  assert.equal(record.bootId, bootId, 'Use verify after reboot; never begin replacement work')
  assert.equal(record.endpointId, identity.id)
  persist(record) // Preserve the original grant/command request identity before crossing either effect boundary.
  const receipt = await admin.call({ op: 'grant.create', requestId: 'boot-grant-' + record.seed, owner: 'boot-qualification',
    workspace: 'boot-' + record.seed, operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300000 })
  save(tokenFile, receipt.credential)
  record.grant = { id: receipt.grant.id, root: receipt.grant.root, revision: receipt.grant.revision }
  record.request = { op: 'job.spawn', requestId: 'boot-command-' + record.seed, revision: receipt.grant.revision,
    argv: ['/usr/local/bin/node', '-e', "const fs=require('node:fs');const fd=fs.openSync('proof.txt','a',0o600);fs.writeSync(fd,'once\\n');fs.fsyncSync(fd);fs.closeSync(fd);const dir=fs.openSync('.','r');fs.fsyncSync(dir);fs.closeSync(dir);setTimeout(()=>{},300000)"],
    cwd: receipt.grant.root, graceMs: 1000 }
  persist(record)
  const remote = client(), job = await remote.call(record.request)
  record.jobId = job.id; persist(record)
  await until(async () => assert.equal(await remote.call({ op: 'fs.read', path: join(record.grant.root, 'proof.txt') }), 'once\n'))
  const running = await remote.call({ op: 'job.get', id: job.id })
  assert.equal(running.phase, 'started'); assert.notEqual(running.quiescent, true)
  console.log(JSON.stringify({ phase: 'prepared-for-power-interruption', endpointId: identity.id, bootId, jobId: job.id, proof: 'one durable invocation' }))
} else {
  const record = JSON.parse(readFileSync(file, 'utf8')), remote = client()
  assert.notEqual(record.bootId, bootId, 'This acceptance requires a real OS reboot, not a process restart')
  assert.equal(record.endpointId, identity.id)
  assert.deepEqual(record.policy, identity.resources.policy)
  const original = await remote.call({ op: 'job.get', id: record.jobId })
  assert.equal(original.phase, 'unknown'); assert.notEqual(original.outcome?.exitCode, 0)
  const replay = await remote.call(record.request)
  assert.equal(replay.id, original.id); assert.equal(replay.phase, 'unknown')
  assert.equal(await remote.call({ op: 'fs.read', path: join(record.grant.root, 'proof.txt') }), 'once\n')
  const next = { op: 'job.spawn', requestId: 'after-boot-' + record.seed, revision: record.grant.revision,
    argv: ['/usr/bin/true'], cwd: record.grant.root, graceMs: 1000 }
  if (!original.reconciled) {
    await assert.rejects(() => remote.call(next), error => error.code === 'reconciliation_required')
  }
  // Explicit qualification-driver review: the OS boot ID changed and the endpoint checks kernel population.
  // This does not represent a human accepting the interrupted command's result.
  const reconciled = await admin.call({ op: 'job.reconcile', requestId: 'boot-reconcile-' + record.seed,
    id: original.id, quiescent: true, note: 'Qualification verified OS boot replacement and one durable invocation; outcome remains unknown.' })
  assert.equal(reconciled.phase, 'unknown'); assert.equal(reconciled.quiescent, true)
  assert.notEqual(reconciled.outcome?.exitCode, 0)
  const continued = await remote.call(next)
  await until(async () => assert.equal((await remote.call({ op: 'job.get', id: continued.id })).outcome?.exitCode, 0))
  assert.equal(await remote.call({ op: 'fs.read', path: join(record.grant.root, 'proof.txt') }), 'once\n')
  const result = { phase: 'verified-after-power-interruption', endpointId: identity.id, previousBootId: record.bootId, bootId,
    originalJobId: original.id, originalPhase: reconciled.phase, quiescent: reconciled.quiescent,
    proof: 'one durable invocation', continuedJobId: continued.id }
  save(join(directory, 'boot-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
