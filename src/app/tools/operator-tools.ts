/** Worker tools for one public GET and one scoped file read. The coordinator does not receive either. */
import { z } from 'zod'
import type { Ticket } from '../../core/index.ts'
import { OPERATOR } from '../../sources/operator.ts'
import { fetchPermitted, fetchPublic, FetchRefused, httpsUrl } from '../fetch-url.ts'
import { readScopedFile, recordedAttachments } from '../scoped-files.ts'
import type { Store } from '../store.ts'
import { tool, type Tool } from './tool.ts'

export interface OperatorToolHost {
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings'>
  /** False while a GitHub source is configured; repository reads are used instead. */
  allowPublicFetch(): boolean
  fetchAllowlist(): readonly string[]
}

function operatorTexts(host: OperatorToolHost, ticket: Ticket): string[] {
  const ids = [ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])]
  return ids.flatMap(id => {
    const trigger = host.store.triggers.get(id)
    return trigger?.source === OPERATOR && trigger.text ? [trigger.text] : []
  })
}

export function operatorTools(host: OperatorToolHost, ticket: Ticket): Tool[] {
  return [
    tool({
      name: 'orchestrator_file_read',
      description: 'Read a text file the operator attached, or a file inside this ticket directory. 64 KiB. Read-only.',
      schema: z.object({
        path: z.string().min(1).max(4096),
        offset: z.number().int().min(0).default(0),
      }).strict(),
      execute: (args, signal) => {
        signal.throwIfAborted()
        const directory = ticket.execution?.directory
        if (!directory) throw new Error('This ticket has no directory')
        return readScopedFile(directory, recordedAttachments(host.store, ticket), args.path, args.offset)
      },
    }),
    tool({
      name: 'orchestrator_fetch',
      description: 'GET one public https URL from the operator allowlist or written in an operator message. 256 KiB. No credentials.',
      schema: z.object({ url: z.string().min(1).max(2000) }).strict(),
      execute: async (args, signal) => {
        if (!host.allowPublicFetch()) return { refused: 'Use repository/file or repository/directory. Public fetch is not used while a GitHub source is configured.' }
        try {
          httpsUrl(args.url)
          const current = host.store.tickets.get(ticket.id) ?? ticket
          return await fetchPublic(args.url, url => fetchPermitted(url, host.fetchAllowlist(), operatorTexts(host, current)), signal)
        } catch (error) {
          if (error instanceof FetchRefused) return { refused: error.message }
          throw error
        }
      },
    }),
  ]
}
