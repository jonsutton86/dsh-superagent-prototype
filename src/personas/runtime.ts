import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type { PersonaSnapshot } from './model.ts'

const CAPABILITY_TOOLS = {
  read: ['read', 'read_image', 'glob', 'grep', 'workspace_attachments', 'workspace_attachment_read'], write: ['write', 'edit', 'workspace_attachment_copy'], commands: ['bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'workspace_attachment_copy'],
  web: ['web_search', 'web_fetch'], delegation: ['subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent'], skills: ['skill'],
} as const
export function personaDenial(persona: PersonaSnapshot, tool: string): string | undefined {
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS))
    if ((tools as readonly string[]).includes(tool) && !persona.definition.capabilities.includes(capability as keyof typeof CAPABILITY_TOOLS))
      return `Persona ${persona.definition.name} version ${persona.version} does not allow the ${capability} tool capability`
  return undefined
}

/** Install the ticket's immutable instructions, skills and tool guard on a worker or descendant, without granting new authority. */
export async function bindPersona(agent: Agent, persona: PersonaSnapshot): Promise<() => void> {
  const disposers: (() => void)[] = [], { definition } = persona
  try {
    disposers.push(agent.ctx.tools.guard(execution => personaDenial(persona, execution.name)))
    disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-persona', order: 9998, interpolate: false,
      text: `[Persona ${definition.name}, version ${persona.version}, digest ${persona.digest}]\n${definition.instructions}\n`
        + `Allowed optional tool capabilities: ${definition.capabilities.join(', ') || 'none'}. The mission mandate, environment grant and host tool policy still apply.` }))
    const skillScope = agent.ctx.inject(['skills'], ctx => {
      for (const skill of definition.skills) ctx.skills.register({ ...skill, name: `persona-${persona.id}-${persona.version}-${skill.name}`, source: 'runtime' })
    })
    disposers.push(() => { void skillScope.dispose().catch(error => agent.ctx.logger.warn('Could not release persona skills: %s', String(error))) })
    await skillScope
    return () => disposers.reverse().forEach(dispose => dispose())
  } catch (error) { disposers.reverse().forEach(dispose => dispose()); throw error }
}
