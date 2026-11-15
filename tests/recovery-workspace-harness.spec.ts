/** Real installed Harness maintenance; isolated HOME, no model requests or live app changes. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { createRecoveryKey } from '../src/recovery/crypto.ts'
import { createCheckpoint } from '../src/recovery/checkpoint.ts'
import { captureWorkspaceRecovery } from '../src/recovery/workspace-archive.ts'

it.runIf(process.env.DSH_WORKSPACE_RECOVERY_CLI)('stages and reauthenticates a held workspace through fresh installed Harness processes', async () => {
  const cli = process.env.DSH_WORKSPACE_RECOVERY_CLI!, checkout = resolve('.')
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-maintenance-'))), ctx = new Context()
  const home = join(directory, 'user-home'), installation = join(directory, 'installation'), source = join(directory, 'source')
  const stateDir = join(directory, 'state'), keyFile = join(directory, 'key'), sessions = join(directory, 'sessions')
  const profile = 'workspace-recovery-' + randomUUID(), destination = join(directory, 'candidate')
  const environment = { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : [])), HOME: home, npm_config_ignore_workspace_root_check: 'true' }
  let child: ChildProcess | undefined
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const running = child, done = new Promise<void>(resolve => running.once('exit', () => resolve()))
    running.kill('SIGINT'); const timer = setTimeout(() => running.kill('SIGKILL'), 8000)
    try { await done } finally { clearTimeout(timer) }
  }
  try {
    for (const path of [home, source, stateDir]) await mkdir(path, { mode: 0o700 })
    await writeFile(join(source, 'retained.txt'), 'retained workspace')
    const archive = await captureWorkspaceRecovery(source, join(directory, 'archive'), { maxEntries: 100, maxBytes: 1024 })
    createRecoveryKey(keyFile)
    const store = new Store(join(stateDir, 'orchestrator.sqlite'))
    store.set(KV.runtime.masterId, 'maintenance-master')
    store.db.exec('CREATE TABLE IF NOT EXISTS execution_environment(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
    store.db.prepare('INSERT INTO execution_environment VALUES(?,?)').run('source', JSON.stringify({ root: source, configuredRoot: source }))
    store.close()
    await ctx.plugin(Jsonl, { root: sessions, compression: 'none' })
    const writer = await ctx.sessionPersistence.create(Session.create(SessionId('maintenance-master')).header); await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: { role: 'user', id: MessageId('maintenance-message'), source: { kind: 'dsh-superagent', form: 'relay' }, content: [{ type: 'text', text: 'Maintenance fixture' }] } }]); await writer.close()
    const saved = await createCheckpoint({ stateDir, outputDir: join(directory, 'checkpoints'), keyFile, persistence: ctx.sessionPersistence, workspaceArtifacts: [archive.path] })
    const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
    const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
    await promisify(execFile)('python3', [join(checkout, 'scripts/agentic-os'), 'init', '--directory', installation, '--role', 'workspace', '--checkout', checkout, '--dsh', cli, '--profile', profile, '--port', String(port)], { cwd: directory, env: environment, timeout: 120000 }).catch(async error => { throw new Error(String(error) + '\n' + (await readFile(join(installation, 'install.log'), 'utf8')).split('\n').filter(line => !/key|token|secret|credential|authorization/i.test(line)).slice(-25).join('\n')) })
    const launch = JSON.parse(await readFile(join(installation, 'launch.json'), 'utf8')) as unknown[]
    const run = async (mode: string) => {
      const receiptFile = join(directory, mode + '.json'), patch = join(directory, mode + '.patch.json')
      await writeFile(patch, JSON.stringify([...launch, { id: 'dsh-superagent', disabled: true }, { id: 'session-title-llm', disabled: true },
        { id: 'session-persistence-jsonl', config: { root: sessions, compression: 'none' } },
        { insert: [{ id: 'workspace-maintenance', name: 'dsh-superagent/recovery', config: { mode, keyFile, checkpoint: saved.path, workspaceSource: source, destination, receiptFile } }] }]), { mode: 0o600 })
      child = spawn(cli, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: directory, env: { ...environment, DSH_HOME: join(installation, 'home') }, stdio: 'ignore' })
      try {
        await vi.waitFor(async () => {
          expect(child!.exitCode).toBeNull()
          expect(JSON.parse(await readFile(receiptFile, 'utf8'))).toMatchObject({ mode, checkpoint: saved.manifest.id, executionOwnership: false, path: destination })
        }, { timeout: 30000, interval: 250 })
      } finally { await stop() }
    }
    await run('stage-workspace')
    const hold = await readFile(join(destination, 'hold.json'), 'utf8')
    await run('verify-workspace')
    expect(await readFile(join(destination, 'hold.json'), 'utf8')).toBe(hold)
    expect(JSON.parse(hold)).toMatchObject({ state: 'held', executionOwnership: false, restoreVerified: false })
    expect(await readFile(join(destination, 'workspace/retained.txt'), 'utf8')).toBe('retained workspace')
  } finally { await stop(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 180000)
