/** Source contracts shared by the running coordinator and passive recovery inspection. */
import { z } from 'zod'
import type { SourceKind } from './kind.ts'

export type SourceContract = Pick<SourceKind, 'kind' | 'schema' | 'policy'>
const httpsPrefix = z.string().trim().min(1).max(300).refine(value => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch { return false }
}, 'Use an https URL prefix without credentials')
export const operatorContract: SourceContract = { kind: 'operator', schema: z.object({
  fetchAllowlist: z.array(httpsPrefix).max(20).default([]),
}).strict() }
export const repositoryContract: SourceContract = { kind: 'repository', schema: z.object({
  root: z.string().max(4096).default('').refine(value => value === '' || value.startsWith('/'), 'Use an absolute checkout path'),
  repository: z.string().max(200).default('').refine(value => value === '' || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'Use owner/name'),
  branch: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._/-]+$/, 'Use a branch name').default('main'),
}).strict() }
export const workspaceContract: SourceContract = { kind: 'workspace', schema: z.object({}).strict() }
export const publicationContract: SourceContract = { kind: 'publication', schema: z.object({}).strict() }
export const conversationContract: SourceContract = { kind: 'conversation', schema: z.object({}).strict() }
/** Owned coordinators use fenced publication/conversation adapters. Operator chat and the local repository profile stay available. */
export const sourceAvailable = (mode: { owned: boolean; publication: boolean; local: boolean }, id: string): boolean => {
  if (id === 'operator' || id === 'repository') return true
  return mode.owned
    ? id === 'workspace' || (id === 'publication' || id === 'conversation') && mode.publication
    : id !== 'github' || !mode.local
}
