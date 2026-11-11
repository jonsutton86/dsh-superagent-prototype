/**
 * Operator source: messages the operator sends in the main Session's Web GUI chat become Triggers.
 * The chat delivers those messages straight into the Session, so without this they never enter intake and
 * `orchestrator_route` answers "Unknown trigger" for every id the model composes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import { operatorActorId, type Settings } from '../policy.ts'
import type { SourceKind } from './kind.ts'

export const OPERATOR = 'operator'
const ATTACHMENT_PATH = /(?:^|\s)(\/[^\s`'"]*\/attachments\/[^\s`'"]+)/g
/** One allowlist entry: an https URL prefix the operator named, with no userinfo. */
const PrefixSchema = z.object({
  prefix: z.string().trim().min(1).max(500).refine(value => value.startsWith('https://') && !value.includes('@'), 'An https URL prefix, with no userinfo'),
}).strict()
export const OperatorConfigSchema = z.object({
  operatorId: z.string().trim().min(1).max(80).default('local'),
  fetchAllowlist: z.array(PrefixSchema).max(32).default([]),
}).strict()
export type OperatorConfig = z.infer<typeof OperatorConfigSchema>

export const operatorKind: SourceKind<OperatorConfig> = {
  kind: OPERATOR,
  title: { zh: '操作者对话', en: 'Operator chat' },
  description: { zh: '把 Web 界面里发给主 Session 的消息登记为触发，以便路由。', en: 'Records messages sent to the main Session from the Web GUI as triggers, so they can be routed.' },
  schema: OperatorConfigSchema,
  fields: [
    { key: 'operatorId', type: 'text', label: { zh: '操作者标识', en: 'Operator id' },
      hint: { zh: 'Web 界面操作者的标识，默认 local。这个人的消息是明确请求。', en: 'Identity of the person at the Web GUI. Defaults to local. Their messages are explicit requests.' } },
    { key: 'fetchAllowlist', type: 'rows', label: { zh: '允许获取的 URL 前缀', en: 'Fetch allowlist' },
      hint: { zh: 'https 前缀。获取工具只接受名单里的 URL，或操作者消息里写明的 URL。配置了 GitHub 来源时不使用获取工具。', en: 'https prefixes. The fetch tool accepts a URL on this list, or one written in an operator message. It is not used while the GitHub source is configured.' },
      columns: [{ key: 'prefix', type: 'text', label: { zh: '前缀', en: 'Prefix' } }] },
  ],
  health: [],
  // Every operator message is addressed to the agent. Nothing is observed unaddressed.
  scope: () => ({ listened: true, observed: false }),
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1).max(80) }).strict()).default([{ id: 'local' }]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的操作者', en: 'Operators who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '标识', en: 'Id' } }] }],
    explicit: { zh: '操作者在 Web 界面的对话里发给主 Session 的消息。', en: 'A message the operator sends to the main Session in the Web GUI chat.' },
  },
}

interface AttachmentPaths {
  fileHostPath?(ref: FileAttachmentRef): string | undefined
  imageHostPath?(ref: ImageAttachmentRef): string | undefined
}
export interface SavedAttachment { path: string; name?: string }

/** Absolute paths of files this message attached, from the attachment service or a saved path named in the text. */
export function messageAttachments(agent: Pick<Agent, 'ctx'>, message: Pick<UserMessage, 'content'>): SavedAttachment[] {
  const service = agent.ctx.get('attachments') as AttachmentPaths | undefined
  const found: SavedAttachment[] = []
  const add = (path: string | undefined, name?: string) => {
    if (!path?.startsWith('/') || found.some(item => item.path === path)) return
    found.push({ path, ...name ? { name } : {} })
  }
  for (const block of message.content) {
    try {
      if (block.type === 'text') {
        for (const match of block.text.matchAll(ATTACHMENT_PATH)) add(match[1])
      } else if (block.type === 'file') add(service?.fileHostPath?.(block.attachment), block.attachment.name)
      else if (block.type === 'image') add(service?.imageHostPath?.(block.attachment), block.attachment.name)
    } catch { /* An unreadable attachment reference adds no path; the message text still becomes a trigger. */ }
  }
  return found
}

/** The Trigger of one Web GUI message, or undefined when it is not an operator message or has nothing to route. */
export function operatorTrigger(message: UserMessage, agent: Pick<Agent, 'ctx'>, actorId: string, at: string): Trigger | undefined {
  if (message.source.kind !== 'user' || !message.id || !actorId) return undefined
  const attachments = messageAttachments(agent, message)
  const said = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
  const lines = [said, ...attachments.length ? ['', 'Attachments:', ...attachments.map(item => `- ${item.path}`)] : []].filter((line, index) => line !== '' || index > 0)
  const text = lines.join('\n').trim()
  if (!text) return undefined
  return {
    id: key(OPERATOR, message.id), source: OPERATOR, threads: [{ source: OPERATOR, id: message.id }],
    actor: { source: OPERATOR, id: actorId }, human: true, addressed: 'direct', at, text,
    meta: { messageId: message.id, attachments },
  }
}

export interface OperatorChatHost {
  readonly masterId: string
  settings(): Settings
  receive(trigger: Trigger): ReceiveResult
}
/**
 * Records each operator message claimed by the main Session. A repeated claim of the same message is a duplicate and
 * changes nothing. Messages the host itself delivered use another source kind and are not triggers.
 */
export function watchOperatorChat(ctx: Context, host: OperatorChatHost): () => void {
  return ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent.id !== host.masterId) return
    const actorId = operatorActorId(host.settings())
    if (!actorId) return
    const trigger = operatorTrigger(message, agent, actorId, new Date().toISOString())
    if (!trigger) return
    try { host.receive(trigger) }
    catch (error) { ctx.logger.warn('dsh-superagent could not record an operator message: %s', error instanceof Error ? error.message : String(error)) }
  })
}

/** Attachment paths recorded on a trigger. */
export function pathsOf(trigger: Trigger | undefined): string[] {
  const list = trigger?.meta.attachments
  if (!Array.isArray(list)) return []
  return list.flatMap(item => item && typeof item === 'object' && 'path' in item && typeof item.path === 'string' && item.path.startsWith('/') ? [item.path] : [])
}
