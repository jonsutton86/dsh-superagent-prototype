/** Immutable persona definitions and references carried by reviewed action plans and execution snapshots. */
import { z } from 'zod'
import { RoleModelSchema } from '../role-model.ts'

export const PersonaRef = z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict()
export type PersonaRef = z.infer<typeof PersonaRef>
export const PERSONA_CAPABILITIES = ['read', 'write', 'commands', 'web', 'delegation', 'skills'] as const
export const PersonaDefinition = z.object({ name: z.string().trim().min(1).max(160), description: z.string().trim().max(2000),
  instructions: z.string().trim().min(1).max(12000), model: RoleModelSchema.nullable(),
  capabilities: z.array(z.enum(PERSONA_CAPABILITIES)).max(PERSONA_CAPABILITIES.length),
  skills: z.array(z.object({ name: z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/), description: z.string().trim().min(1).max(300),
    content: z.string().trim().min(1).max(12000) }).strict()).max(32) }).strict().superRefine((value, ctx) => {
  if (new Set(value.capabilities).size !== value.capabilities.length) ctx.addIssue({ code: 'custom', message: 'Tool capabilities must be unique' })
  if (new Set(value.skills.map(skill => skill.name)).size !== value.skills.length) ctx.addIssue({ code: 'custom', message: 'Skill names must be unique' })
  if (value.skills.length && !value.capabilities.includes('skills')) ctx.addIssue({ code: 'custom', message: 'Persona skills require the skills capability' })
  if (JSON.stringify(value).length > 64_000) ctx.addIssue({ code: 'custom', message: 'A persona definition must fit within 64,000 characters' })
})
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const CreatePersona = z.object({ requestId, definition: PersonaDefinition }).strict()
export const SavePersona = z.object({ requestId, revision: z.number().int().positive(), definition: PersonaDefinition }).strict()
export const ArchivePersona = z.object({ requestId, revision: z.number().int().positive(), archived: z.boolean(), reason: z.string().trim().min(1).max(2000) }).strict()
export const PersonaQuery = z.object({ offset: z.coerce.number().int().nonnegative().default(0), q: z.string().trim().max(160).default(''),
  active: z.enum(['true', 'false']).optional() }).strict()
export type PersonaDefinition = z.infer<typeof PersonaDefinition>
export type CreatePersonaInput = z.input<typeof CreatePersona>
export type SavePersonaInput = z.input<typeof SavePersona>
export type ArchivePersonaInput = z.input<typeof ArchivePersona>
export interface PersonaVersion extends PersonaRef { definition: PersonaDefinition; createdAt: string; digest: string }
export interface PersonaRecord extends PersonaVersion { revision: number; archived: boolean; updatedAt: string }
export interface PersonaSummary extends Omit<PersonaRecord, 'definition' | 'digest'> { name: string; description: string; model: PersonaDefinition['model']; capabilities: PersonaDefinition['capabilities'] }
export interface PersonaList { items: PersonaSummary[]; nextOffset: number | null }
/** The entire immutable definition travels with its ticket; later persona edits cannot change an existing run. */
export type PersonaSnapshot = PersonaVersion
