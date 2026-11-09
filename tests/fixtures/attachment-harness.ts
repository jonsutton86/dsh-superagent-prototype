/** Actual installed-Harness input delivery, byte verification and recovery checks. No vision-model claim. */
import { createHash, randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
type Api = (path: string, body?: unknown) => Promise<any>
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
export const attachmentInstructions = 'First report blocked with summary "Waiting for CSV input" and ask the operator to attach evidence.csv, then end your turn. Once the operator supplies the file, list inputs with workspace_attachments and copy evidence.csv with workspace_attachment_copy. Use bash to read that copied CSV, sum the numeric value column, and verify the sum is exactly 42. The attached pixel.png is a storage/recovery fixture; this text-only model is not asked to inspect it. After the CSV check succeeds, continue the following mission instructions: '
export async function qualifyAttachments(api: Api, port: number, task: string): Promise<() => Promise<void>> {
  await vi.waitFor(async () => expect((await api(`inbox/${task}`)).item.status).toBe('blocked'), { timeout: 60000, interval: 500 })
  expect((await api('uploads')).available).toBe(true)
  const sources = [
    { name: 'evidence.csv', mediaType: 'text/csv', bytes: Buffer.from('name,value\nalpha,11\nbeta,31\n') },
    { name: 'pixel.png', mediaType: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISJyQkSEAUIBAB0eA8HLJ80gAAAAAElFTkSuQmCC', 'base64') },
  ]
  const ids: string[] = []
  for (const source of sources) {
    const id = randomUUID(), body = { requestId: id, name: source.name, bytes: source.bytes.length, mediaType: source.mediaType, sha256: sha(source.bytes) }
    await api('uploads', body); const chunk = { offset: 0, data: source.bytes.toString('base64') }
    await api(`uploads/${id}/chunks`, chunk); await api(`uploads/${id}/chunks`, chunk)
    expect((await api(`uploads/${id}/finish`)).phase).toBe('ready'); expect((await api('uploads', body)).phase).toBe('ready'); ids.push(id)
  }
  const view = await api(`inbox/${task}`), body = { requestId: randomUUID(), revision: view.item.revision,
    text: 'The requested evidence.csv and pixel.png are attached. Copy the CSV, verify the value sum is 42, then continue the original mission.', attachments: ids }
  await api(`inbox/${task}/reply`, body); await api(`inbox/${task}/reply`, body)
  const raw = async (id: string, suffix: string) => {
    const response = await fetch(`http://127.0.0.1:${port}/orchestrator/api/uploads/${id}/${suffix}`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(5000) })
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    return Buffer.from(await response.arrayBuffer())
  }
  const normalized = await raw(ids[1]!, 'image')
  return async () => {
    const conversation = await api(`inbox/${task}`), messages = conversation.messages.filter((message: any) => message.text === body.text)
    expect(messages).toHaveLength(1); expect(messages[0].attachments.map((item: any) => item.id)).toEqual(ids)
    for (let i = 0; i < ids.length; i++) expect(await raw(ids[i]!, 'download')).toEqual(sources[i]!.bytes)
    expect(await raw(ids[1]!, 'image')).toEqual(normalized)
  }
}
