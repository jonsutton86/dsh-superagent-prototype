/** Real encrypted checkpoints and Harness JSONL containing the coordinator fixture's observed Session events. */
import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { Session } from '@deepseek-ai/dsh-session'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { repositoryWorkspaceFixture } from './repository-workspace.ts'
import { inferenceFixture } from './inference.ts'
import { createRecoveryKey } from '../../src/recovery/crypto.ts'
import { createCheckpoint, stageCheckpoint } from '../../src/recovery/checkpoint.ts'
import { reserveCheckpointOwnership } from '../../src/recovery/ownership.ts'
import { recoverySourceHost } from '../../src/recovery/sources.ts'
import { SourceCatalog } from '../../src/sources/catalog.ts'
import { feishuKind } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'

export async function repositoryRecoveryFixture(cleanup: (() => Promise<unknown>)[]) {
  const sessions = new Map<string, Session>(), h = await repositoryWorkspaceFixture(cleanup, { captureSessions: sessions })
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repository-recovery-')))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const context = new Context(); cleanup.push(() => context.fiber.dispose())
  await context.plugin(Jsonl, { root: join(directory, 'sessions'), compression: 'none' })
  const inference = await inferenceFixture(context), sources = new SourceCatalog(context)
  sources.register(feishuKind); sources.register(githubKind)
  const snapshot = async () => {
    const epoch = h.runtime.ownership!.status().owner!.epoch
    await h.runtime.stop()
    // Persist exactly the events captured at consumption/append, without creating replacement messages or markers.
    for (const session of sessions.values()) {
      const writer = await context.sessionPersistence.create(session.header)
      try { await writer.append(session.snapshotEvents()) } finally { await writer.close() }
    }
    const keyFile = join(directory, 'recovery.key'); createRecoveryKey(keyFile)
    const checkpoint = await createCheckpoint({ stateDir: h.host.directory, outputDir: join(directory, 'checkpoints'), keyFile, persistence: context.sessionPersistence })
    const held = join(directory, 'held'); await stageCheckpoint(checkpoint.path, keyFile, held)
    const authority = { ...h.authority.admin.connection, coordinatorId: h.authority.config.coordinatorId }
    await reserveCheckpointOwnership({ checkpoint: checkpoint.path, keyFile, destination: held, authority, requestId: randomUUID(), epoch, generation: 0 })
    const audit = { checkpoint: checkpoint.path, keyFile, destination: held, authority, persistence: context.sessionPersistence, inference: inference.host,
      sources: recoverySourceHost(context), endpoints: [{ ...h.remote.connection, ownership: undefined, credentialFile: await realpath(h.remote.connection.credentialFile) }], publication: h.publisher.admin.config,
      publicationClient: h.publisher.connection }
    return { checkpoint, audit, held, keyFile }
  }
  return { ...h, context, directory, sessions, snapshot }
}
