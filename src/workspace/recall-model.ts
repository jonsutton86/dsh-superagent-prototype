import { z } from 'zod'
import { LibraryId, LibraryPage } from './library-model.ts'

const integer = (min: number, max: number) => z.number().int().min(min).max(max)
export const RecallLimits = z.object({ calls: integer(1, 10000), pages: integer(1, 100000), bytes: integer(4096, 64 * 1024 * 1024),
  nodes: integer(1, 1000000), millis: integer(1, 600000) }).strict()
export const RecallPolicy = z.object({ owner: RecallLimits, run: RecallLimits.omit({ calls: true }).extend({
  pages: integer(1, 20), bytes: integer(4096, 256 * 1024), nodes: integer(1, 4096), millis: integer(1, 1000), depth: integer(0, 8) }).strict() }).strict()
export const SaveRecall = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), revision: integer(0, Number.MAX_SAFE_INTEGER), policy: RecallPolicy }).strict()
export const RecallRead = LibraryPage.extend({ id: LibraryId, depth: integer(0, 8).default(2) }).strict()
export type RecallPolicy = z.infer<typeof RecallPolicy>
export type SaveRecallInput = z.input<typeof SaveRecall>
export interface RecallOwner { id: string; role: 'worker' | 'router'; ticketId?: string; assignmentId?: string; day?: string }
export interface RecallMetrics { calls: number; pages: number; bytes: number; nodes: number; millis: number }
export interface RecallAttempt { id: string; owner: RecallOwner; at: string; revision: number; operation: 'search' | 'read';
  phase: 'reserved' | 'complete' | 'failed'; charged: RecallMetrics; reserved: RecallMetrics; truncated?: boolean }
export interface RecallConfiguration { revision: number; at: string; policy: RecallPolicy }
export interface RecallState { configuration: RecallConfiguration; attempts: RecallAttempt[]; nextOffset: number | null }
export interface RecallReceipt { owner: RecallOwner; charged: RecallMetrics; remaining: RecallMetrics; truncated: boolean }
export const DEFAULT_RECALL: RecallPolicy = { owner: { calls: 100, pages: 200, bytes: 1024 * 1024, nodes: 20000, millis: 20000 },
  run: { pages: 5, bytes: 65536, nodes: 512, millis: 100, depth: 2 } }
