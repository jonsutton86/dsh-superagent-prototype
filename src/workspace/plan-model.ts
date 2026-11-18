/** Versioned mission definitions and reviewable proposals. These contracts never dispatch work. */
import { z } from 'zod'
import type { Mission } from './model.ts'
import { PersonaRef } from '../personas/model.ts'
import { WorldRef } from '../environments/pool-model.ts'
import { PullTargetRef } from './pull-model.ts'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const text = z.string().trim().min(1).max(12000)
const title = z.string().trim().min(1).max(160)
export const PlanDefinition = z.object({ title, objective: text, acceptance: text,
  actions: z.array(z.object({ id, title, instructions: text, owner: z.enum(['person', 'agent']),
    dependsOn: z.array(id).max(200), persona: PersonaRef.optional(), environment: WorldRef.optional(), pull: PullTargetRef.optional() }).strict()).max(200) }).strict().superRefine((plan, ctx) => {
  const actions = new Map(plan.actions.map(action => [action.id, action]))
  const error = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (actions.size !== plan.actions.length) error('Action IDs must be unique')
  if (plan.actions.some(action => action.owner === 'person' && (action.persona || action.environment || action.pull))) error('Only agent actions can select a persona, execution environment or PR target')
  if (JSON.stringify(plan).length > 128000) error('A plan must fit within 128,000 characters')
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    const action = actions.get(id)
    if (!action) return false
    visiting.add(id)
    if (new Set(action.dependsOn).size !== action.dependsOn.length || action.dependsOn.some(dependency => !visit(dependency))) return false
    visiting.delete(id); visited.add(id); return true
  }
  if (plan.actions.some(action => !visit(action.id))) error('Dependencies must exist, be unique, and contain no cycle')
})
export const ProposePlan = z.object({ requestId: id, baseVersion: z.number().int().positive(),
  rationale: text, plan: PlanDefinition }).strict()
export const ReviewPlan = z.object({ requestId: id, revision: z.number().int().positive(),
  missionRevision: z.number().int().positive(), decision: z.enum(['approve', 'reject']), note: text }).strict()
export const RequestPlan = z.object({ requestId: id, revision: z.number().int().positive(),
  instructions: z.string().trim().max(10000).default('') }).strict()
export type PlanDefinition = z.infer<typeof PlanDefinition>
export type ProposePlanInput = z.input<typeof ProposePlan>
export type ReviewPlanInput = z.input<typeof ReviewPlan>
export type RequestPlanInput = z.input<typeof RequestPlan>
export type PlanAuthor = { role: 'operator' } | { role: 'worker'; ticketId: string; sessionId: string }
export interface PlanVersion { version: number; at: string; reason: string; proposalId?: string; plan: PlanDefinition;
  /** Host-captured action authority at this immutable plan version; absent in older snapshots. */
  authority?: { actionId: string; definitionRevision: number }[] }
export interface PlanProposal {
  id: string; missionId: string; baseVersion: number; rationale: string; plan: PlanDefinition; author: PlanAuthor
  createdAt: string; revision: number; status: 'pending' | 'approved' | 'rejected'
  review?: { at: string; note: string; version?: number }
}
export interface PlanIndex {
  currentVersion: number; versions: Omit<PlanVersion, 'plan'>[]
  proposals: Omit<PlanProposal, 'plan'>[]; nextOffset: number | null
}
export const definitionOf = (mission: Pick<Mission, 'title' | 'objective' | 'acceptance' | 'actions'>): PlanDefinition => ({
  title: mission.title, objective: mission.objective, acceptance: mission.acceptance,
  actions: mission.actions.map(({ id, title, instructions, owner, dependsOn, persona, environment, pull }) => ({ id, title, instructions, owner, dependsOn,
    ...(persona ? { persona } : {}), ...(environment ? { environment } : {}), ...(pull ? { pull } : {}) })),
})
