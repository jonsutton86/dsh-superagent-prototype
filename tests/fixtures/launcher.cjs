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
const { stateDir } = patch.find(entry => entry.id === 'dsh-superagent').config
const { port } = patch.find(entry => entry.id === 'webserver').config
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
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
  response.end(JSON.stringify({ health: { runtime: { state: 'ready' } }, setup: { machine: { stateDir }, problem: null }, ...state }))
})
server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/?token=fixture-access-secret`))
process.on('SIGINT', () => {
  if (fs.existsSync(path.join(stateDir, 'ignore-stop'))) return
  fs.writeFileSync(path.join(stateDir, 'graceful-stop'), 'received')
  setTimeout(() => server.close(() => process.exit(0)), 50)
})
