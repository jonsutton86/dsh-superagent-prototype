import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let host: Host | undefined
afterEach(async () => { await host?.stop(); host = undefined })

it('publishes a Markdown artifact through the existing library and lists it by kind', async () => {
  host = await startRuntime(undefined, { executionMode: 'local', noAccounts: true })
  const created = await host.api('POST', 'library', { requestId: randomUUID(), kind: 'artifact', scope: 'workspace',
    title: 'Creative brief', summary: 'A short brief', mime: 'text/markdown', filename: 'creative.md', encoding: 'utf8',
    content: '# Brief\n\nShip the creative workspace.' })
  expect(created.status).toBe(200)
  const listed = await host.api('GET', 'library?kind=artifact')
  expect(listed.body).toMatchObject({ items: [expect.objectContaining({ title: 'Creative brief', kind: 'artifact' })] })
  const read = await host.api('GET', `library/${(listed.body.items as { id: string }[])[0]!.id}/content`)
  expect(Buffer.from(String(read.body.data), 'base64').toString('utf8')).toBe('# Brief\n\nShip the creative workspace.')
})
