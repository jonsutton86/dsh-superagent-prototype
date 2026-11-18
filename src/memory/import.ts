/** Opt-in import of operator-provided exports and documents. Consent is required; PDF extraction is not offered here. */
import { z } from 'zod'
import { MemoryError, MemoryScope, type Memory, type MemoryAccess } from './service.ts'

export const ImportFormat = z.enum(['markdown', 'text', 'chatgpt', 'claude', 'codex-jsonl'])
export type ImportFormat = z.infer<typeof ImportFormat>

export const ImportInputSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  format: ImportFormat,
  /** The export or document text exactly as the operator provided it; no path is accepted. */
  content: z.string().min(1).max(1_000_000),
  scope: MemoryScope,
  /** Explicit opt-in: importing personal data requires a literal true. */
  consent: z.literal(true),
  title: z.string().trim().max(200).optional(),
  sourceRef: z.string().trim().max(500).optional(),
  sensitivity: z.enum(['normal', 'private']).default('private'),
}).strict()
export type ImportInput = z.input<typeof ImportInputSchema>

interface ParsedItem { title: string; kind: 'document' | 'conversation'; text: string }
const MAX_ITEMS = 200, CHUNK = 8000

const linesOf = (turns: { role: string; text: string }[]): string => turns
  .filter(turn => turn.text.trim()).map(turn => `${turn.role}: ${turn.text.trim()}`).join('\n\n')

function parseJson(content: string, format: string): unknown {
  try { return JSON.parse(content) as unknown }
  catch { throw new MemoryError(400, `${format} import content is not valid JSON`) }
}
const arrayOf = (value: unknown, key: string, format: string): unknown[] => {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)[key]))
    return (value as Record<string, unknown[]>)[key]!
  throw new MemoryError(400, `${format} import must be a JSON array or an object with ${key}`)
}
const textOf = (value: unknown): string => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : textOf((part as Record<string, unknown>)?.text)).join('')
    : value && typeof value === 'object' ? textOf((value as Record<string, unknown>).text) : ''

function chatgpt(value: unknown): ParsedItem[] {
  return arrayOf(value, 'conversations', 'ChatGPT').map((raw, index) => {
    const conversation = (raw ?? {}) as Record<string, unknown>
    const title = typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title.trim() : `ChatGPT conversation ${index + 1}`
    const turns: { role: string; text: string }[] = []
    const mapping = conversation.mapping
    if (mapping && typeof mapping === 'object') {
      for (const node of Object.values(mapping as Record<string, unknown>)) {
        const message = (node as Record<string, unknown>)?.message as Record<string, unknown> | undefined
        if (!message) continue
        const author = (message.author ?? {}) as Record<string, unknown>
        const content = (message.content ?? {}) as Record<string, unknown>
        turns.push({ role: typeof author.role === 'string' ? author.role : 'unknown', text: textOf(content.parts ?? content.text) })
      }
    } else if (Array.isArray(conversation.messages)) {
      for (const rawMessage of conversation.messages as unknown[]) {
        const message = (rawMessage ?? {}) as Record<string, unknown>
        turns.push({ role: typeof message.role === 'string' ? message.role : 'unknown', text: textOf(message.content) })
      }
    }
    return { title, kind: 'conversation' as const, text: linesOf(turns) }
  }).filter(item => item.text.trim())
}

function claude(value: unknown): ParsedItem[] {
  return arrayOf(value, 'conversations', 'Claude').map((raw, index) => {
    const conversation = (raw ?? {}) as Record<string, unknown>
    const title = typeof conversation.name === 'string' && conversation.name.trim() ? conversation.name.trim()
      : typeof conversation.title === 'string' && conversation.title.trim() ? conversation.title.trim() : `Claude conversation ${index + 1}`
    const messages = Array.isArray(conversation.chat_messages) ? conversation.chat_messages
      : Array.isArray(conversation.messages) ? conversation.messages : []
    const turns = (messages as unknown[]).map(rawMessage => {
      const message = (rawMessage ?? {}) as Record<string, unknown>
      return { role: typeof message.sender === 'string' ? message.sender : typeof message.role === 'string' ? message.role : 'unknown',
        text: textOf(message.text ?? message.content) }
    })
    return { title, kind: 'conversation' as const, text: linesOf(turns) }
  }).filter(item => item.text.trim())
}

function codex(value: string): ParsedItem[] {
  const turns: { role: string; text: string }[] = []
  for (const line of value.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try { record = JSON.parse(line) as Record<string, unknown> }
    catch { throw new MemoryError(400, 'Codex JSONL import contains an invalid line') }
    const payload = (record.payload ?? {}) as Record<string, unknown>
    const role = typeof record.role === 'string' ? record.role : typeof payload.role === 'string' ? payload.role : ''
    const text = textOf(record.content ?? payload.content ?? record.text ?? payload.text)
    if (role && text.trim()) turns.push({ role, text })
  }
  const body = linesOf(turns)
  return body.trim() ? [{ title: 'Codex session', kind: 'conversation', text: body }] : []
}

/** Parses one operator-provided export; throws MemoryError(400) for malformed content or an unsupported shape. */
export function parseImport(format: ImportFormat, content: string, title?: string): ParsedItem[] {
  if (format === 'markdown' || format === 'text') return [{ title: title ?? 'Imported document', kind: 'document', text: content }]
  if (format === 'chatgpt') return chatgpt(parseJson(content, 'ChatGPT'))
  if (format === 'claude') return claude(parseJson(content, 'Claude'))
  return codex(content)
}

/** Splits text into bounded chunks on paragraph/line boundaries without losing characters. */
export function chunkText(text: string, limit = CHUNK): string[] {
  const chunks: string[] = []
  let current = ''
  for (const part of text.split(/(?<=\n)/)) {
    if (part.length > limit) {
      if (current) { chunks.push(current); current = '' }
      for (let index = 0; index < part.length; index += limit) chunks.push(part.slice(index, index + limit))
      continue
    }
    if (current.length + part.length > limit) { chunks.push(current); current = '' }
    current += part
  }
  if (current) chunks.push(current)
  return chunks.filter(chunk => chunk.trim())
}

/** Writes parsed items with provenance; identical content deduplicates and the count is audited, never the content. */
export function importMemory(memory: Memory, access: MemoryAccess, input: ImportInput, actor = 'operator'):
  { imported: number; skipped: number; records: string[] } {
  const value = ImportInputSchema.parse(input)
  const parsed = parseImport(value.format, value.content, value.title)
  if (!parsed.length) throw new MemoryError(400, 'The import contained no readable messages or text')
  const records: string[] = []
  let imported = 0, skipped = 0
  for (const item of parsed.slice(0, MAX_ITEMS)) {
    const chunks = chunkText(item.text)
    if (!chunks.length) continue
    for (const [index, chunk] of chunks.entries()) {
      const subject = chunks.length > 1 ? `${item.title} (${index + 1}/${chunks.length})` : item.title
      const saved = memory.save(access, { kind: item.kind, scope: value.scope, subject, content: chunk,
        summary: `Imported from ${value.format}`, tags: ['import', value.format], sensitivity: value.sensitivity,
        source: 'import', sourceRef: value.sourceRef ?? item.title }, actor)
      records.push(saved.record.id)
      if (saved.created) imported++
      else skipped++
    }
  }
  memory.record('memory.import', value.scope.type === 'project' ? `project:${value.scope.project}` : value.scope.type,
    'completed', { format: value.format, imported, skipped, records: records.length }, actor)
  return { imported, skipped, records }
}
