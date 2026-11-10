#!/usr/bin/env node
// A real detached process for launcher lifecycle tests; no provider or external network calls.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const fixture = process.env.DSH_LAUNCHER_FIXTURE
if (!fixture) throw new Error('DSH_LAUNCHER_FIXTURE is required')
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1]
if (args.includes('--version')) { console.log('0.2.1-rc.3'); process.exit(0) }
const profile = path.join(process.env.DSH_HOME, 'profiles', value('--profile') || 'agentic-os')
if (args.includes('--from-default-profile')) {
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n'); fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n')
  fs.appendFileSync(path.join(fixture, 'created'), profile + '\n'); process.exit(0)
}
if (args[0] === 'plugin') {
  const failure = path.join(fixture, 'fail-plugin-once')
  if (fs.existsSync(failure)) { fs.unlinkSync(failure); process.exit(1) }
  fs.appendFileSync(path.join(fixture, 'linked'), profile + '\n'); process.exit(0)
}
const patch = JSON.parse(fs.readFileSync(value('--patch'), 'utf8'))
const endpoint = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'agentic-execution-endpoint')
const { stateDir } = endpoint ? endpoint.config : patch.find(entry => entry.id === 'dsh-superagent').config
const { port } = patch.find(entry => entry.id === 'webserver').config
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
let endpointId, adminToken
if (endpoint) {
  const { DatabaseSync } = require('node:sqlite'), crypto = require('node:crypto')
  const db = new DatabaseSync(path.join(stateDir, 'endpoint.sqlite'))
  db.exec('CREATE TABLE IF NOT EXISTS endpoint_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT OR IGNORE INTO endpoint_meta VALUES (?,?)').run('id', crypto.randomUUID())
  endpointId = db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get('id').value; db.close()
  const file = path.join(stateDir, 'admin.token')
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 })
  adminToken = fs.readFileSync(file, 'utf8').trim()
}
const countFile = path.join(stateDir, 'launch-count'), count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0
fs.writeFileSync(countFile, String(count + 1))
const marker = path.join(stateDir, 'health.json')
const server = http.createServer((request, response) => {
  const state = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : {}
  if (request.url === '/redirect-target') fs.writeFileSync(path.join(stateDir, 'followed-redirect'), 'unexpected')
  else if (state.testRedirect) {
    response.writeHead(302, { location: `http://127.0.0.1:${port}/redirect-target` }); response.end(); return
  }
  response.setHeader('content-type', 'application/json')
  if (endpoint) {
    if (request.url !== '/execution/v1' || request.headers.authorization !== `Bearer ${adminToken}` || request.headers['x-dsh-endpoint'] !== endpointId) {
      response.writeHead(403); response.end('{}'); return
    }
    response.end(JSON.stringify({ endpointId, result: { id: endpointId, protocol: 1, platform: 'linux', confinement: 'linux-bubblewrap',
      capabilities: { filesystem: true, process: true, administration: true, effectOwnership: true, credentialBindings: true, snapshotVerification: true }, ...state } })); return
  }
  response.end(JSON.stringify({ health: { runtime: { state: 'ready' } }, setup: { machine: { stateDir }, problem: null }, ...state }))
})
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/?token=fixture-access-secret`))
process.on('SIGINT', () => {
  if (fs.existsSync(path.join(stateDir, 'ignore-stop'))) return
  fs.writeFileSync(path.join(stateDir, 'graceful-stop'), 'received')
  setTimeout(() => server.close(() => process.exit(0)), 50)
})
