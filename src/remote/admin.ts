/** Host-side administration API. Store credentials outside agent workspaces; never expose this client as a worker tool. */
export { RemoteClient, RemoteUncertain, type RemoteConnection } from './client.ts'
export { RemoteError, REMOTE_VERSION, RPC_PATH, type EndpointIdentity, type GrantReceipt, type RemoteGrant,
  type RemoteJob, type RemoteOperation, type RpcInput, type OutputWindow, type RevocationReceipt } from './protocol.ts'
