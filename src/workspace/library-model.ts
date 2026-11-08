/** Immutable knowledge/artifact contracts. Scope and provenance are assigned by the host, never by a worker. */
import { z } from 'zod'

export const LIBRARY_MAX_BYTES = 512 * 1024
export const LibraryScope = z.string().regex(/^(workspace|(?:mission|ticket):[A-Za-z0-9_-]{1,100})$/)
export const LibraryId = z.string().uuid()
export const LibraryKind = z.enum(['memory', 'artifact'])
export const LibraryRelation = z.enum(['derived_from', 'supersedes', 'supports', 'contradicts', 'references'])
export const PublishRecord = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), kind: LibraryKind,
  title: z.string().trim().min(1).max(160), summary: z.string().trim().min(1).max(500),
  mime: z.enum(['text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/json',
    'image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/octet-stream']).default('text/markdown'),
  filename: z.string().regex(/^[^/\\\x00-\x1f\x7f]{1,160}$/).refine(value => value !== '.' && value !== '..').default('document.md'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'), content: z.string().min(1).max(Math.ceil(LIBRARY_MAX_BYTES / 3) * 4),
  expiresAt: z.string().datetime().optional(),
  sources: z.array(z.object({ id: LibraryId, relation: LibraryRelation }).strict()).max(20).default([]),
}).strict()
export const CreateRecord = PublishRecord.extend({ scope: LibraryScope.default('workspace') }).strict()
export const LibraryQuery = z.object({
  q: z.string().trim().max(256).default(''), kind: LibraryKind.optional(), scope: LibraryScope.optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(50).default(20),
  includeInactive: z.enum(['true', 'false']).default('false'),
}).strict()
export const LibraryPage = z.object({ offset: z.coerce.number().int().min(0).max(LIBRARY_MAX_BYTES).default(0),
  limit: z.coerce.number().int().min(1).max(8000).default(4000) }).strict()
export const ArchiveRecord = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  revision: z.number().int().positive(), archived: z.boolean() }).strict()
export type PublishRecordInput = z.input<typeof PublishRecord>
export type CreateRecordInput = z.input<typeof CreateRecord>
export type LibraryQueryInput = z.input<typeof LibraryQuery>
export type ArchiveRecordInput = z.input<typeof ArchiveRecord>
export type LibraryActor = { role: 'operator' } | { role: 'router' } | { role: 'worker'; ticketId: string }
export interface LibraryRecord {
  id: string; kind: 'memory' | 'artifact'; scope: string; title: string; summary: string; mime: string; filename: string
  hash: string; bytes: number; createdAt: string; expiresAt?: string; text: boolean
  provenance: { actor: 'operator' | 'worker'; trust: 'operator_submission' | 'agent_submission'; ticketId?: string
    sessionId?: string; assignmentId?: string; triggerId?: string; triggerHash?: string }
  sources: { id: string; relation: z.infer<typeof LibraryRelation>; hash: string }[]
}
export interface LibraryEntry extends LibraryRecord {
  revision: number; archived: boolean; expired: boolean; superseded: boolean; conflicted: boolean
  verification: 'not_verified'
  staleSources: string[]
}
export interface LibraryList { items: LibraryEntry[]; nextOffset: number | null }
export interface LibraryRead extends LibraryEntry {
  content: string | null; nextOffset: number | null; totalChars: number | null
  incoming: { id: string; relation: z.infer<typeof LibraryRelation>; hash: string }[]; incomingTruncated: boolean
  contextOnly: true
}
export interface LibraryContent { data: string; encoding: 'base64'; hash: string; mime: string; filename: string }
