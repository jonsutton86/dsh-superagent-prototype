/** Trusted preparation source, executed through the existing confined endpoint job protocol, never on the coordinator. */
export const REPOSITORY_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
let phase = 'configuration';
let temporary;
try {
  process.umask(0o077);
  const config = JSON.parse(process.argv[1]);
  const { root, directory, source, branch, staging, credential } = config;
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)
    || !/^agentic\/[A-Za-z0-9_-]{1,100}$/.test(branch)
    || path.dirname(directory) !== root || path.dirname(staging) !== root || directory === staging
    || fs.realpathSync(root) !== root) throw new Error('Invalid preparation');
  for (const target of [directory, staging]) {
    try { fs.lstatSync(target); throw new Error('Existing preparation must be inspected'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  temporary = fs.mkdtempSync(path.join('/tmp', 'agentic-git-'));
  const env = { PATH: path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin', HOME: temporary, TMPDIR: temporary,
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  // A private CA can be explicitly mounted by the endpoint; ambient proxy/config/trace variables are never inherited.
  if (process.env.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = process.env.GIT_SSL_CAINFO;
  if (credential) {
    const token = credential.mode === 'file' ? fs.readFileSync(process.env[credential.variable], 'utf8').trim() : process.env[credential.variable];
    if (!token || /[\r\n\0]/.test(token) || token.length > 8192) throw new Error('Credential unavailable');
    env.AGENTIC_REPOSITORY_TOKEN = token;
    env.AGENTIC_REPOSITORY_USERNAME = source.username;
    const askpass = path.join(temporary, 'askpass');
    fs.writeFileSync(askpass, '#!/usr/bin/env node\nconst prompt=process.argv[2]||"";if(prompt.startsWith("Username"))process.stdout.write(process.env.AGENTIC_REPOSITORY_USERNAME+"\\n");else if(prompt.startsWith("Password"))process.stdout.write(process.env.AGENTIC_REPOSITORY_TOKEN+"\\n");else process.exitCode=1;\n', { flag:'wx', mode:0o700 });
    env.GIT_ASKPASS = askpass;
  }
  const options = ['-c','protocol.allow=never','-c','protocol.https.allow=always','-c','credential.helper=',
    '-c','http.followRedirects=false','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','init.templateDir=','-c','fetch.recurseSubmodules=false','-c','fetch.fsckObjects=true',
    '-c','transfer.fsckObjects=true','-c','gc.auto=0','-c','maintenance.auto=false'];
  const git = (args, cwd = staging) => {
    const result = cp.spawnSync('git', [...options, ...args], { cwd, env, encoding:'utf8', timeout:120000, maxBuffer:1024*1024, stdio:['ignore','pipe','pipe'] });
    if (result.error || result.status !== 0) throw new Error('Git operation failed');
    return result.stdout.trim();
  };
  phase = 'initialization';
  fs.mkdirSync(staging, { mode:0o700 });
  git(['init','--quiet','--object-format='+(source.commit.length===64?'sha256':'sha1')]);
  git(['config','user.useConfigOnly','true']);
  git(['remote','add','origin',source.url]);
  phase = 'fetch';
  git(['fetch','--no-tags','--no-recurse-submodules','--depth=1','origin',source.commit]);
  phase = 'commit verification';
  if (git(['rev-parse','--verify','FETCH_HEAD^{commit}']) !== source.commit) throw new Error('Commit changed');
  git(['fsck','--strict','--no-reflogs']);
  phase = 'checkout';
  git(['checkout','--quiet','-b',branch,source.commit]);
  if (git(['rev-parse','--verify','HEAD']) !== source.commit || git(['symbolic-ref','--short','HEAD']) !== branch)
    throw new Error('Checkout changed');
  const tree = git(['rev-parse','HEAD^{tree}']);
  phase = 'durable publication';
  const sync = target => {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) for (const entry of fs.readdirSync(target)) sync(path.join(target,entry));
    else if (!info.isFile()) throw new Error('Unexpected checkout file');
    const fd = fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  sync(staging);
  // The destination was never exposed to the worker until all repository bytes were durable.
  // Plain rename can replace an empty destination created concurrently. Require an atomic no-replace operation.
  const publish = cp.spawnSync('python3', ['-c', [
    'import ctypes, os, sys',
    'libc = ctypes.CDLL(None, use_errno=True)',
    'source, target = map(os.fsencode, sys.argv[1:])',
    'if sys.platform == "linux":',
    '  fn = libc.renameat2',
    '  fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]',
    '  result = fn(-100, source, -100, target, 1)',
    'elif sys.platform == "darwin":',
    '  fn = libc.renamex_np',
    '  fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]',
    '  result = fn(source, target, 4)',
    'else: raise RuntimeError("Atomic publication unavailable")',
    'if result: raise OSError(ctypes.get_errno(), "Repository publication refused")'
  ].join('\n'), staging, directory], { cwd:root, env:{ PATH:env.PATH, LANG:'C', LC_ALL:'C' }, timeout:5000, stdio:'ignore' });
  if (publish.error || publish.status !== 0) throw new Error('Task directory publication failed');
  const fd = fs.openSync(root,'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  process.stdout.write(JSON.stringify({ version:1, commit:source.commit, tree, branch })+'\n');
} catch {
  // No provider stderr, environment values or credentials enter command receipts.
  process.stderr.write('Repository preparation failed during '+phase+'. Existing files were preserved for inspection.\n');
  process.exitCode = 1;
} finally {
  if (temporary) { try { fs.rmSync(temporary,{recursive:true,force:true}); } catch {} }
}
`
