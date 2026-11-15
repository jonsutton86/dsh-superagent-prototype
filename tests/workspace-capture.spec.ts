import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { RemoteJournal } from '../src/remote/journal.ts'
import { WorkspaceCaptures } from '../src/remote/workspace-capture.ts'

it('retains started and complete capture identities across database reopen without replacing their original binding', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capture-journal-')), control = join(directory, 'control'), root = join(directory, 'root')
  let journal = new RemoteJournal(control, root)
  try {
    const captures = new WorkspaceCaptures(journal), request = { requestId: randomUUID(), grantId: randomUUID(), epoch: 1,
      destination: join(directory, 'archive'), maxEntries: 100, maxBytes: 1024 }
    const binding = { endpointId: journal.id, grantId: request.grantId, epoch: 1, revision: 1, workspace: 'original', root, rootIdentity: '1:2:3' }
    const started = captures.begin(request, binding)
    journal.close(); journal = new RemoteJournal(control, root)
    const reopened = new WorkspaceCaptures(journal)
    expect(reopened.read(request)).toEqual(started)
    expect(reopened.begin(request, { ...binding, rootIdentity: 'replacement' })).toEqual(started)
    expect(() => reopened.read({ ...request, grantId: randomUUID() })).toThrow('another payload')
    const output = { path: request.destination, inventoryHash: 'a'.repeat(64), manifestHash: 'b'.repeat(64),
      managedQuiescenceObserved: true as const, globalSnapshotVerified: false as const, restoreVerified: false as const }
    const complete = reopened.complete(request, output)
    journal.close(); journal = new RemoteJournal(control, root)
    expect(new WorkspaceCaptures(journal).read(request)).toEqual(complete)
    expect(() => new WorkspaceCaptures(journal).complete(request, output)).toThrow('original started intent')
    journal.db.prepare('UPDATE endpoint_meta SET value=? WHERE key=?').run(JSON.stringify({ ...complete, binding: { ...binding, endpointId: randomUUID() } }), 'workspace-capture:' + request.requestId)
    expect(() => new WorkspaceCaptures(journal).read(request)).toThrow('identity differs')
  } finally { journal.close(); rmSync(directory, { recursive: true, force: true }) }
})
