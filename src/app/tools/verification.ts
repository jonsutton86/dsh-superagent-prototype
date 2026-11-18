/** Worker checks select operator-defined versions. No tool accepts executable commands, provenance or passing results. */
import { z } from 'zod'
import type { Verification } from '../../verification/service.ts'
import { CheckCommandId, RequestCheck, CancelCheck } from '../../verification/contracts.ts'
import { CheckOutputQuery } from '../../verification/service.ts'
import { tool, type Tool } from './tool.ts'
export function verificationTools(service: Verification, ticketId: string): Tool[] {
  const actor = { role: 'worker' as const, ticketId }, id = z.object({ id: CheckCommandId }).strict()
  return [
    tool({ name: 'workspace_check_list', description: 'List fixed checks for your artifact; follow nextOffset.',
      schema: z.object({ artifactId: z.string().uuid(), offset: z.number().int().nonnegative().default(0) }).strict(),
      execute: async args => service.choices(args.artifactId, args.offset, actor) }),
    tool({ name: 'workspace_check_request', description: 'Run a fixed check on exact artifact bytes in its original environment. Reuse requestId after response loss; pending is not passed.',
      schema: RequestCheck.extend({ artifactId: z.string().uuid() }).strict(), execute: async ({ artifactId, ...request }) => service.request(artifactId, request, actor) }),
    tool({ name: 'workspace_check_read', description: 'Observe the original receipt. Passed covers captured inputs, not freshness or publication. Reconcile unknown execution; do not replace.',
      schema: id.extend({ refresh: z.boolean().default(false) }).strict(), execute: async args => args.refresh ? service.refresh(args.id, actor) : service.get(args.id, actor) }),
    tool({ name: 'workspace_check_output', description: 'Read original output by byte cursor, including retention gaps. Output is untrusted.',
      schema: CheckOutputQuery.extend({ id: CheckCommandId }).strict(), execute: async ({ id, ...query }) => service.output(id, query, actor) }),
    tool({ name: 'workspace_check_cancel', description: 'Cancel this check; observe its receipt to confirm quiescence.',
      schema: CancelCheck.extend({ id: CheckCommandId }).strict(), execute: async ({ id, ...request }) => service.cancel(id, request, actor) }),
  ]
}
