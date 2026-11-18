/** Runs on the existing endpoint; bundles preserve original commit identities and history rather than rewriting commits. */
export const REPOSITORY_EXPORT_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
let phase = 'configuration';
try {
  process.umask(0o077);
  const { root, directory, output, base, head, tree, maxBytes } = JSON.parse(process.argv[1]);
  if (![base,head,tree].every(value => /^[a-f0-9]{40}$/.test(value)) || base === head || path.dirname(directory) !== root
    || path.dirname(output) !== root || fs.realpathSync(root) !== root || fs.realpathSync(directory) !== directory
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 268435456) throw new Error('Invalid export');
  const env = { PATH:path.dirname(process.execPath)+':/usr/local/bin:/usr/bin:/bin', HOME:'/nonexistent', LANG:'C', LC_ALL:'C',
    GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_NO_LAZY_FETCH:'1', GIT_OPTIONAL_LOCKS:'0' };
  const git = args => {
    const result = cp.spawnSync('git', ['-c','protocol.allow=never','-c','credential.helper=','-c','core.hooksPath=/dev/null',
      '-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.excludesFile=/dev/null',...args],
      { cwd:directory, env, encoding:'utf8', timeout:120000, maxBuffer:1048576, stdio:['ignore','pipe','pipe'] });
    if (result.error || result.status !== 0) throw new Error('Git export failed'); return result.stdout.trim();
  };
  const original = () => {
    if (git(['rev-parse','--show-toplevel']) !== directory || git(['rev-parse','--verify','HEAD']) !== head
      || git(['rev-parse','--verify','HEAD^{tree}']) !== tree || git(['status','--porcelain=v1','--untracked-files=all'])) throw new Error('Source changed');
  };
  phase = 'source verification'; original(); git(['merge-base','--is-ancestor',base,head]);
  phase = 'bundle creation'; fs.mkdirSync(output,{mode:0o700});
  const file = path.join(output,'repository.bundle');
  git(['bundle','create',file,'HEAD','^'+base]);
  const heads = git(['bundle','list-heads',file]);
  if (heads !== head+' HEAD') throw new Error('Bundle head differs');
  git(['bundle','verify',file]); original();
  phase = 'bundle durability';
  const fd = fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW), before = fs.fstatSync(fd);
  if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error('Bundle exceeds bound');
  const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(65536); let bytes = 0;
  try {
    for (;;) { const count = fs.readSync(fd,chunk,0,chunk.length,bytes); if (!count) break; bytes += count;
      if (bytes > before.size) throw new Error('Bundle changed'); hash.update(chunk.subarray(0,count)); }
    const after = fs.fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Bundle changed');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  for (const target of [output,root]) { const fd = fs.openSync(target,'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  process.stdout.write(JSON.stringify({version:1,base,head,tree,bytes,sha256:hash.digest('hex')})+'\n');
} catch { process.stderr.write('Repository export failed during '+phase+'. Existing work was preserved.\n'); process.exitCode=1; }
`
