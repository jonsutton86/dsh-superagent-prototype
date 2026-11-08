/** Public host-side ownership composition. No model tools and no implicit activation of restored coordinator data. */
export { CoordinatorOwnership, type CoordinatorOwnershipConfig } from './lease.ts'
export { OwnershipClient, type OwnershipConnection } from './client.ts'
export { OwnershipGate, type ResourceOwnershipConfig, type OwnershipGuard } from './gate.ts'
export * from './protocol.ts'
