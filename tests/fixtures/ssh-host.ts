/** Explicit native SSH fixture. All keys, authorized users and listeners are private and disposable. */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'

export const execute = (file: string, args: string[], timeout = 15000): Promise<string> => new Promise((resolve, reject) =>
  execFile(file, args, { timeout }, (error, stdout, stderr) => error ? reject(new Error(`${file}: ${stderr.trim() || 'failed'}`)) : resolve(stdout)))

export async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve())); return port
}

const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'

export async function sshHost(root: string, endpointPort: number) {
  await mkdir(root, { mode: 0o700 })
  const port = await freePort(), username = userInfo().username
  const hostKey = join(root, 'host-key'), identityFile = join(root, 'client-key'), knownHostsFile = join(root, 'known_hosts')
  for (const file of [hostKey, identityFile]) await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file])
  const key = (await readFile(identityFile + '.pub', 'utf8')).trim()
  await writeFile(join(root, 'authorized_keys'), `restrict,port-forwarding,permitopen="127.0.0.1:${endpointPort}",command="/usr/bin/false" ${key}\n`, { mode: 0o600 })
  await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${(await readFile(hostKey + '.pub', 'utf8')).trim()}\n`, { mode: 0o600 })
  const config = join(root, 'sshd_config')
  await writeFile(config, ['ListenAddress 127.0.0.1', `Port ${port}`, 'HostKey ' + quote(hostKey), 'PidFile ' + quote(join(root, 'sshd.pid')),
    'AuthorizedKeysFile ' + quote(join(root, 'authorized_keys')), 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM no', 'StrictModes no', // Disposable authorized_keys sits beneath the OS temporary directory.
    'AllowUsers ' + username, 'AllowTcpForwarding local', 'PermitOpen 127.0.0.1:' + endpointPort, 'GatewayPorts no',
    'PermitTTY no', 'MaxSessions 0', 'UseDNS no', 'LogLevel ERROR', ''].join('\n'), { mode: 0o600 })
  const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4096) })
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed }
  try {
    const until = Date.now() + 5000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture sshd exited: ' + diagnostic)
      const listening = await new Promise<boolean>(resolve => {
        const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false)); socket.setTimeout(200, () => { socket.destroy(); resolve(false) })
      })
      if (listening) break
      if (Date.now() >= until) throw new Error('Fixture sshd did not listen: ' + diagnostic)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return { host: '127.0.0.1', user: username, sshPort: port, identityFile, knownHostsFile, stop }
  } catch (error) { await stop(); throw error }
}
