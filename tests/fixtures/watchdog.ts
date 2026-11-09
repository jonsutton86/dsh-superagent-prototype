import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchdogJournal } from '../../src/supervision/journal.ts'
import { watchdogHttp } from '../../src/supervision/http.ts'
import { DEFAULT_RETENTION } from '../../src/supervision/protocol.ts'
import type { ObservationSet } from '../../src/supervision/client.ts'

export function watchdogFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'watchdog-console-')), now = Date.now()
  const file = join(directory, 'watchdog.sqlite'), journal = new WatchdogJournal(file)
  const snapshot: ObservationSet = { instance: 'main-one', version: 'v1', at: new Date(now).toISOString(), configured: true,
    paused: false, health: { runtime: { state: 'ready' } }, tickets: [{ id: 'task-one', assignmentId: 'assignment-one', revision: 'ticket-one',
      title: 'Prepare release evidence', scope: 'Run the release checks and report results.', stage: 'person/blocked',
      updatedAt: new Date(now - 1000000).toISOString(), report: { state: 'blocked', summary: 'Waiting for the target platform.', at: new Date(now).toISOString() }, canNudge: false }] }
  journal.reconcile(snapshot, now, 1000, 3600000)
  return { directory, file, journal, now, snapshot, dispose: () => { journal.close(); rmSync(directory, { recursive: true, force: true }) } }
}
export async function watchdogServer(fixture = watchdogFixture()) {
  let active = true
  const options = { port: 0, sessionId: 'watchdog-fixture', mainUrl: 'http://127.0.0.1:3082', pollMs: 1000, retention: DEFAULT_RETENTION,
    asset: () => 'document.title = "Agentic OS supervision"', active: () => active }
  const server = createServer(watchdogHttp(fixture.journal, options))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  options.port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${options.port}`, nativeFetch = fetch
  const request = (path: string, init: RequestInit = {}) => nativeFetch(url + path, { ...init,
    headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json', ...init.headers } })
  return { ...fixture, url, request, stop: async () => {
    active = false; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fixture.dispose()
  } }
}
