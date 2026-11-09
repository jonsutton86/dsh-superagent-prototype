/** Operator-authored recurring mission definitions and durable occurrence records. */
import { z } from 'zod'
import { PlanDefinition } from './plan-model.ts'
import { ReflectionSpec } from './reflection-model.ts'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
const instant = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString())
export const Cadence = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instant }).strict(),
  z.object({ kind: z.literal('interval'), start: instant, everyMinutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ kind: z.literal('calendar'), timeZone: z.string().min(1).max(100), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    startDate: z.iso.date(), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
      .refine(value => new Set(value).size === value.length, 'Weekdays must be unique') }).strict(),
])
export type Cadence = z.infer<typeof Cadence>
export const ScheduleDefinition = z.object({ title: z.string().trim().min(1).max(160), cadence: Cadence,
  plan: PlanDefinition.refine(plan => plan.actions.length > 0, 'Add at least one action'),
  missed: z.enum(['skip', 'latest', 'all']), graceSeconds: z.number().int().min(1).max(3600).default(60),
  maxRuns: z.number().int().min(1).max(10000), maxOpen: z.number().int().min(1).max(20), reflection: ReflectionSpec.optional() }).strict()
export const CreateSchedule = z.object({ requestId: id, definition: ScheduleDefinition, enabled: z.boolean() }).strict()
export const SaveSchedule = CreateSchedule.extend({ revision: z.number().int().positive() })
export const ToggleSchedule = z.object({ requestId: id, revision: z.number().int().positive(), enabled: z.boolean() }).strict()
export const RetryOccurrence = z.object({ requestId: id }).strict()
export type ScheduleDefinition = z.infer<typeof ScheduleDefinition>
export type CreateScheduleInput = z.input<typeof CreateSchedule>
export type SaveScheduleInput = z.input<typeof SaveSchedule>
export type ToggleScheduleInput = z.input<typeof ToggleSchedule>
export interface ScheduleOrigin { id: string; revision: number; occurrence: string; due: string }
export interface Schedule {
  id: string; revision: number; definition: ScheduleDefinition; enabled: boolean; runs: number
  nextAt?: string; createdAt: string; updatedAt: string
}
export interface ScheduleOccurrence {
  id: string; scheduleId: string; revision: number; due: string; through?: string; createdAt: string
  state: 'active' | 'blocked' | 'complete' | 'archived' | 'skipped'; missionId?: string; error?: string
}
export type ScheduleSummary = Pick<Schedule, 'id' | 'revision' | 'enabled' | 'runs' | 'nextAt'> & {
  title: string; maxRuns: number; maxOpen: number; open: number
}
export interface ScheduleList { items: ScheduleSummary[]; nextOffset: number | null }
export interface ScheduleView extends Schedule { open: number; occurrences: ScheduleOccurrence[]; nextOffset: number | null }
