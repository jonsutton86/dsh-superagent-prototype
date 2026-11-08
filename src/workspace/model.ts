/** Persistent personal workspace contracts. Execution remains owned by the domain Engine and Harness. */
import { z } from 'zod'
import { PersonaRef } from '../personas/model.ts'
import { WorldRef } from '../environments/pool-model.ts'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const title = z.string().trim().min(1).max(160)
const text = z.string().trim().min(1).max(12000)
export const CreateMission = z.object({ requestId: id, title, objective: text, acceptance: text }).strict()
export const AddAction = z.object({ requestId: id, revision: z.number().int().positive(), title,
  instructions: text, owner: z.enum(['person', 'agent']), dependsOn: z.array(id).max(200).default([]), persona: PersonaRef.optional(), environment: WorldRef.optional() }).strict()
  .refine(value => value.owner === 'agent' || !value.persona && !value.environment, 'Only agent actions can select a persona or execution environment')
export const ActionCommand = z.object({ requestId: id, revision: z.number().int().positive(),
  command: z.enum(['run', 'complete', 'retry', 'stop', 'steer']), text: z.string().trim().max(12000).default(''),
  ticketRevision: z.string().max(100).optional() }).strict()
export const MissionCommand = z.object({ requestId: id, revision: z.number().int().positive(),
  status: z.enum(['active', 'completed', 'archived']) }).strict()
export type CreateMissionInput = z.input<typeof CreateMission>
export type AddActionInput = z.input<typeof AddAction>
export type ActionCommandInput = z.input<typeof ActionCommand>
export type MissionCommandInput = z.input<typeof MissionCommand>

export interface MissionAction {
  id: string; title: string; instructions: string; owner: 'person' | 'agent'; dependsOn: string[]; runs: string[]
  persona?: PersonaRef
  environment?: string
  dependencyRevision?: string
  definitionRevision?: number
  executionRevision?: number
  accepted?: { at: string; note: string; ticketRevision?: string }
}
export interface Mission {
  id: string; title: string; objective: string; acceptance: string; status: 'active' | 'completed' | 'archived'
  revision: number; planVersion: number; createdAt: string; updatedAt: string; actions: MissionAction[]
}
export interface MissionEvent { id: number; at: string; kind: string; actionId?: string; text: string }
export interface ActionView extends MissionAction {
  status: 'todo' | 'waiting' | 'working' | 'blocked' | 'review' | 'stopped' | 'done' | 'outdated'
  ticket?: { id: string; revision: string; sessionId?: string; summary: string; retryable: boolean; stoppable: boolean; ended: boolean; currentDefinition: boolean }
}
export interface MissionView extends Omit<Mission, 'actions'> {
  actions: ActionView[]; events: MissionEvent[]; completed: number; needsReview: boolean
}
export interface MissionList {
  items: (Pick<Mission, 'id' | 'title' | 'objective' | 'status' | 'updatedAt'> & { completed: number; total: number; needsReview: boolean })[]
  nextOffset: number | null
}

/** A bounded, user-actionable workspace refusal serialized by the management API. */
export class WorkspaceError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
