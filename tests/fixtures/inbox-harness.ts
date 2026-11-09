/** Installed-Harness qualification for reviewed inbox persona/environment dispatch and persisted execution details. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
type Api = (path: string, body?: unknown, method?: string) => Promise<any>
export async function qualifyInboxSettings(api: Api, world: { id: string; root: string; name: string }, owned: boolean): Promise<() => Promise<void>> {
  const setup = await api('inbox/setup')
  if (owned) expect(setup.defaultEnvironment.available).toBe(false)
  const proof = `inbox-proof-${randomUUID()}`
  const definition = { name: 'Inbox evidence worker', description: 'Live inbox execution qualification',
    instructions: `After checking the task environment, write exactly ${proof} to inbox.txt with no newline. Read it back, publish that exact content with workspace_publish as an artifact, then report ready.`,
    model: { provider: 'deepseek-official', model: 'deepseek-flash' }, capabilities: ['read', 'write', 'commands'], skills: [] }
  const persona = await api('personas', { requestId: randomUUID(), definition })
  const request = { requestId: randomUUID(), title: 'Inbox execution selection proof', persona: { id: persona.id, version: 1 }, environment: world.id,
    text: 'Use bash in your assigned directory to confirm SERVICE_API_KEY is unset or empty, without printing it. Then follow your persona instructions to create and publish the proof. Do not use external services or background work. If any tool fails, report failed with the error and end your turn.' }
  const item = await api('inbox', request)
  expect((await api('inbox', request)).id).toBe(item.id)
  expect(item.execution).toMatchObject({ persona: { id: persona.id, version: 1, name: definition.name, model: definition.model },
    environment: { grant: { world: world.id }, description: { name: world.name } } })
  const future = await api(`personas/${persona.id}`, { requestId: randomUUID(), revision: 1,
    definition: { ...definition, name: 'Future inbox worker', instructions: 'For future tasks, write a different future proof instead.' } }, 'PUT')
  await api(`personas/${persona.id}/archive`, { requestId: randomUUID(), revision: future.revision, archived: true, reason: 'Preserve original running version' })
  await vi.waitFor(async () => expect((await api(`inbox/${item.id}`)).item.status).toBe('review'), { timeout: 90000, interval: 500 })
  const ticket = await api(`tickets/${item.id}`)
  expect(ticket.executionPersona).toMatchObject({ id: persona.id, version: 1, definition })
  expect(ticket.executionEnvironment.world).toBe(world.id); expect(ticket.directory.startsWith(world.root + '/')).toBe(true)
  expect(await readFile(join(ticket.directory, 'inbox.txt'), 'utf8')).toBe(proof)
  expect((await api('inbox', request)).id).toBe(item.id)
  return async () => {
    const conversation = await api(`inbox/${item.id}`)
    expect(conversation.item.execution).toMatchObject({ directory: ticket.directory,
      persona: { id: persona.id, version: 1, name: definition.name, model: definition.model, capabilities: definition.capabilities },
      environment: { grant: { world: world.id }, description: { name: world.name } } })
    const artifacts = await Promise.all(conversation.artifacts.map((value: { id: string }) => api(`library/${value.id}`)))
    expect(artifacts.some(value => value.provenance.ticketId === item.id && value.content === proof)).toBe(true)
  }
}
