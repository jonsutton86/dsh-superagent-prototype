/** GUI messages on the coordinator session become explicit triggers. Presets cannot grant this. */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { key, type Policy, type Trigger } from '../core/index.ts'
import type { Settings } from '../policy.ts'
import { operatorContract } from './contracts.ts'
import type { SourceKind } from './kind.ts'

export const OPERATOR = 'operator'
const ACTOR = 'local'
type AttachmentRef = { attachmentId?: string }
type Block = { type?: string; text?: string; attachment?: AttachmentRef }
type AttachmentFiles = {
  fileHostPath?(ref: AttachmentRef): string | undefined | Promise<string | undefined>
  imageHostPath?(ref: AttachmentRef): string | undefined | Promise<string | undefined>
}

export const operatorKind: SourceKind = {
  kind: OPERATOR,
  title: { en: 'Operator', zh: '操作者' },
  description: { en: 'Messages typed in the coordinator session.', zh: '在协调会话中输入的消息。' },
  schema: operatorContract.schema,
  fields: [],
  health: [],
  scope: () => ({ listened: true, observed: false }),
}

export function operatorConfig(settings: Settings): { fetchAllowlist: string[] } {
  const parsed = operatorContract.schema.safeParse(settings.sources[OPERATOR]?.config ?? {})
  return (parsed.success ? parsed.data : { fetchAllowlist: [] }) as unknown as { fetchAllowlist: string[] }
}

/** Explicit local-operator messages are admissible without a mission or an allow-list entry. */
export function operatorPolicy(base: Policy, settings: Settings): Policy {
  const enabled = settings.sources[OPERATOR]?.enabled !== false
  return {
    ...base,
    gate: (trigger, thread, tickets) => trigger.source !== OPERATOR ? base.gate(trigger, thread, tickets)
      : enabled && trigger.human && trigger.addressed === 'direct' && trigger.actor.source === OPERATOR && trigger.actor.id === ACTOR
        && trigger.threads[0]?.source === OPERATOR && trigger.id === key(OPERATOR, trigger.threads[0].id)
        ? { admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'direct', source: OPERATOR, scope: {}, sender: ACTOR } }
        : { admissible: false, reason: 'Invalid operator request' },
    revalidate: mandate => mandate.actor.source !== OPERATOR ? base.revalidate(mandate)
      : enabled && mandate.actor.id === ACTOR && mandate.strength === 'explicit' && mandate.basis.via === 'addressed',
  }
}

function blocks(message: UserMessage): Block[] {
  return Array.isArray(message.content) ? message.content as Block[] : []
}

function refs(message: UserMessage): AttachmentRef[] {
  return blocks(message).flatMap(block => (block.type === 'file' || block.type === 'image') && block.attachment?.attachmentId
    ? [block.attachment] : [])
}

function textOf(message: UserMessage): string {
  const text = blocks(message).flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n').trim()
  if (text) return text
  const names = refs(message).map(ref => ref.attachmentId).filter((id): id is string => !!id)
  return names.length ? `Attached ${names.length} file(s)` : ''
}

function hostPath(service: AttachmentFiles | undefined, ref: AttachmentRef): string | undefined | Promise<string | undefined> {
  if (!service) return undefined
  try { return service.fileHostPath?.(ref) ?? service.imageHostPath?.(ref) } catch { return undefined }
}

function triggerFor(message: UserMessage, paths: string[]): Trigger {
  const thread = message.id
  return {
    id: key(OPERATOR, thread), source: OPERATOR, threads: [{ source: OPERATOR, id: thread }],
    actor: { source: OPERATOR, id: ACTOR }, human: true, addressed: 'direct', at: new Date().toISOString(),
    text: textOf(message), meta: { ...(paths.length ? { attachments: paths } : {}) },
  }
}

/**
 * Stores one trigger per coordinator GUI message. Host relays and worker sessions are ignored.
 * Attachment paths come from the Harness attachment service, which is synchronous in the installed runtime.
 */
export function watchOperatorChat(ctx: Context, masterId: () => string, receive: (trigger: Trigger) => void, warn: (message: string) => void): () => void {
  return ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (agent.id !== masterId() || message.source.kind !== 'user' || !message.id) return
    const body = textOf(message)
    if (!body) return
    const service = ctx.get('attachments') as AttachmentFiles | undefined
    const pending: Promise<string | undefined>[] = []
    const paths: string[] = []
    for (const ref of refs(message)) {
      const found = hostPath(service, ref)
      if (typeof found === 'string' && found) paths.push(found)
      else if (found && typeof (found as Promise<string | undefined>).then === 'function') pending.push(found as Promise<string | undefined>)
    }
    const store = (extra: readonly (string | undefined)[]) => {
      try { receive(triggerFor(message, [...new Set([...paths, ...extra.filter((item): item is string => !!item)])])) }
      catch (error) { warn(error instanceof Error ? error.message : String(error)) }
    }
    if (!pending.length) { store([]); return }
    void Promise.all(pending).then(store).catch(error => warn(error instanceof Error ? error.message : String(error)))
  })
}
