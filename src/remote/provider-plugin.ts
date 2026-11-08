import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { RemoteFileSystem } from './filesystem.ts'
import { RemoteSubprocess } from './subprocess.ts'
import { RemoteWorld, type RemoteWorldConfig } from './world.ts'

export const name = 'dsh-superagent-remote-world'
export const Config: s<Partial<RemoteWorldConfig>, RemoteWorldConfig> = s.object({
  url: s.string().required().description('Pinned HTTPS endpoint origin, or a loopback HTTP origin through a secure tunnel.'),
  endpointId: s.string().required(), credentialFile: s.string().pattern(/^\//).required(),
  stateDir: s.string().pattern(/^\//).required().description('Private persistent coordinator directory for this world binding and revocation intents; keep across restarts.'),
  timeoutMs: s.number().min(100).max(60000).step(1).default(10000),
})

/** Compose both Harness seams together in a dedicated execution-world scope, with the local providers removed from that scope. */
export async function apply(ctx: Context, config: RemoteWorldConfig): Promise<void> {
  const world = new RemoteWorld(config)
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
