/** Trusted pre-exec gate outside bubblewrap: join the already-limited cgroup before executing any command. */
import { accessSync, constants, closeSync, lstatSync, openSync, readFileSync, realpathSync, statfsSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

try {
  const [group, encoded, command, ...args] = process.argv.slice(2)
  if (process.platform !== 'linux' || !group || !encoded || !command || !process.execve)
    throw new Error('Unsupported resource launch')
  const expected = JSON.parse(encoded) as { command: Record<string, string>; pool: Record<string, string> }
  for (const [directory, settings] of [[group, expected.command], [dirname(group), expected.pool]] as const) {
    if (!isAbsolute(directory) || realpathSync(directory) !== directory || statfsSync(directory).type !== 0x63677270)
      throw new Error('Not a canonical cgroup v2 directory')
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.uid !== process.getuid!()) throw new Error('Cgroup ownership mismatch')
    if (readFileSync(join(directory, 'cgroup.type'), 'utf8').trim() !== 'domain') throw new Error('Threaded groups are unsupported')
    if (Object.keys(settings).sort().join(',') !== 'cpu.max,memory.max,memory.oom.group,memory.swap.max,pids.max') throw new Error('Incomplete resource policy')
    for (const [name, value] of Object.entries(settings))
      if (readFileSync(join(directory, name), 'utf8').trim() !== value) throw new Error('Kernel resource policy changed')
  }
  const file = openSync(join(group, 'cgroup.procs'), constants.O_WRONLY | constants.O_NOFOLLOW)
  try { writeSync(file, String(process.pid)) } finally { closeSync(file) }
  if (!readFileSync(join(group, 'cgroup.procs'), 'utf8').split(/\s+/).includes(String(process.pid))) throw new Error('Cgroup entry failed')
  const candidates = isAbsolute(command) ? [command] : command.includes('/') ? [resolve(command)]
    : (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean).map(directory => resolve(directory, command))
  const executable = candidates.find(path => { try { accessSync(path, constants.X_OK); return true } catch { return false } })
  if (!executable) throw new Error('Executable unavailable')
  process.execve(executable, [executable, ...args], process.env)
} catch {
  // Do not print command arguments, credentials or the inherited environment.
  process.stderr.write('Endpoint resource boundary could not be established; command was not executed.\n')
  process.exitCode = 125
}
