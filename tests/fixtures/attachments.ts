/** Attachment API double; installed-Harness qualification exercises the real normalization/storage backend. */
import { createHash } from 'node:crypto'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef, SaveFileStreamAttachment, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
export function attachmentBackend() {
  const files = new Map<string, Buffer>(), images = new Map<string, Buffer>()
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const backend = {
    imageLimits: { maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 8, maxMessageImageBytes: 16 * 1024 * 1024, maxImagePixels: 40000000, maxImageDimension: 16384, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
      const chunks: Buffer[] = []; for await (const chunk of input.data) { input.signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)) }
      const data = Buffer.concat(chunks), id = hash(data); files.set(id, data)
      return { attachmentId: `sha256:${id}` as FileAttachmentRef['attachmentId'], name: input.name ?? 'file', bytes: data.length }
    },
    async *readFileStream(ref: FileAttachmentRef) {
      const data = files.get(ref.attachmentId.replace(/^sha256:/, '')); if (!data) throw new Error('Fixture file missing')
      yield data
    },
    async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
      if (input.mediaType !== 'image/png' || Buffer.from(input.data).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid fixture image')
      const data = Buffer.from(input.data), id = hash(data); images.set(id, data)
      return { attachmentId: id as ImageAttachmentRef['attachmentId'], bytes: data.length, mediaType: input.mediaType, width: 1, height: 1, name: input.name }
    },
    async readImage(ref: ImageAttachmentRef) { const data = images.get(ref.attachmentId); if (!data) throw new Error('Image missing'); return { ref, data } },
  } as unknown as AttachmentStore
  return { backend, files, images }
}
