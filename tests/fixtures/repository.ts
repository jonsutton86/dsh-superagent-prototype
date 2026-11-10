import { expect, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { remoteFixture } from './remote.ts'
import { startRuntime } from './host.ts'
import { gitServer } from './git-server.ts'
const rid = () => randomUUID()
export async function repositoryFixture(cleanup: (() => Promise<unknown>)[]) {
  const server = await gitServer(cleanup), h = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true })
  const bindings: { id: string; version: string }[] = []
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', beforeEnroll: async endpoint => {
    for (const [id, variable, bytes, mode] of [['git-token', 'REPOSITORY_TOKEN', server.token, 'env'], ['git-ca', 'GIT_SSL_CAINFO', server.cert, 'file']] as const) {
      await writeFile(join(endpoint.credentials.imports, id), bytes, { mode: 0o600 })
      const value = await endpoint.rpc({ role: 'admin' }, { op: 'credential.import', requestId: rid(), id, revision: 0,
        file: id, variable, mode, reason: 'Private local Git fixture' }) as { id: string; version: string }
      bindings.push({ id: value.id, version: value.version })
    }
  } })
  if (process.env.DSH_REMOTE_ISOLATION !== '1') vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const record = await h.runtime.endpoints.register({ requestId: rid(), endpointId: remote.endpoint.journal.id, url: remote.url,
    credentialFile: remote.connection.credentialFile, revision: 0, name: 'Repository endpoint' })
  const command = await h.runtime.endpoints.submit(record.id, { revision: 1, request: { op: 'grant.create', requestId: rid(),
    owner: 'coordinator', workspace: 'repository', operations: ['fs.read', 'fs.write', 'process.spawn', 'network'], credentials: bindings, leaseMs: 300000 } })
  cleanup.push(() => h.stop())
  const activation = { requestId: rid(), endpointId: record.id, commandId: command.id, name: 'Pinned repository',
    repository: { url: server.url, commit: server.commit, credentialId: 'git-token', username: 'x-access-token' } }
  const world = await h.runtime.worlds.activate(activation)
  expect(world.ready, world.problem).toBe(true)
  const member = h.runtime.worlds.require(world.id)
  const prepare = (id: string, directory = join(world.root, id)) => member.world.withOwner({ kind: 'assignment', ticketId: id,
    assignmentId: 'assignment-' + id, sessionId: 'worker-' + id, callId: 'prepare-' + id, tool: 'workspace-prepare' }, () => {}, () => member.workspace.prepareRepository(directory, id))
  return { h, remote, server, activation, world, member, prepare }
}
