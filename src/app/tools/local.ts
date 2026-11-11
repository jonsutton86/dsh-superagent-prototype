/** Host-injected read and fetch tools. A preset cannot add them; the host registers them on the coordinator and on workers. */
import { z } from 'zod'
import type { Settings } from '../../policy.ts'
import { operatorActorId } from '../../policy.ts'
import { fetchPublic, httpsUrl, urlsIn } from '../fetch-url.ts'
import { readTextFile, readableAttachments, readableDirectories, resolveReadable } from '../scoped-files.ts'
import { githubSourceConfigured } from '../../sources/repository.ts'
import { OperatorConfigSchema } from '../../sources/operator.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

export interface LocalToolsHost {
  readonly store: Pick<Store, 'settings' | 'triggers' | 'tickets' | 'read'>
  fetch(url: string, init: RequestInit): Promise<Response>
}

function allowlist(settings: Settings): string[] {
  if (operatorActorId(settings) === undefined) return []
  const parsed = OperatorConfigSchema.safeParse(settings.sources.operator?.config ?? {})
  const config = parsed.success ? parsed.data : OperatorConfigSchema.parse({})
  return config.fetchAllowlist.map(item => item.prefix)
}

function operatorUrls(host: LocalToolsHost, ticketId?: string): string[] {
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined
  const ids = ticket ? [...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input =>
    input.kind === 'trigger' || input.kind === 'resumed' ? [input.triggerId] : [])] : []
  const texts = ticketId
    ? [...new Set(ids)].flatMap(id => { const trigger = host.store.triggers.get(id); return trigger?.source === 'operator' ? [trigger.text] : [] })
    : host.store.read.recentTriggers(0, 200).filter(item => item.source === 'operator').map(item => item.text)
  return [...new Set(texts.flatMap(urlsIn))]
}

/** `orchestrator_file_read` and `orchestrator_fetch` for the main Session, or for one ticket's worker when `ticketId` is set. */
export function localTools(host: LocalToolsHost, ticketId?: string): Tool[] {
  return [
    tool({
      name: 'orchestrator_file_read',
      description: 'Read one text file: an operator attachment at its saved path, or a file inside a ticket directory. Read-only, at most 64 KiB. Refuses any other path.',
      schema: z.object({
        path: z.string().min(1).describe('Absolute attachment path, or an absolute path inside a ticket directory.'),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(65536).optional(),
      }).strict(),
      execute: async ({ path, offset, limit }) => {
        const real = resolveReadable(path, readableAttachments(host.store, ticketId), readableDirectories(host.store, ticketId))
        return readTextFile(real, offset, limit)
      },
    }),
    tool({
      name: 'orchestrator_fetch',
      description: 'GET one public https URL and return its status, text and retrieval time. The URL must be on the operator fetch allowlist or written in an operator message. No credentials, no POST, no redirect off that set, at most 256 KiB. Refuses while the GitHub source is configured.',
      schema: z.object({ url: z.string().min(1).max(2000) }).strict(),
      execute: async ({ url }, signal) => {
        const settings = host.store.settings()
        if (githubSourceConfigured(settings)) throw new Error('The GitHub source is configured. Read the repository with orchestrator_read instead of fetching a URL.')
        if (!httpsUrl(url)) throw new Error('Only an https URL with no userinfo can be fetched')
        return fetchPublic({ url, allowlist: allowlist(settings), operatorUrls: operatorUrls(host, ticketId), fetch: (target, init) => host.fetch(target, init), signal })
      },
    }),
  ]
}
