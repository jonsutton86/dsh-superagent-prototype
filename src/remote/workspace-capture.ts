/** Host capture intents share the endpoint's single-writer database. No implicit retry after response loss. */
import { z } from 'zod'
import { fingerprint, type RemoteJournal } from './journal.ts'
import { RemoteError } from './protocol.ts'
const path = z.string().max(4096).startsWith('/').refine(value => !value.includes('\0'))
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const WorkspaceCaptureRequest = z.object({ requestId: z.string().uuid(), grantId: z.string().uuid(), epoch: z.number().int().positive(),
  destination: path, maxEntries: z.number().int().min(1).max(100000), maxBytes: z.number().int().min(0).max(2 ** 40) }).strict()
export const WorkspaceCaptureBinding = z.object({ endpointId: z.string().uuid(), grantId: z.string().uuid(), epoch: z.number().int().positive(),
  revision: z.number().int().positive(), workspace: z.string(), root: path, rootIdentity: z.string(),
  storage: z.object({ requestId: z.string(), projectId: z.number().int().positive(), policyHash: hash }).strict().optional() }).strict()
const result = z.object({ path, inventoryHash: hash, manifestHash: hash, reconciled: z.literal(true).optional(), managedQuiescenceObserved: z.literal(true),
  globalSnapshotVerified: z.literal(false), restoreVerified: z.literal(false) }).strict()
export const WorkspaceCaptureRecordSchema = z.object({ version: z.literal(1), request: WorkspaceCaptureRequest, requestHash: hash, binding: WorkspaceCaptureBinding,
  phase: z.enum(['started', 'complete']), startedAt: z.string().datetime(), completedAt: z.string().datetime().optional(), result: result.optional() }).strict()
  .refine(value => value.phase === 'complete' ? !!value.result && !!value.completedAt : !value.result && !value.completedAt)
export type WorkspaceCaptureRecord = z.infer<typeof WorkspaceCaptureRecordSchema>
const prefix = 'workspace-capture:'
export class WorkspaceCaptures {
  constructor(private readonly journal: RemoteJournal) {}
  read(input: z.input<typeof WorkspaceCaptureRequest>): WorkspaceCaptureRecord | undefined {
    const request = WorkspaceCaptureRequest.parse(input)
    const row = this.journal.db.prepare('SELECT value FROM endpoint_meta WHERE key=?').get(prefix + request.requestId)
    if (!row) return
    const saved = WorkspaceCaptureRecordSchema.parse(JSON.parse(String(row.value)))
    if (saved.request.requestId !== request.requestId || saved.binding.endpointId !== this.journal.id
      || saved.binding.grantId !== saved.request.grantId || saved.binding.epoch !== saved.request.epoch
      || saved.requestHash !== fingerprint(saved.request)) throw new Error('Workspace capture record identity differs')
    if (saved.requestHash !== fingerprint(request)) throw new RemoteError(409, 'request_conflict', 'Capture request ID already used with another payload')
    return saved
  }
  begin(input: z.input<typeof WorkspaceCaptureRequest>, binding: z.input<typeof WorkspaceCaptureBinding>) {
    const request = WorkspaceCaptureRequest.parse(input)
    return this.journal.atomic(() => {
      const prior = this.read(request); if (prior) return prior
      const count = Number(this.journal.db.prepare('SELECT count(*) AS n FROM endpoint_meta WHERE key LIKE ?').get(prefix + '%')!.n)
      if (count >= 256) throw new RemoteError(429, 'capture_capacity', 'Retained capture capacity requires operator review')
      const value = WorkspaceCaptureRecordSchema.parse({ version: 1, request, requestHash: fingerprint(request), binding, phase: 'started', startedAt: new Date().toISOString() })
      if (value.binding.endpointId !== this.journal.id || value.binding.grantId !== request.grantId || value.binding.epoch !== request.epoch)
        throw new Error('Workspace capture binding differs from request')
      this.journal.db.prepare('INSERT INTO endpoint_meta VALUES (?,?)').run(prefix + request.requestId, JSON.stringify(value))
      return value
    })
  }
  complete(input: z.input<typeof WorkspaceCaptureRequest>, output: z.input<typeof result>) {
    return this.journal.atomic(() => {
      const prior = this.read(input)
      if (!prior || prior.phase !== 'started') throw new Error('Workspace capture requires its original started intent')
      const value = WorkspaceCaptureRecordSchema.parse({ ...prior, phase: 'complete', completedAt: new Date().toISOString(), result: output })
      this.journal.db.prepare('UPDATE endpoint_meta SET value=? WHERE key=?').run(JSON.stringify(value), prefix + prior.request.requestId)
      return value
    })
  }
}
