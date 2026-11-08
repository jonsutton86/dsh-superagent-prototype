import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {} from '../environments/pool.ts'
import { RemoteFileSystem } from './filesystem.ts'
import { RemoteSubprocess } from './subprocess.ts'

export const name = 'dsh-superagent-scoped-world'
export const inject = ['superagentWorlds']
export const Config = s.object({ binding: s.string().pattern(/^[a-f0-9]{64}$/).required() })

/** Preset-owned paired services borrow one managed world; no Session opens or closes its durable journal. */
export function apply(ctx: Context, config: { binding: string }): void {
  const { world } = ctx.superagentWorlds.borrow(config.binding), client = world.executionClient()
  new RemoteFileSystem(ctx, client, world.grant)
  new RemoteSubprocess(ctx, client, world.grant)
}
