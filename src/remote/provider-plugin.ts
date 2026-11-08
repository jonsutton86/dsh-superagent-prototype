import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { RemoteFileSystem } from './filesystem.ts'
import { RemoteSubprocess } from './subprocess.ts'
import { RemoteWorld, type RemoteWorldConfig } from './world.ts'
import type { OwnershipAccess, OwnershipBinding } from '../ownership/protocol.ts'
import { OwnershipError } from '../ownership/protocol.ts'
import { assertOwnership } from '../ownership/runtime.ts'

export { RemoteWorld, type RemoteWorldConfig, type RemoteWorldStatus } from './world.ts'

export const name = 'dsh-superagent-remote-world'
export interface RemoteProviderConfig extends Omit<RemoteWorldConfig, 'ownership'> { ownership?: OwnershipBinding }
export const Config: s<Partial<RemoteProviderConfig>, RemoteProviderConfig> = s.object({
  url: s.string().required().description('Pinned HTTPS endpoint origin, or a loopback HTTP origin through a secure tunnel.'),
  endpointId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
  stateDir: s.string().pattern(/^\//).required().description('Private persistent coordinator directory for this world binding and revocation intents; keep across restarts.'),
  timeoutMs: s.number().min(100).max(60000).step(1).default(10000),
  ownership: s.union([s.object({ authorityId: s.string().required(), coordinatorId: s.string().required() })]),
})

/** Compose both Harness seams together in a dedicated execution-world scope, with the local providers removed from that scope. */
export async function apply(ctx: Context, config: RemoteProviderConfig): Promise<void> {
  const ownership = config.ownership && { ...config.ownership, proof: () => {
    const lease = (ctx.get('orchestrator') as { ownership?: OwnershipAccess } | undefined)?.ownership
    if (!lease) throw new OwnershipError(409, 'ownership_unavailable', 'Coordinator has not acquired execution ownership')
    assertOwnership(config.ownership, lease); return lease.proof()
  } }
  const world = new RemoteWorld({ ...config, ownership })
  ctx.effect(() => () => world.close())
  try {
    await world.start()
    ctx.provide('superagentRemoteWorld', world)
    const client = world.executionClient()
    new RemoteFileSystem(ctx, client, world.grant)
    new RemoteSubprocess(ctx, client, world.grant)
    world.maintain(error => ctx.logger.warn('Remote execution world: %s', String(error)))
  } catch (error) { await world.close(); throw error }
}
