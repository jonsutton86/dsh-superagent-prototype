/**
 * Throwaway local profile driven by a scripted OpenAI-compatible provider.
 * Prints one JSON line per step. Does not read or write the owner's profile.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { operatorToolingProvider } from '../tests/fixtures/operator-tooling-provider.ts'

const root = '/tmp/dsh-tooling-wip-' + Date.now()
const home = join(root, 'home')
const stateDir = join(root, 'state')
const profile = 'tooling-wip'
const port = 3097
const dsh = process.env.DSH ?? '/home/ubuntu/.local-dsh/node_modules/.bin/dsh'
const checkout = '/tmp/rea-main'
const attachmentPathFile = join(root, 'attachment-path.txt')
const log = (step: string, detail: unknown) => console.log(JSON.stringify({ step, detail }))

const provider = await operatorToolingProvider(attachmentPathFile)
const env = { ...process.env, DSH_HOME: home, HOME: home, TOOLING_FIXTURE_KEY: provider.providerKey }
mkdirSync(home, { recursive: true })
mkdirSync(stateDir, { recursive: true })
const profileDir = join(home, 'profiles', profile)
if (!existsSync(join(profileDir, 'package.json'))) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-tooling-wip', private: true,
    dependencies: { 'dsh-superagent': 'link:/workspace' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-superagent'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: webserver', '  config:', '    host: 127.0.0.1', `    port: ${port}`,
    '- id: dsh-superagent', '  config:', `    stateDir: ${stateDir}`, '    executionMode: local',
    '- id: dsh-superagent-github', '  disabled: true',
    '- id: dsh-superagent-feishu', '  disabled: true',
  ].join('\n') + '\n')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['install', '--ignore-scripts'], { cwd: profileDir, env, stdio: 'inherit' })
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('profile install exited ' + code)))
  })
}
const patch = join(root, 'provider.patch.json')
writeFileSync(patch, JSON.stringify([
  { id: 'llm-pi-ai', config: { providers: { 'tooling-fixture': { displayName: 'Synthetic operator tooling', api: 'openai-completions',
    baseURL: provider.url, apiKeyEnv: 'TOOLING_FIXTURE_KEY', compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    retryPolicy: { mode: 'normal', maxRetries: 0 }, timeoutMs: 60000, streamIdleTimeoutMs: 60000,
    models: [{ id: 'scripted', name: 'Synthetic tooling fixture', contextWindow: 131072, maxTokens: 2048, input: ['text'] }] } } } },
  { id: 'agent-default-model', config: { provider: 'tooling-fixture', model: 'scripted' } },
]))
const child = spawn(dsh, ['--profile', profile, '--patch', patch, '--no-open'], { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] })
let dshLog = ''
child.stdout.on('data', chunk => { dshLog += chunk; if (dshLog.length > 200_000) dshLog = dshLog.slice(-100_000) })
child.stderr.on('data', chunk => { dshLog += chunk; if (dshLog.length > 200_000) dshLog = dshLog.slice(-100_000) })
writeFileSync(join(root, 'dsh.pid'), String(child.pid))
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/${path}`, {
    method, headers: { host: `127.0.0.1:${port}`, 'x-orchestrator-request': '1', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}
try {
  let ready = false
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    try {
      const state = await api('GET', 'state')
      ready = state.status === 200 && (state.body.health as { runtime?: { state?: string } } | undefined)?.runtime?.state === 'ready'
      if (attempt === 0 || ready) log('state', { status: state.status, runtime: (state.body.health as { runtime?: unknown } | undefined)?.runtime })
    } catch (error) { if (attempt % 5 === 0) log('waiting', String(error)) }
  }
  if (!ready) throw new Error('runtime did not become ready')
  const settings = await api('GET', 'settings')
  const blocks = settings.body as { repository?: { revision: number }; executor?: { revision: number; value: Record<string, unknown> }; sources?: { id: string; revision: number }[] }
  const revision = (block: string) => blocks.sources?.find(item => item.id === block)?.revision ?? 0
  const repository = await api('PUT', 'settings/source:repository', { revision: revision('repository'), value: { enabled: true, config: { root: checkout, repository: 'jonsutton86/rea', branch: 'main' } } })
  log('repository-profile', { status: repository.status, body: repository.body })
  const executorValue = { ...(blocks.executor?.value ?? {}), prepare: [
    'set -e',
    'mkdir -p "$DSH_SUPERAGENT_DIR"',
    "printf '%s\\n' prepare-ran > \"$DSH_SUPERAGENT_DIR/prepare-ran\"",
    'if curl --version >"$DSH_SUPERAGENT_DIR/curl-attempt" 2>&1; then echo curl-was-not-blocked >&2; exit 1; fi',
    'grep -q "is blocked" "$DSH_SUPERAGENT_DIR/curl-attempt"',
  ].join('\n'), blockedCommands: ['curl'] }
  const fresh = await api('GET', 'settings')
  log('settings-executor', fresh.body.executor)
  const executorRevision = Number((fresh.body.executor as { revision?: number } | undefined)?.revision ?? blocks.executor?.revision ?? 0)
  const executor = await api('PUT', 'settings/executor', { revision: executorRevision, value: executorValue })
  log('executor', { status: executor.status, body: executor.body })
  const listing = await api('GET', 'search?q=') 
  const state = await api('GET', 'state')
  const masterId = String(state.body.masterId ?? '')
  log('master', { masterId, search: listing.status })
  const note = 'attached note\n'
  const digest = createHash('sha256').update(note).digest('hex')
  writeFileSync(attachmentPathFile, join(home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest, 'note.txt'))
  const tokenMatch = /token=([A-Za-z0-9._~-]+)/.exec(dshLog)
  log('launch-token', { found: !!tokenMatch })
  if (!tokenMatch || !masterId) throw new Error('missing launch token or master session')
  const page = await fetch(`http://127.0.0.1:${port}/?token=${tokenMatch[1]}`, { redirect: 'manual' })
  const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]
  const upload = await fetch(`http://127.0.0.1:${port}/api/session/uploadFileBinary?sessionId=${encodeURIComponent(masterId)}&name=note.txt`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: note,
  })
  const uploadedText = await upload.text()
  const uploadedBody = JSON.parse(uploadedText) as { value?: { receiptId?: string; file?: { attachmentId?: string; name?: string } }; receiptId?: string; file?: { attachmentId?: string; name?: string } }
  const uploaded = uploadedBody.value ?? uploadedBody
  log('upload', { status: upload.status, body: uploadedText.slice(0, 500) })
  if (uploaded.file?.attachmentId?.startsWith('sha256:')) {
    const sha = uploaded.file.attachmentId.slice('sha256:'.length)
    writeFileSync(attachmentPathFile, join(home, 'attachments', 'v1', 'files', sha.slice(0, 2), sha, uploaded.file.name || 'note.txt'))
  }
  const prompt = await fetch('http://127.0.0.1:' + port + '/api/session/prompt', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'tooling-' + Date.now(), method: 'session/prompt', payload: { args: { request: {
      requestId: 'tooling-' + Date.now(), sessionId: masterId, mode: 'queue',
      content: [{ type: 'text', text: 'check this repo https://github.com/jonsutton86/rea' }, ...(uploaded.receiptId ? [{ type: 'file', receiptId: uploaded.receiptId }] : [])],
    } } } }),
  })
  log('prompt', { status: prompt.status, body: (await prompt.text()).slice(0, 500) })
  let triggers: unknown = null
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    triggers = (await api('GET', 'threads')).body
    if (provider.calls.some(call => call.name === 'orchestrator_report') || provider.failures.length) break
  }
  log('provider-calls', provider.calls)
  log('provider-failures', provider.failures)
  log('threads', triggers)
  const work = join(stateDir, 'work')
  const directories = existsSync(work) ? readdirSync(work) : []
  const directory = directories.map(name => join(work, name)).find(path => existsSync(join(path, 'prepare-ran'))) ?? ''
  const marker = directory ? readFileSync(join(directory, 'prepare-ran'), 'utf8') : ''
  const curl = directory && existsSync(join(directory, 'curl-attempt')) ? readFileSync(join(directory, 'curl-attempt'), 'utf8') : ''
  const staged = directory && existsSync(join(directory, 'attachments', 'note.txt')) ? readFileSync(join(directory, 'attachments', 'note.txt'), 'utf8') : ''
  log('prepare', { directories, directory, marker, curl, staged, calls: provider.calls.map(call => call.name) })
} finally {
  child.kill('SIGTERM')
  await provider.close()
  writeFileSync(join(root, 'dsh.log'), dshLog)
}
