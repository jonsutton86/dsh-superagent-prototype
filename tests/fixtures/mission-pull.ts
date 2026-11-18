import { randomUUID } from 'node:crypto'
import { pullReviewFixture } from './pull-review.ts'
import { Workspace } from '../../src/workspace/service.ts'
import { MissionPulls } from '../../src/workspace/pulls.ts'
import { MissionReviews } from '../../src/verification/missions.ts'

/** Mission commands, real Git bytes/check processes and an independently fenced local GitHub contract provider. */
export async function missionPullFixture(cleanup: (() => Promise<unknown>)[], native = false) {
  const h = await pullReviewFixture(cleanup, 'APPROVE', native), pulls = new MissionPulls(h.store, h.publications)
  const reviews = new MissionReviews(h.store, h.library, h.verification, h.reviews)
  const reopenWorkspace = (review = reviews) => new Workspace(h.store, () => h.engine, () => true, id => h.library.evidenceRevision(id), undefined, undefined, undefined, undefined, review, pulls)
  const workspace = reopenWorkspace(); cleanup.push(async () => { await pulls.stop(); await workspace.completions.stop() })
  let mission = workspace.create({ requestId: randomUUID(), title: 'Verified PR delivery', objective: 'Deliver the current checked PR head', acceptance: 'All accepted inputs and the PR head are freshly verified at completion' })
  mission = workspace.add(mission.id, { requestId: randomUUID(), revision: mission.revision, title: 'Final repository result', owner: 'agent', instructions: 'Validate the required PR result' })
  const actionId = mission.actions[0]!.id, bind = { requestId: randomUUID(), revision: mission.revision, enabled: true as const,
    destination: h.destination.id, destinationHash: h.destination.hash, pullHash: h.pull.hash }
  mission = await workspace.configurePull(mission.id, actionId, bind)
  const bound = mission
  mission = workspace.act(mission.id, actionId, { requestId: randomUUID(), revision: mission.revision, command: 'run' })
  const ticket = h.store.tickets.get(mission.actions[0]!.ticket!.id)!
  h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id)
  const artifact = h.library.publish({ requestId: randomUUID(), kind: 'artifact', title: 'PR result', summary: 'Actual checked result', filename: 'artifact.txt', content: 'evidence' },
    { role: 'worker', ticketId: ticket.id })
  const checked = await h.check(artifact)
  h.engine.report(ticket.id, { state: 'ready', summary: 'PR result ready for checked review' })
  const result = workspace.get(mission.id), action = result.actions[0]!
  const accept = { requestId: randomUUID(), revision: result.revision, command: 'complete' as const, text: 'Reviewed the exact required PR head and original files',
    ticketRevision: action.ticket!.revision, reviewKind: 'checks' as const, checks: [checked.selection], pullHash: h.pull.hash }
  return { ...h, pulls, workspace, reopenWorkspace, mission: result, action, artifact, checked, ticket, bind, bound, accept }
}
