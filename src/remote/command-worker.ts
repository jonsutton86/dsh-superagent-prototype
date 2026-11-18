/** Runs inside the command namespace. Credential bytes never enter provider argv, coordinator requests or endpoint receipts. */
import { accessSync, constants, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

try {
  const config = JSON.parse(process.argv[2]!) as { bindings: { path: string; variable: string; mode: 'env' | 'file' }[]; argv: string[] }
  const env = { ...process.env }
  for (const item of config.bindings) env[item.variable] = item.mode === 'file' ? item.path
    : new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(item.path)).replace(/\r?\n$/, '')
  const command = config.argv[0]!
  let executable = command
  if (!isAbsolute(command) && !command.includes('/')) {
    const candidates = (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':').map(path => resolve(path, command))
    executable = candidates.find(path => { try { accessSync(path, constants.X_OK); return true } catch { return false } }) ?? command
  }
  if (!process.execve) throw new Error('POSIX execve is required')
  process.execve(executable, config.argv, env)
} catch {
  // Provider/tool errors must not serialize a credential value or the process environment.
  process.stderr.write('Endpoint credential command could not start. Check the executable and credential binding.\n')
  process.exitCode = 125
}
