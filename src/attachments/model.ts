/** Operator upload and task attachment contracts. Uploaded content is data, never an execution grant. */
import { z } from 'zod'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export const UPLOAD_LIMITS = { fileBytes: 64 * 1024 * 1024, chunkBytes: 256 * 1024, pendingBytes: 256 * 1024 * 1024, pendingCount: 64,
  perMessage: 8, messageBytes: 128 * 1024 * 1024, textBytes: 48 * 1024, pendingMs: 24 * 60 * 60000 } as const
export const AttachmentIds = z.array(z.string().uuid()).max(UPLOAD_LIMITS.perMessage).refine(ids => new Set(ids).size === ids.length, 'Duplicate attachment')
export const BeginUpload = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(200)
  .refine(name => !/[\\/\u0000-\u001f\u007f]/.test(name) && name !== '.' && name !== '..', 'Use a filename without paths or control characters'),
  bytes: z.number().int().min(0).max(UPLOAD_LIMITS.fileBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mediaType: z.string().max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/).default('application/octet-stream') }).strict()
export type BeginUploadInput = z.input<typeof BeginUpload>
export const UploadChunk = z.object({ offset: z.number().int().min(0), data: z.string().min(4)
  .max(Math.ceil(UPLOAD_LIMITS.chunkBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict()
export type UploadChunkInput = z.input<typeof UploadChunk>
export interface AttachmentView { id: string; name: string; bytes: number; sha256: string; mediaType: string; image: boolean }
export interface UploadView extends AttachmentView { phase: 'receiving' | 'ready' | 'cancelled' | 'expired'; received: number; createdAt: number; bound: boolean }
export interface UploadRecord extends Omit<UploadView, 'bound' | 'image'> { fingerprint: string; file?: FileAttachmentRef; image?: ImageAttachmentRef }
export interface AttachmentCapabilities { available: boolean; fileBytes: number; chunkBytes: number; perMessage: number; messageBytes: number }
export const ReadAttachment = z.object({ id: z.string().uuid(), offset: z.number().int().min(0).default(0),
  format: z.enum(['text', 'base64', 'image']).default('text') }).strict()
/** Safe management/API refusal without host paths or provider diagnostics. */
export class UploadError extends Error { constructor(readonly status: 400 | 404 | 409 | 413 | 503, message: string) { super(message) } }
