/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { Engine, canStop, key, latestAssignment, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { operatorConfig, operatorKind, operatorPolicy, watchOperatorChat } from '../sources/operator.ts'
import { repositoryKind } from '../sources/repository-profile.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { sourceAvailable } from '../sources/contracts.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, executionRoot, type Variable } from './execution-environment.ts'
import { RemoteWorkspace, remoteWorld } from '../environments/remote-workspace.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId, ticketOfSession } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { consumeRuntimeBootstrap, type RuntimeBootstrap } from '../recovery/activation.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import { Voice } from '../voice/service.ts'
import { Attachments } from '../attachments/service.ts'
import { outsideRoots } from '../voice/adapters.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'
import { Supervision } from '../supervision/service.ts'
import { Workspace } from '../workspace/service.ts'
import { Schedules } from '../workspace/schedules.ts'
import { Reflections } from '../workspace/reflection.ts'
import { Speculation } from '../speculation/service.ts'
import { Usage } from '../usage/service.ts'
import { UsageRuntime } from '../usage/runtime.ts'
import { installAbliterationGuard } from '../providers/abliteration-guard.ts'
import { Inbox } from '../workspace/inbox.ts'
import { Library } from '../workspace/library.ts'
import { Environments } from '../environments/service.ts'
import { Endpoints } from '../environments/endpoints.ts'
import { Personas } from '../personas/service.ts'
import { resolveRoleModel } from './role-models.ts'
import { WorldPool } from '../environments/pool.ts'
import { openRuntimeOwnership, assertOwnership, ownershipReady } from '../ownership/runtime.ts'
import type { CoordinatorOwnership } from '../ownership/lease.ts'
import { Publications } from '../publication/runtime.ts'
import { RepositoryExports } from '../publication/repository-exports.ts'
import { RepositoryPublications } from '../publication/repository-runtime.ts'
import { ChannelPublications } from '../publication/channels.ts'
import { ConversationInbox } from '../publication/inbound.ts'
import { Verification } from '../verification/service.ts'
import { VerificationReviews } from '../verification/reviews.ts'
import { MissionReviews } from '../verification/missions.ts'
import { MissionPulls } from '../workspace/pulls.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  readonly supervision: Supervision
  readonly workspace: Workspace
  readonly schedules: Schedules
  readonly reflections: Reflections
  readonly speculation: Speculation
  readonly usage: Usage
  readonly inbox: Inbox
  readonly voice: Voice
  readonly attachments: Attachments
  readonly library: Library
  readonly verification: Verification
  readonly verificationReviews: VerificationReviews
  readonly environments: Environments
  readonly endpoints: Endpoints
  readonly personas: Personas
  readonly worlds: WorldPool
  readonly remoteWorkspace?: RemoteWorkspace
  readonly ownership?: CoordinatorOwnership
  readonly publications: Publications
  readonly repositoryExports: RepositoryExports
  readonly repositoryPublications: RepositoryPublications
  readonly channelPublications: ChannelPublications
  readonly conversations: ConversationInbox
  readonly ready: Promise<void>
  private quiescing?: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  private readonly environmentHealth = this.board.claim('environment')
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private executionOwnershipLost = false
  private initialized = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, handoff?: RuntimeBootstrap) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const bootstrap = handoff && consumeRuntimeBootstrap(handoff, machine)
    if (machine.restore && !bootstrap) throw new Error('Installed recovery must start through the verified Runtime handoff')
    const release = bootstrap?.release ?? lockSync(machine.stateDir, { stale: 30_000, onCompromised: compromised })
    if (bootstrap) {
      const lost = () => compromised(new Error('Installed Runtime handoff or state lock was lost'))
      bootstrap.signal.addEventListener('abort', lost, { once: true })
      this.disposers.push(() => bootstrap.signal.removeEventListener('abort', lost))
    }
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    let openedVoice: Voice | undefined
    try {
      // A held, authenticated image must be refused before Store changes journal mode or migrates any bytes.
      const path = join(machine.stateDir, 'orchestrator.sqlite')
      if (existsSync(path)) {
        const existing = new DatabaseSync(path, { readOnly: true })
        try {
          if (existing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get()
            && JSON.parse(String(existing.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.hold)?.value ?? 'null')))
            throw new Error('This is a staged checkpoint restore. Reconcile coordinator ownership, Sessions and external effects before enabling execution.')
          if (!bootstrap && existing.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get()
            && existing.prepare('SELECT value FROM kv WHERE key=?').get(KV.recovery.activation))
            throw new Error('Installed recovery requires its authenticated Runtime configuration')
        } finally { existing.close() }
      }
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(path, report)
      if (store.get(KV.recovery.hold)) throw new Error('This is a staged checkpoint restore. Reconcile coordinator ownership, Sessions and external effects before enabling execution.')
      const world = remoteWorld(ctx)
      if (machine.ownership && machine.executionMode !== 'local') throw new Error('Ownership-controlled repository publication requires a fenced publication service; use a general-mission profile until that integration is available')
      if (world) assertOwnership(machine.ownership, world.ownershipBinding)
      this.ownership = openRuntimeOwnership(store, machine.ownership, [executionRoot(store.settings(), machine.stateDir, world?.grant.root)], bootstrap?.ownership)
      const remote = this.remoteWorkspace = world ? new RemoteWorkspace(world, ctx.fs, ctx.subprocess, this.lifetime) : undefined
      const speechFiles = [machine.voice?.input, machine.voice?.output].flatMap(adapter => !adapter ? [] : adapter.kind === 'http'
        ? adapter.credentialFile ? [adapter.credentialFile] : [] : [adapter.binary, adapter.ffmpeg, ...(adapter.kind === 'whisper' ? [adapter.modelFile] : [])])
      const speechRoot = (root: string) => { for (const file of [...speechFiles, ...(machine.voice ? [join(machine.stateDir, 'speech-temporary')] : [])]) outsideRoots(file, [root]) }
      const environments = this.environments = new Environments({ store, filesystem: ctx.fs, subprocess: ctx.subprocess, lifetime: this.lifetime,
        authorizeRoot: speechRoot,
        remote, ownership: this.ownership, worlds: () => runtime.worlds, root: () => executionRoot(store.settings(), machine.stateDir, world?.grant.root), mode: () => machine.executionMode ?? 'repository', engine: () => runtime.engine })
      this.endpoints = new Endpoints({ store, stateDir: machine.stateDir, lifetime: this.lifetime, ownership: this.ownership, ownershipConfig: machine.ownership,
        restoreRegistration: bootstrap?.bindings.registration,
        publicationConfig: machine.publication,
        workerRoots: () => [...environments.list().items.filter(item => item.kind === 'local').flatMap(item => [item.root, item.configuredRoot]),
          ...(!world ? [executionRoot(store.settings(), machine.stateDir)] : [])] })
      this.worlds = new WorldPool(ctx, { store, endpoints: this.endpoints, lifetime: this.lifetime, ownership: this.ownership, ownershipConfig: machine.ownership, report,
        authorizeRoot: speechRoot,
        restoreWorld: bootstrap?.bindings.world,
        controlFiles: machine.publication ? [machine.publication.credentialFile] : [],
        revoked: binding => { for (const ticket of store.tickets.open()) if (ticket.execution?.environment?.environmentId === binding && canStop(ticket)) runtime.engine.stopTicket(ticket.id, 'Managed execution world revoked by the operator') } })
      const library = this.library = new Library(store)
      this.attachments = new Attachments({ store, lifetime: this.lifetime, backend: () => ctx.get('attachments'),
        authorize: ticket => {
          this.ownership?.proof(); this.lifetime.throwIfAborted()
          if (!environments.allows(ticket.execution?.environment)) throw new Error('Attachment execution environment is unavailable')
          const problem = runtime.speculation?.problem(ticket); if (problem) throw new Error(problem)
        } })
      openedVoice = this.voice = new Voice({ store, stateDir: machine.stateDir, config: machine.voice, lifetime: this.lifetime,
        roots: () => [executionRoot(store.settings(), machine.stateDir, world?.grant.root),
          ...environments.list().items.filter(item => item.kind === 'local').flatMap(item => [item.root, item.configuredRoot]),
          ...this.worlds.list().items.map(item => item.root)] })
      const verification = this.verification = new Verification({ store, library, stateDir: machine.stateDir, subprocess: ctx.subprocess, lifetime: this.lifetime,
        authorize: () => { this.ownership?.proof(); this.lifetime.throwIfAborted() }, paused: () => this.paused(),
        allowed: location => environments.allows(location.environment), localAllowed: () => !remote && !this.ownership,
        remote: location => {
          const binding = location.environment?.world
          if (binding && remote?.world.status().binding === binding) return remote.world
          if (binding) return this.worlds.lookup(binding)?.world
          return undefined
        }, workerProblem: id => {
          const ticket = store.tickets.get(id)
          return !ticket ? 'Worker ticket is unavailable' : runtime.speculation?.problem(ticket)
        } })
      const reviews = this.verificationReviews = new VerificationReviews({ store, verification, lifetime: this.lifetime,
        authorize: () => { this.ownership?.proof(); this.lifetime.throwIfAborted() } })
      this.repositoryExports = new RepositoryExports({ store, verification, reviews, lifetime: this.lifetime,
        member: binding => this.worlds.require(binding), authorize: () => { this.ownership?.proof(); this.lifetime.throwIfAborted(); if (this.paused()) throw new Error('Coordinator is paused') },
        preparationProblem: (ticketId, assignmentId) => runtime.speculation?.publicationProblem(ticketId, assignmentId) })
      this.publications = new Publications({ store, library, verification, reviews, ownership: this.ownership, connection: machine.publication, lifetime: this.lifetime,
        preparationProblem: (ticketId, assignmentId) => runtime.speculation?.publicationProblem(ticketId, assignmentId),
        roots: () => [executionRoot(store.settings(), machine.stateDir, world?.grant.root), ...this.worlds.list().items.map(item => item.root)] })
      this.repositoryPublications = new RepositoryPublications({ store, exports: this.repositoryExports, reviews, ownership: this.ownership,
        connection: machine.publication, lifetime: this.lifetime,
        authorize: () => { this.ownership?.proof(); this.lifetime.throwIfAborted(); if (this.paused()) throw new Error('Coordinator is paused') },
        roots: () => [executionRoot(store.settings(), machine.stateDir, world?.grant.root), ...this.worlds.list().items.map(item => item.root)] })
      const personas = this.personas = new Personas(store, async model => { await resolveRoleModel(ctx, model) })
      const workspace = this.workspace = new Workspace(store, () => runtime.engine, () => !this.paused() && !this.closing(),
        id => library.evidenceRevision(id), ticket => environments.allows(ticket.execution?.environment), reference => personas.snapshot(reference), reference => environments.select(reference),
        (mission, action) => runtime.channelPublications?.channel(mission, action), new MissionReviews(store, library, verification, reviews), new MissionPulls(store, this.publications))
      const reflections = this.reflections = new Reflections(store, workspace, library, () => !this.paused())
      const schedules = this.schedules = new Schedules(store, workspace, () => !this.paused(), Date.now,
        (occurrence, missionId, spec) => reflections.prepare(occurrence, missionId, spec))
      const usage = this.usage = new Usage(store, Date.now, call => runtime.speculation?.admitCall(call))
      const inbox = this.inbox = new Inbox(store, workspace, library,
        async id => (await ctx.sessionController.inspect(id as SessionId, AbortSignal.any([this.lifetime, AbortSignal.timeout(15_000)]))).events, this.attachments, environments)
      this.disposers.push(ctx.on('session/event', (session, event) => {
        const id = ticketOfSession(session.id)
        if (id) inbox.record(id, event)
      }))
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart, remote,
        incompatibleTickets: () => store.tickets.open().some(ticket => ticket.execution
          && (ticket.execution.mode ?? 'repository') !== (machine.executionMode ?? 'repository')) })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu,
        () => machine.executionMode === 'local')
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const accounting = new UsageRuntime(ctx, store, usage, masterId, this.lifetime, board.claim('usage', { state: 'starting', detail: 'Model accounting is starting' }))
      this.disposers.push(() => accounting.dispose())
      this.disposers.push(installAbliterationGuard(ctx))
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      }, id => sourceAvailable({ owned: !!this.ownership, publication: !!machine.publication, local: machine.executionMode === 'local' }, id))
      this.channelPublications = new ChannelPublications({ store, ownership: this.ownership, connection: machine.publication, lifetime: this.lifetime,
        mission: id => workspace.get(id, false), destinations: () => this.publications.destinations(),
        authorized: ticket => workspace.policy(settingsPolicy(store.settings(), sources)).revalidate(ticket.mandate) && workspace.executionAllowed(ticket)
          && !runtime.speculation?.publicationProblem(ticket.id) })
      this.conversations = new ConversationInbox({ store, ownership: this.ownership, connection: machine.publication, lifetime: this.lifetime, channels: this.channelPublications,
        engine: () => runtime.engine, requestPass: () => runtime.passes.request(),
        authorized: ticket => workspace.policy(settingsPolicy(store.settings(), sources)).revalidate(ticket.mandate) && workspace.executionAllowed(ticket) })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      this.disposers.push(sources.register(workspace.source), sources.register(operatorKind), sources.register(repositoryKind))
      if (machine.publication) this.disposers.push(sources.register(this.channelPublications.source), sources.register(this.conversations.source))
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        attachments: this.attachments,
        lifetime: this.lifetime, remote, worlds: this.worlds, personas, ownership: this.ownership, environmentAllowed: ticket => environments.allows(ticket.execution?.environment),
        executionProblem: ticket => runtime.executor?.stops.problem(ticket.id) ?? runtime.speculation?.problem(ticket),
        beforeExecution: (ticket, agent) => {
          const assignment = ticket.assignments.at(-1)
          if (assignment) {
            if (agent.id === workerSessionId(ticket.id) && !runtime.executor.stops.executionAllowed(agent, assignment.id))
              throw new Error('Original worker turn has no current assignment admission')
            runtime.executor.stops.beforeAdmission(ticket.id, assignment.id)
          }
        },
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket, agent) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine, environments, remote, personas,
        get speculation() { return runtime.speculation },
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        authorizeStopObservation: () => { if (runtime.executionOwnershipLost) throw new Error('Coordinator ownership was lost') },
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: async (id, text) => { await sessions.prompt(masterId, id, text, 'steer') }, candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, publication: this.channelPublications, paused: () => this.paused(),
        publicationProblem: message => runtime.speculation?.messageProblem(message) })
      const { assessor, executor } = this
      const policy = () => {
        const current = store.settings()
        return environments.policy(this.conversations.policy(operatorPolicy(workspace.policy(settingsPolicy(current, sources)), current)))
      }
      const speculation = this.speculation = new Speculation({ store, usage, authorized: ticket => policy().revalidate(ticket.mandate),
        paused: () => this.paused(), capacity: () => store.settings().executor.maxWorkers, busy: id => executor.busy(id),
        quiet: run => executor.quiescence(run), requestPass: () => runtime.passes?.request(),
        evidence: ticket => key(JSON.stringify(ticket) + library.evidenceRevision(ticket.id)),
        provider: async ticket => {
          const selected = ticket.execution?.persona?.definition.model ?? store.settings().executor.model
            ?? (ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined)?.currentSelection()
          if (!selected) throw new Error('Configure a worker model before admitting speculative preparation')
          return (await resolveRoleModel(ctx, selected)).provider
        }, halt: (id, reason, assignmentId) => {
          const ticket = store.tickets.get(id), assignment = ticket && latestAssignment(ticket)
          if (ticket && !ticket.ended && assignment?.id === assignmentId && assignment.state !== 'ended' && assignment.report?.state !== 'ready'
            && assignment.report?.summary !== reason) runtime.engine.report(id, { state: 'blocked', summary: reason })
          executor.halt(id, reason, assignmentId)
        } })
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured() && setup.deployment.repository) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      this.supervision = new Supervision({ store, engine, stateDir: machine.stateDir,
        configured: () => setup.configured() && !this.closing() && !this.lifetime.aborted, health: () => this.health,
        executionEvidence: ticket => this.executor.executionEvidence(ticket) })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = async () => { await speculation.tick(); schedules.tick(); engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing() })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.disposers.push(watchOperatorChat(ctx, () => this.masterId, trigger => {
        if (engine.receive(trigger) === 'stored') passes.request()
      }, message => ctx.logger.warn('dsh-superagent did not store an operator message: %s', message)))
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources, library, verification, planning: workspace.plans, reflections, personas, worlds: this.worlds, attachments: this.attachments,
        allowPublicFetch: () => { try { return !this.commands.deployment.github } catch { return false } },
        fetchAllowlist: () => operatorConfig(store.settings()).fetchAllowlist,
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      if (this.ownership) {
        const lost = () => {
          if (this.closingFlag) return
          this.executionOwnershipLost = true
          this.executor.prepareShutdown()
          this.initialized = false; this.stopped.abort(this.ownership!.signal.reason)
          this.runtimeHealth.set({ state: 'error', detail: 'Coordinator ownership lost; execution is stopped. Restart only after inspecting receipts.', at: now() })
          void this.passes.stop().catch(report)
          for (const id of [this.masterId, ...store.tickets.list().map(ticket => workerSessionId(ticket.id))])
            ctx.agents.get(id as SessionId)?.cancel({ kind: 'user' }, { keepInbox: true })
          this.quiescing = this.executor.shutdown().catch(report)
        }
        this.ownership.signal.addEventListener('abort', lost, { once: true })
        this.disposers.push(() => this.ownership!.signal.removeEventListener('abort', lost))
      }
      this.ready = this.initialize().catch(async error => {
        await this.ownership?.close()
        if (!this.closingFlag) this.runtimeHealth.set({ state: 'error', detail: `Initialization failed: ${String(error)}`, at: now() })
        throw error
      })
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { void openedVoice?.stop(); opened?.close(); void bootstrap?.ownership.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> {
    const ready = !this.closingFlag && this.environments.ready()
    this.environmentHealth.set({ state: ready ? 'ready' : 'paused',
      detail: ready ? 'Execution environment is enrolled and verified' : 'Execution environment needs enrollment, verification or authorization' })
    return this.board.all
  }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag || this.lifetime.aborted }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.initialized || this.closing() || !ownershipReady(this.ownership) || !this.setup.configured() || !this.environments.ready() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    await this.ownership?.start()
    this.lifetime.throwIfAborted()
    if (this.ownership && this.remoteWorkspace) await this.remoteWorkspace.world.refresh()
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    await this.environments.initialize().catch(error => this.ctx.logger.warn('Execution environment enrollment: %s', String(error)))
    await this.worlds.initialize()
    if (this.closing()) return
    if (this.remoteWorkspace && !this.environments.ready()) {
      this.runtimeHealth.set({ state: 'paused', detail: 'Remote execution environment requires authorization or enrollment', at: now() }); return
    }
    await this.attachments.restoreImages()
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.remoteWorkspace?.world.grant.root ?? this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.initialized = true
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    this.conversations.start()
    this.verification.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, machine, masterId, get ready() { return runtime.ready }, sourceLinks, remoteRoot: this.remoteWorkspace?.world.grant.root,
      ownership: this.ownership, authorizeMutation: () => { this.ownership?.proof(); this.lifetime.throwIfAborted() },
      publications: this.publications, repositoryExports: this.repositoryExports, repositoryPublications: this.repositoryPublications, voice: this.voice, attachments: this.attachments,
      verification: this.verification,
      verificationReviews: this.verificationReviews,
      channelPublications: this.channelPublications,
      conversations: this.conversations,
      get health() { return runtime.health }, remoteEffects: this.remoteWorkspace?.world,
      supervision: this.supervision, workspace: this.workspace, schedules: this.schedules, reflections: this.reflections, speculation: this.speculation, usage: this.usage, library: this.library, inbox: this.inbox, environments: this.environments, endpoints: this.endpoints, personas: this.personas, worlds: this.worlds,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.executor.prepareShutdown()
    this.closingFlag = true; const passes = this.passes.stop(), reviews = this.verificationReviews.stop(), verification = this.verification.stop(); this.stopped.abort()
    // Abort an acquisition wait before awaiting any startup-dependent work; loss is terminal for this instance.
    const ownership = this.ownership?.close()
    try {
      await reviews; await verification
      await this.repositoryPublications.stop()
      await this.repositoryExports.stop()
      await this.voice.stop()
      await this.attachments.stop()
      await this.endpoints.stop()
      await this.publications.stop()
      await this.workspace.pulls?.stop()
      await this.workspace.completions.stop()
      await this.channelPublications.stop()
      await this.conversations.stop()
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      await this.speculation.close()
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await (this.quiescing ??= this.executor.shutdown())
      this.executor.dispose()
      this.sessions.dispose()
      await this.worlds.stop()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      await ownership
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
