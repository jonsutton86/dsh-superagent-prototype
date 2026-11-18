/** An immutable repository seed selected when an operator activates a remote execution world. */
import { z } from 'zod'
import type { RemoteGrant } from '../remote/protocol.ts'

export const RepositorySource = z.object({
  url: z.string().max(2048).refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
      && !url.search && !url.hash && !/\s/.test(value) } catch { return false }
  }, 'Use an HTTPS Git URL without credentials, query parameters or fragments').transform(value => new URL(value).href),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, 'Select a full immutable commit ID'),
  credentialId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
  username: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.@-]+$/).default('x-access-token'),
}).strict()
export type RepositorySource = z.infer<typeof RepositorySource>
export function repositoryCredential(source: RepositorySource, grant: RemoteGrant) {
  if (!['fs.read', 'fs.write', 'process.spawn', 'network'].every(operation => grant.operations.includes(operation as RemoteGrant['operations'][number])))
    throw new Error('Repository preparation requires a grant with filesystem reads/writes, processes and network access')
  const credential = source.credentialId && grant.credentials?.find(item => item.id === source.credentialId)
  if (source.credentialId && !credential) throw new Error('The repository credential must be explicitly bound to this grant generation')
  return credential || undefined
}
