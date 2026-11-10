/** Versioned operator alerts. Receiver acceptance is not human acknowledgement or recovery authority. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const ALERT_LIMIT = 1000
export const ALERT_TERMINAL_DAYS = 30
export const AlertRouteSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), name: z.string().trim().min(1).max(100),
  url: z.string().max(2048).refine(value => {
    try {
      const url = new URL(value)
      return !url.username && !url.password && !url.hash && !url.search
        && (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    } catch { return false }
  }, 'HTTPS or literal loopback HTTP is required, without credentials, query or fragment'),
  tokenFile: z.string().min(1).max(4096).startsWith('/'),
  cooldownMs: z.number().int().min(1000).max(86400000).default(300000),
}).strict()
export type AlertRoute = z.infer<typeof AlertRouteSchema>
export const AlertRoutesSchema = z.array(AlertRouteSchema).max(16).refine(routes => new Set(routes.map(route => route.id)).size === routes.length, 'Duplicate alert route')
export type AlertPhase = 'prepared' | 'sending' | 'accepted' | 'rejected' | 'unknown' | 'cancelled'
export interface AlertPayload {
  subjectId: string; incidentId?: string; evidenceRevision: string; title: string; finding: string;
  evidence: string; observedAt: number; trust: 'untrusted-observation';
}
export interface AlertView {
  id: string; routeId: string; routeName: string; subjectId: string; incidentId?: string; evidenceRevision: string;
  title: string; finding: string; createdAt: number; updatedAt: number; phase: AlertPhase;
  dispatchedAt?: number; reason?: string; payloadHash: string; destinationHash: string;
}
export interface AlertRecord extends AlertView { payload: AlertPayload }
export interface AlertList {
  routes: { id: string; name: string }[]; items: AlertView[];
  capacity: { used: number; limit: number; sourcesUsed?: number; sourcesLimit?: number; reservationsUsed?: number; reservationsLimit?: number }; cursor: string | null;
}
export interface AlertCandidate extends Omit<AlertPayload, 'evidenceRevision' | 'trust'> { evidenceKey: string }
export const AlertReceiverReceiptSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['accepted', 'rejected', 'pending']),
}).strict()
export const alertHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const alertDestinationHash = (route: AlertRoute) => alertHash({ id: route.id, name: route.name, url: route.url, tokenFile: route.tokenFile })
export function alertView({ payload: _payload, ...view }: AlertRecord): AlertView { return view }
