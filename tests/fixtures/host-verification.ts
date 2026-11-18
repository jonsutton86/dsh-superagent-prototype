import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import type { Host } from './host.ts'

/** Give a deterministic model fixture actual source files and the real Harness check subprocess provider. */
export async function hostVerification(host: Host, ticketId: string, cleanup: (() => void | Promise<unknown>)[]) {
  const source = join(host.directory, `checked-${randomUUID()}`), ctx = new Context(), subprocess = new LocalSubprocessRuntime(ctx)
  cleanup.push(() => ctx.fiber.dispose()); await mkdir(source)
  const ticket = host.runtime.store.tickets.get(ticketId)!
  ticket.execution!.directory = source
  ticket.assignments.at(-1)!.execution = { directory: source, mode: ticket.execution!.mode, environment: ticket.execution!.environment }
  host.runtime.store.tickets.save(ticket)
  host.subprocess.spawn.mockImplementation(spec => subprocess.spawn(spec as Parameters<typeof subprocess.spawn>[0]) as never)
  Object.assign(host.subprocess, { resolveExecutable: subprocess.resolveExecutable.bind(subprocess) })
  return async (artifactId: string, content: string, filename = 'artifact.txt') => {
    await writeFile(join(source, filename), content)
    const verification = host.runtime.verification, artifact = host.runtime.library.read(artifactId)
    const definition = verification.definitions.create({ requestId: randomUUID(), enabled: true, definition: { name: 'Fixture output', description: 'The actual output is nonempty',
      argv: ['/bin/sh', '-c', 'test -s "$1"', 'check', filename], artifactPath: filename, confinement: 'host-process' } })
    const run = await verification.request(artifactId, { requestId: randomUUID(), artifactHash: artifact.hash, artifactRevision: artifact.revision, check: { id: definition.id, version: 1 } })
    await vi.waitFor(() => expect(verification.get(run.id).status, verification.get(run.id).problem).toBe('passed'), { timeout: 10000 })
    return verification.approval(run.id).selection
  }
}
