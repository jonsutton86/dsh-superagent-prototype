import type { EndpointStorage, StorageIntent, StorageObservation, StorageReservation } from './storage-model.ts'
import { StorageReservations, storageRoots } from './storage-journal.ts'

export interface StorageHost {
  /** Trusted privileged adapter: creates protected, initially empty roots and applies the exact reserved quota. */
  provision(policy: EndpointStorage, reservation: StorageReservation, roots: readonly string[], signal: AbortSignal): Promise<void>
  /** Read actual host state, never an agent report or the previous stored observation. */
  observe(policy: EndpointStorage, reservation: StorageReservation, roots: readonly string[], signal: AbortSignal): Promise<StorageObservation>
}

/** No retry of uncertain host writes. Original allocation and intent live in the endpoint's existing journal. */
export class StorageProvisioning {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly reservations: StorageReservations, private readonly host: StorageHost) {}
  prepare(input: StorageIntent, signal: AbortSignal): Promise<StorageReservation> {
    const run = async () => {
      signal.throwIfAborted()
      const original = this.reservations.reserve(input), roots = storageRoots(this.reservations.policy, original)
      if (this.reservations.beginProvisioning(input)) {
        // The committed transition precedes the host effect, including cancellation at the boundary.
        await this.host.provision(this.reservations.policy, original, roots, signal)
      }
      signal.throwIfAborted()
      const observed = await this.host.observe(this.reservations.policy, original, roots, signal)
      signal.throwIfAborted()
      return this.reservations.recordObservation(input, observed)
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
}
