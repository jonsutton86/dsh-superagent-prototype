/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { prepareRuntimeActivation } from './recovery/activation.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess', 'fs']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const lifetime = new AbortController(); ctx.effect(() => () => lifetime.abort())
  const handoff = machine.restore ? await prepareRuntimeActivation(ctx, machine, lifetime.signal) : undefined
  let runtime: Runtime
  try { runtime = new Runtime(ctx, machine, restart, handoff) }
  catch (error) { await handoff?.ownership.close(); handoff?.release(); throw error }
  ctx.effect(() => async () => { await runtime.stop() })
  // Preset restoration may wait for the Host Loader tree to settle. Do not hold this row's activation open while it waits
  // for that same tree. SourceHost.ready and Runtime's admission gate retain the actual initialization boundary.
  void runtime.ready.then(() => {
    ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  }, (error: unknown) => { ctx.logger.error('dsh-superagent initialization failed: %s', String(error)) })
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
