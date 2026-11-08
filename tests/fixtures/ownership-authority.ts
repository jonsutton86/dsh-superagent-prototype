/** Independent real HTTP ownership authority with generated private credentials and explicit restart control. */
import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { OwnershipAuthority } from '../../src/ownership/authority.ts'
import { OwnershipClient } from '../../src/ownership/client.ts'
import { ownershipHandler } from '../../src/ownership/http.ts'
import type { OwnershipEnrollment } from '../../src/ownership/protocol.ts'

export async function ownershipAuthority(cleanup: (() => Promise<unknown>)[]) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owned-runtime-')))
  let authority = new OwnershipAuthority(directory)
  const server = createServer((req, res) => { void ownershipHandler(authority)(req, res).catch(() => res.destroy()) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); authority.close(); await rm(directory, { recursive: true, force: true }) })
  const connection = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, authorityId: authority.id, credentialFile: join(directory, 'admin.token') }
  const admin = new OwnershipClient(connection), enrollment = await admin.call<OwnershipEnrollment>({ op: 'coordinator.create', requestId: randomUUID(), id: 'coordinator', resources: ['endpoint'] })
  const claimantFile = join(directory, 'claimant.token'), resourceFile = join(directory, 'resource.token')
  await writeFile(claimantFile, enrollment.credential, { mode: 0o600 }); await writeFile(resourceFile, enrollment.resources[0]!.credential, { mode: 0o600 })
  const config = { ...connection, credentialFile: claimantFile, coordinatorId: 'coordinator', leaseMs: 3000, prepareTimeoutMs: 5000 }
  return { directory, admin, config, claimant: admin.withCredential(enrollment.credential),
    resource: { ...connection, credentialFile: resourceFile, coordinatorId: 'coordinator', resourceId: 'endpoint' },
    restart: () => { authority.close(); authority = new OwnershipAuthority(directory) },
  }
}
