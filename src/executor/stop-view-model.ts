/** Bounded presentation of durable original-stop holds. No process observation or execution authority. */
import { z } from 'zod'
import { StopProof, StopScope, StopState } from './stop-model.ts'

export const STOP_HOLD_SAMPLE = 4
export const StopHoldViewSchema = z.object({
  held: z.literal(true), count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  pendingAssignmentId: z.string().min(1).max(200).nullable(), pendingInputs: z.number().int().nonnegative(),
  originals: z.array(z.object({ id: z.string().min(1).max(200), assignmentId: z.string().min(1).max(200),
    revision: z.number().int().positive(), scope: StopScope, state: StopState, proof: StopProof.nullable(), legacy: z.boolean() }).strict()).min(1).max(STOP_HOLD_SAMPLE),
  truncated: z.boolean(),
}).strict().superRefine((hold, ctx) => {
  if (hold.count < hold.originals.length || hold.truncated !== (hold.count > hold.originals.length)
    || new Set(hold.originals.map(original => original.id)).size !== hold.originals.length
    || hold.originals.some(original => ['quiet', 'dormant'].includes(original.state) || original.proof !== null
      || original.legacy !== (original.scope === 'legacy')))
    ctx.addIssue({ code: 'custom', message: 'Inconsistent original stop hold summary' })
})
export type StopHoldView = z.infer<typeof StopHoldViewSchema>
