/** Private bare Git import and create-only push, executed through the publisher's paired Harness process provider. */
import { mkdtemp, open, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { RepositoryTransferReceipt } from './repository-model.ts'

/** An original child process has no confirmed exit; retain its import and refuse external adoption. */
export class RepositoryProcessUnsettled extends Error {}
/** Sanitized import stage/category without command output, provider response or credential bytes. */
export class RepositoryPreparationError extends Error {}
export interface RepositoryGitTransport { url: string; caFile?: string }
const PROGRAM = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
let failure='execution';
try {
  const value=JSON.parse(fs.readFileSync(0,'utf8'));
  const env={PATH:path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',
    GIT_ASKPASS:value.askpassCommand,DSH_GIT_AUTH:value.credential,...value.caFile?{GIT_SSL_CAINFO:value.caFile}:{}};
  const result=cp.spawnSync('git',['-c','core.hooksPath=/dev/null','-c','credential.helper=','-c','protocol.allow=never',
    '-c','protocol.https.allow=always','-c','http.followRedirects=false','-c','core.fsmonitor=false',
    '-c','gc.auto=0','-c','maintenance.auto=false','-c','fetch.fsckObjects=true','-c','transfer.fsckObjects=true',...value.argv],
    {cwd:process.cwd(),env,encoding:'utf8',timeout:120000,maxBuffer:2097152,stdio:['ignore','pipe','pipe']});
  if(result.error||result.status!==0){const text=result.stderr||'';failure=/certificate|SSL|TLS/i.test(text)?'tls':/Authentication failed|could not read|askpass/i.test(text)?'credentials':/not allowed/.test(text)?'protocol':/fsck|bad object|invalid object/i.test(text)?'objects':/unable to access|Could not resolve/i.test(text)?'network':'execution';throw new Error();}process.stdout.write(result.stdout);
}catch{process.stderr.write('dsh-repository-error:'+failure+'\n');process.exitCode=1;}
`
const ASKPASS = '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token ;; *Password*) printf "%s\\n" "$DSH_GIT_AUTH" ;; *) exit 1 ;; esac\n'
/** Materialize and verify an immutable bundle with the paired Harness provider before any external push. */
export class RepositoryGit {
  private quiescent = true
  private constructor(private readonly subprocess: SubprocessRuntime, readonly directory: string, private readonly node: string,
    private readonly transport: RepositoryGitTransport, private readonly credential: () => string, private readonly signal: AbortSignal) {}
  static async prepare(subprocess: SubprocessRuntime, root: string, transfer: RepositoryTransferReceipt, chunks: Iterable<Buffer>,
    transport: RepositoryGitTransport, credential: () => string, signal: AbortSignal): Promise<RepositoryGit> {
    const node = await subprocess.resolveExecutable('node', undefined, signal), directory = await mkdtemp(join(root, 'import-' + transfer.id + '-'))
    const runner = new RepositoryGit(subprocess, await realpath(directory), node, transport, credential, signal)
    let stage = 'process pairing'
    try {
      // Prove process/filesystem pairing before sending any credential bytes to the process provider.
      const nonce = randomUUID(); await writeFile(join(directory, 'pair'), nonce, { mode: 0o600 })
      if ((await runner.process([node, '-e', 'process.stdout.write(require("node:fs").readFileSync("pair","utf8"))'])).trim() !== nonce) throw new Error('Publisher process and filesystem are not paired')
      await writeFile(join(directory, 'askpass'), ASKPASS, { mode: 0o700 })
      stage = 'bundle materialization'
      const file = await open(join(directory, 'repository.bundle'), 'wx', 0o600)
      try { for (const chunk of chunks) { signal.throwIfAborted(); await file.writeFile(chunk) } await file.sync() } finally { await file.close() }
      stage = 'Git initialization'; await runner.git('init', '--bare', '--quiet', '--template=', 'objects.git')
      const git = (...args: string[]) => runner.git('-C', 'objects.git', ...args)
      stage = 'base fetch'; await git('fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', transport.url, transfer.bundle.base)
      const bundle = join(directory, 'repository.bundle')
      stage = 'bundle validation'; if ((await git('bundle', 'list-heads', bundle)).trim() !== transfer.bundle.head + ' HEAD') throw new Error('Bundle advertises a different head')
      await git('bundle', 'verify', bundle); await git('bundle', 'unbundle', bundle)
      stage = 'object validation'; if ((await git('rev-parse', '--verify', transfer.bundle.head + '^{tree}')).trim() !== transfer.bundle.tree) throw new Error('Imported tree differs from review')
      await git('merge-base', '--is-ancestor', transfer.bundle.base, transfer.bundle.head)
      await git('fsck', '--strict', '--no-dangling', transfer.bundle.head, transfer.bundle.base)
      return runner
    } catch (error) { await runner.close(); if (error instanceof RepositoryProcessUnsettled) throw error;
      throw new RepositoryPreparationError('Repository import failed during ' + stage + (error instanceof RepositoryPreparationError ? ' (' + error.message + ')' : '')) }
  }
  private async process(argv: string[], stdin?: string): Promise<string> {
    this.signal.throwIfAborted(); this.quiescent = false
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(150000)])
    const handle = this.subprocess.spawn({ argv, cwd: this.directory, signal, graceMs: 2000,
      stdio: { stdin: stdin === undefined ? 'ignore' : { data: stdin }, stdout: { maxBytes: 2097152 }, stderr: { maxBytes: 4096 } } })
    let outcome
    try { outcome = await handle.done }
    finally {
      this.quiescent = await handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false)
      if (!this.quiescent) throw new RepositoryProcessUnsettled('Publisher Git process range has not reached quiescence')
    }
    signal.throwIfAborted()
    const stdout = handle.collected.stdout?.readFrom(0)
    if (outcome.exitCode !== 0 || !stdout || stdout.lossy) {
      const category = /^dsh-repository-error:(tls|credentials|protocol|objects|network|execution)\n$/.exec(handle.collected.stderr?.readFrom(0).text ?? '')?.[1] ?? 'execution'
      throw new RepositoryPreparationError('Git ' + category + ' failure')
    }
    return stdout.text
  }
  private git(...argv: string[]) { return this.process([this.node, '-e', PROGRAM], JSON.stringify({ argv,
    askpassCommand: join(this.directory, 'askpass'), credential: this.credential(), caFile: this.transport.caFile })) }
  async push(branch: string, head: string): Promise<void> {
    const ref = 'refs/heads/' + branch
    // An explicit empty lease is an atomic non-existence condition, not permission to overwrite a branch.
    await this.git('-C', 'objects.git', 'push', '--porcelain', '--no-follow-tags', '--no-verify', '--force-with-lease=' + ref + ':', this.transport.url, head + ':' + ref)
  }
  async close() { if (this.quiescent) await rm(this.directory, { recursive: true, force: true }) }
}
