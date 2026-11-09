/** Source contracts shared by the running coordinator and passive recovery inspection. */
import { z } from 'zod'
import type { SourceKind } from './kind.ts'

export type SourceContract = Pick<SourceKind, 'kind' | 'schema' | 'policy'>
export const workspaceContract: SourceContract = { kind: 'workspace', schema: z.object({}).strict() }
export const publicationContract: SourceContract = { kind: 'publication', schema: z.object({}).strict() }
export const conversationContract: SourceContract = { kind: 'conversation', schema: z.object({}).strict() }
/** Owned coordinators use fenced publication/conversation adapters; local execution has no repository source. */
export const sourceAvailable = (mode: { owned: boolean; publication: boolean; local: boolean }, id: string): boolean => mode.owned
  ? id === 'workspace' || (id === 'publication' || id === 'conversation') && mode.publication
  : id !== 'github' || !mode.local
