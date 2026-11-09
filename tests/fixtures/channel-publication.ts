import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { ownershipAuthority } from './ownership-authority.ts'
import { publicationFixture } from './publication.ts'
import { remoteFixture } from './remote.ts'
import { startRuntime, type Host } from './host.ts'
import { workerSessionId } from '../../src/executor/dsh.ts'

/** Owned Runtime, managed execution world and independent publication service, with local provider HTTP only. */
export async function channelPublicationFixture(cleanup: (() => Promise<unknown>)[]) {
  const authority = await ownershipAuthority(cleanup, ['endpoint', 'publication'])
  const publisher = await publicationFixture(cleanup, authority.resourceFor('publication'))
  let host: Host
  const remote = await remoteFixture(cleanup, { native: process.env.DSH_REMOTE_ISOLATION === '1', ownership: authority.resourceFor('endpoint'),
    access: { authorityId: authority.config.authorityId, coordinatorId: 'coordinator', proof: () => host.runtime.ownership!.proof() },
    beforeEnroll: async () => {
      host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true, managed: true, ownership: authority.config, publication: publisher.connection })
      cleanup.push(() => host.stop())
    } })
  if (process.env.DSH_REMOTE_ISOLATION !== '1') vi.spyOn(remote.endpoint, 'identity').mockReturnValue({ ...remote.endpoint.identity(), confinement: 'linux-bubblewrap' })
  const runtime = host!.runtime
  const endpoint = await runtime.endpoints.register({ requestId: randomUUID(), endpointId: remote.endpoint.journal.id, url: remote.url,
    credentialFile: remote.connection.credentialFile, revision: 0, name: 'Delivery execution endpoint' })
  const command = await runtime.endpoints.submit(endpoint.id, { revision: endpoint.revision, request: { op: 'grant.create', requestId: randomUUID(),
    owner: 'coordinator', workspace: 'delivery', operations: ['fs.read', 'fs.write', 'process.spawn'], leaseMs: 300_000 } })
  const world = await runtime.worlds.activate({ requestId: randomUUID(), endpointId: endpoint.id, commandId: command.id, name: 'Delivery world' })
  if (!world.ready) throw new Error(world.problem)
  let mission = runtime.workspace.create({ requestId: randomUUID(), title: 'Publish mission replies', objective: 'Deliver an authorized result', acceptance: 'Original receipt retained' })
  mission = runtime.workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Produce result', instructions: 'Prepare the result', owner: 'agent', environment: world.id })
  const destination = (await runtime.publications.destinations()).items[0]!
  const configure = { requestId: randomUUID(), revision: 0, missionRevision: mission.revision, enabled: true, destination: destination.id, destinationHash: destination.hash }
  const run = async () => {
    mission = runtime.workspace.act(mission.id, mission.actions[0]!.id, { requestId: randomUUID(), revision: runtime.workspace.get(mission.id).revision, command: 'run' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get(mission.actions[0]!.runs[0]!)!
    return { ticket, sessionId: workerSessionId(ticket.id), trigger: runtime.store.triggers.get(ticket.origin.triggerId)! }
  }
  return { authority, publisher, remote, host: host!, mission, destination, configure, run }
}
