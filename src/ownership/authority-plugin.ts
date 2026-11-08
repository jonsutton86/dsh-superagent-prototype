import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import s from '@deepseek-ai/schemastery'
import { OwnershipAuthority } from './authority.ts'
import { ownershipHandler } from './http.ts'
import { OWNERSHIP_PATH } from './protocol.ts'

export { OwnershipAuthority } from './authority.ts'
export { OwnershipClient, type OwnershipConnection } from './client.ts'
export * from './protocol.ts'
export const name = 'dsh-superagent-ownership-authority'
export const inject = ['webServer']
export const Config = s.object({ stateDir: s.string().pattern(/^\//).required() })

/** Dedicated persistent ownership host. Restart invalidates leases; coordinators and resources must establish a new barrier. */
export function apply(ctx: Context, config: { stateDir: string }): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Ownership authority requires a loopback listener behind TLS or a secure tunnel')
  const authority = new OwnershipAuthority(config.stateDir)
  ctx.effect(() => () => authority.close())
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: OWNERSHIP_PATH, handler: ownershipHandler(authority) }))
  ctx.logger.info('Ownership authority ready: %s; administration credential is in %s/admin.token', authority.id, config.stateDir)
}
