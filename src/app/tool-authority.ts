import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Match the model's tool surface to a name-based authority boundary, including late scope-local tools.
 * Native presentation avoids embedding forbidden capability schemas inside the PTC transport's description.
 * Presentation is not authorization: the monotonic guard also checks direct and nested dispatch.
 */
export function toolAuthority(agent: Agent, denial: (name: string) => string | undefined): () => void {
  const disposers = [
    agent.ctx.tools.presentAs('native'),
    agent.ctx.tools.guard(execution => denial(execution.name)),
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      return { ...assembly, tools: assembly.tools.filter(tool => !denial(tool.name)) }
    }),
  ]
  return () => disposers.reverse().forEach(dispose => dispose())
}
