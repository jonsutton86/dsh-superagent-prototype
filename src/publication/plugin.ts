import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import s from '@deepseek-ai/schemastery'
import { PublicationService, type PublicationServiceConfig } from './service.ts'
import { publicationHandler } from './http.ts'
import { PUBLICATION_PATH } from './protocol.ts'

export { PublicationService } from './service.ts'
export { PublicationClient } from './client.ts'
export * from './protocol.ts'
export const name = 'dsh-superagent-publication'
export const inject = ['webServer']
export const Config: s<Partial<PublicationServiceConfig>, PublicationServiceConfig> = s.object({ stateDir: s.string().pattern(/^\//).required(),
  ownership: s.object({ url: s.string().required(), authorityId: s.string().required(), coordinatorId: s.string().required(), resourceId: s.string().required(),
    credentialFile: s.string().pattern(/^\//).required(), timeoutMs: s.number().min(100).max(60_000).default(5000) }).required(),
  destinations: s.array(s.object({ id: s.string().required(), name: s.string().required(), kind: s.const('github-comment').required(),
    repository: s.string().required(), issue: s.number().required(), login: s.string().required(), maxBytes: s.number().default(30_000), credentialFile: s.string().pattern(/^\//).required() })).required(),
})
/** Separate publication host: account credentials and its delivery journal stay off the coordinator and worker hosts. */
export function apply(ctx: Context, config: PublicationServiceConfig): void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Publication service requires a loopback listener behind TLS or a secure tunnel')
  const service = new PublicationService(config)
  ctx.effect(() => () => service.close())
  service.start(error => ctx.logger.warn('Publication ownership monitor: %s', error instanceof Error ? error.message : String(error)))
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PUBLICATION_PATH, handler: publicationHandler(service) }))
  ctx.logger.info('Publication service ready: %s; coordinator credential is in %s/client.token', service.journal.id, config.stateDir)
}
