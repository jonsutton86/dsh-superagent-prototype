import { describe, expect, it } from 'vitest'
import { PERSONA_CAPABILITIES, PersonaDefinition, type PersonaSnapshot } from '../src/personas/model.ts'
import { personaDenial } from '../src/personas/runtime.ts'

const snapshot = (capabilities: PersonaSnapshot['definition']['capabilities']): PersonaSnapshot => ({
  id: '00000000-0000-4000-8000-000000000001', version: 1, createdAt: '2026-01-01T00:00:00.000Z', digest: 'digest',
  definition: PersonaDefinition.parse({ name: 'Specialist', description: 'Scoped worker', instructions: 'Work only inside the mission.',
    model: { provider: 'openai', model: 'specialist-model' }, capabilities, skills: [] })
})

describe('native worker specialization', () => {
  it('maps each capability to its worker tools and denies everything the persona did not grant', () => {
    const readOnly = snapshot(['read'])
    for (const tool of ['read', 'read_image', 'glob', 'grep']) expect(personaDenial(readOnly, tool)).toBeUndefined()
    for (const tool of ['write', 'edit', 'bash', 'pwsh', 'web_search', 'subagent', 'skill'])
      expect(personaDenial(readOnly, tool)).toMatch(/does not allow/)
  })

  it('grants only the declared capabilities and leaves unrelated tools alone', () => {
    const writer = snapshot(['read', 'write', 'commands'])
    for (const tool of ['read', 'write', 'edit', 'bash', 'pwsh']) expect(personaDenial(writer, tool)).toBeUndefined()
    expect(personaDenial(writer, 'web_search')).toMatch(/web/)
    expect(personaDenial(writer, 'subagent')).toMatch(/delegation/)
    expect(personaDenial(writer, 'skill')).toMatch(/skills/)
    expect(personaDenial(writer, 'workspace_list')).toBeUndefined()
  })

  it('carries the specialization model and denies every optional capability when none are granted', () => {
    const none = snapshot([])
    expect(none.definition.model).toEqual({ provider: 'openai', model: 'specialist-model' })
    for (const capability of PERSONA_CAPABILITIES) {
      const tool = capability === 'read' ? 'read' : capability === 'write' ? 'write' : capability === 'commands' ? 'bash'
        : capability === 'web' ? 'web_fetch' : capability === 'delegation' ? 'send_message' : 'skill'
      expect(personaDenial(none, tool)).toMatch(/does not allow/)
    }
  })
})
