import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindPersona } from '../src/personas/runtime.ts'
import type { PersonaSnapshot } from '../src/personas/model.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
it('uses Harness scoped prompts, skill registries and monotonic guards without affecting another worker', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Skills)
  await ctx.inject(['systemPrompt', 'tools', 'skills'], async ctx => {
    const agent = { id: 'persona-runtime', session: Session.create(SessionId('persona-runtime')) } as Agent
    const scope = createScope(ctx, agent); Object.assign(agent, { ctx: scope.ctx })
    const other = { id: 'other-worker', session: Session.create(SessionId('other-worker')) } as Agent
    const otherScope = createScope(ctx, other); Object.assign(other, { ctx: otherScope.ctx })
    const execute = vi.fn(async () => 'executed')
    for (const name of ['read', 'bash', 'subagent', 'workspace_publish']) ctx.tools.register(defineTool({ name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, execute }))
    const persona: PersonaSnapshot = { id: '5ade6e49-4fd8-4120-949a-ceea7881c95e', version: 1, digest: 'proof', createdAt: new Date().toISOString(),
      definition: { name: 'Reader', description: '', instructions: 'Preserve ${{ literal }} exactly.', model: null, capabilities: ['read', 'skills'],
        skills: [{ name: 'evidence', description: 'Evidence procedure', content: 'Scoped evidence instructions' }] } }
    const dispose = await bindPersona(agent, persona)
    const prompt = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))
    expect(prompt).toContain('Preserve ${{ literal }} exactly.')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: other }))).not.toContain('Reader')
    const skills = await ctx.skills.list({ scope: agent })
    expect(skills).toHaveLength(1)
    expect((await ctx.skills.get(skills[0]!.name, { scope: agent }))!.content).toBe('Scoped evidence instructions')
    expect(await ctx.skills.list({ scope: other })).toEqual([])
    // A later permissive pre-execute listener cannot override a persona denial, even for agent-local tool registration.
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    agent.ctx.tools.register(defineTool({ name: 'bash', description: 'Local shell', parameters: {},
      output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] }, execute }))
    const call = (name: string, owner = agent) => ctx.tools.execute({ callId: `test-${name}` as never, name, arguments: {}, agent: owner, signal: new AbortController().signal })
    expect(JSON.stringify(await call('bash'))).toContain('commands')
    expect(JSON.stringify(await call('subagent'))).toContain('delegation')
    expect(execute).not.toHaveBeenCalled()
    await call('read'); await call('workspace_publish'); await call('bash', other)
    expect(execute).toHaveBeenCalledTimes(3)
    dispose()
    await vi.waitFor(async () => expect(await ctx.skills.list({ scope: agent })).toEqual([]))
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))).not.toContain('Reader')
    await scope.dispose(); await otherScope.dispose()
  })
})
