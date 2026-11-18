/** Host-side administration API. Store credentials outside agent workspaces; never expose this client as a worker tool. */
export { RemoteClient, RemoteUncertain, type RemoteConnection } from './client.ts'
export { SnapshotSpec, VerificationJob, type SnapshotManifest, type CheckEvidence } from '../verification/model.ts'
export { validateSnapshot, sameSnapshotFiles } from '../verification/snapshot.ts'
export { RemoteError, REMOTE_VERSION, RPC_PATH, type EndpointIdentity, type GrantReceipt, type RemoteGrant,
  type RemoteJob, type RemoteOperation, type RpcInput, type OutputWindow, type RevocationReceipt, type CredentialBinding, type EndpointCredential } from './protocol.ts'
