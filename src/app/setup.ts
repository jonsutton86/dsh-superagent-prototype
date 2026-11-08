/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, verifyLocalWorkspace, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import { executionRoot } from './execution-environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import type { RemoteWorkspace } from '../environments/remote-workspace.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
  incompatibleTickets?(): boolean
  remote?: RemoteWorkspace
}

const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    try {
      if (this.host.incompatibleTickets?.()) throw new SetupError('executionModeMismatch')
      this.resolved = await this.resolve(settings); return true
    }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problem = error.problem
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    if (this.host.machine.ownership) throw new SetupError('environmentFailed', { output: 'External account commands require an independently fenced publication service in an ownership-controlled profile.' })
    if (this.host.remote) throw new SetupError('environmentFailed', { output: 'Remote endpoint credential bindings are required before configuring account CLIs for a remote profile.' })
    const { machine } = this.host
    if (machine.executionMode === 'local' && block === 'source:github') throw new SetupError('githubUnavailable')
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.host.remote || this.host.machine.ownership) {
      if (blocked.length) throw new SetupError('environmentFailed', { output: 'Host command shims cannot enforce commands in a remote environment. Configure endpoint policy before using blocked commands.' })
      return
    }
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    if (machine.ownership && (settings.sources.github?.config.cli || settings.sources.feishu?.config.cli))
      throw new SetupError('environmentFailed', { output: 'Host account CLIs cannot participate in ownership handoff; external publication must use a fenced service.' })
    if (this.host.remote) {
      try {
        if (machine.executionMode !== 'local') throw new Error('Remote mission profiles currently require general-mission mode (executionMode: local); repository credentials must be bound at the endpoint first.')
        if (settings.sources.github?.config.cli || settings.sources.feishu?.config.cli)
          throw new Error('Host account CLIs cannot be forwarded to a remote environment; endpoint credential bindings are required.')
        await this.blockCommands(settings.executor.blockedCommands)
        const root = executionRoot(settings, machine.stateDir, this.host.remote.world.grant.root)
        if (root !== this.host.remote.world.grant.root) throw new Error('The configured execution directory must equal the remote grant root.')
        await this.host.remote.verify(root)
        return { ...machine, executionMode: 'local' }
      } catch (error) { throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) }) }
    }
    if (machine.ownership) {
      await this.blockCommands(settings.executor.blockedCommands)
      return { ...machine, executionMode: 'local' }
    }
    const probe = this.probe()
    const deployment: Deployment = machine.executionMode === 'local' ? { ...machine, executionMode: 'local' }
      : await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    const verify = deployment.executionMode === 'local' ? verifyLocalWorkspace(executionRoot(settings, machine.stateDir), context.subprocess, lifetime, context.fs)
      .catch((error: unknown) => { throw error instanceof SetupError ? error : new SetupError('localWorkspaceUnavailable', { output: String(error) }) })
      : verifyEnvironment(resolved, context.subprocess, lifetime)
    await verify.catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
