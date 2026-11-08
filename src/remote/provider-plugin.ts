import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import s from '@deepseek-ai/schemastery'
import { RemoteClient, type RemoteConnection } from './client.ts'
import { RemoteFileSystem } from './filesystem.ts'
import { RemoteSubprocess } from './subprocess.ts'
import type { EndpointIdentity, RemoteGrant } from './protocol.ts'

export const name = 'dsh-superagent-remote-world'
export const Config: s<Partial<RemoteConnection>, RemoteConnection> = s.object({
  url: s.string().required().description('Pinned HTTPS endpoint origin, or a loopback HTTP origin through a secure tunnel.'),
  endpointId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
  timeoutMs: s.number().min(100).max(60000).step(1).default(10000),
})

/** Compose both Harness seams together in a dedicated execution-world scope, with the local providers removed from that scope. */
export async function apply(ctx: Context, config: RemoteConnection): Promise<void> {
  const lifetime = new AbortController()
  const client = new RemoteClient({ ...config, lifetime: lifetime.signal })
  const identity = await client.call<EndpointIdentity>({ op: 'identity' })
  if (identity.protocol !== 1 || identity.confinement !== 'linux-bubblewrap') throw new Error('Remote world requires the supported confined endpoint protocol')
  const status = await client.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
  if (!status.authorized) throw new Error('Remote execution grant is not authorized')
  client.bindGrant(status.grant)
  if (!status.grant.operations.includes('fs.read') || !status.grant.operations.includes('process.spawn'))
    throw new Error('A paired remote world requires filesystem reads and process execution')
  ctx.effect(() => () => { lifetime.abort() })
  let renewing: Promise<void> | undefined
  const renew = async () => {
    const current = await client.call<{ grant: RemoteGrant; authorized: boolean }>({ op: 'grant.status' })
    if (!current.authorized || current.grant.epoch !== status.grant.epoch) throw new Error('Execution lease is no longer authorized')
    await client.intent({ op: 'grant.renew', requestId: randomUUID(), revision: current.grant.revision, leaseMs: 300000 })
  }
  await renew()
  ctx.effect(() => {
    const timer = setInterval(() => { renewing ??= renew().catch(error => ctx.logger.warn('Remote execution lease: %s', String(error))).finally(() => { renewing = undefined }) }, 60_000)
    timer.unref()
    return async () => { clearInterval(timer); await renewing }
  })
  new RemoteFileSystem(ctx, client, status.grant)
  new RemoteSubprocess(ctx, client, status.grant)
}
