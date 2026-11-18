/** One explicit Tailscale HTTPS origin; never trust forwarded headers or wildcard suffixes. */
export function readTrustedOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.DSH_ORCHESTRATOR_TRUSTED_ORIGIN
  if (value === undefined) return undefined
  // Require canonical spelling: no credentials, port (including :443), path, query or fragment.
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(value))
    throw new Error('DSH_ORCHESTRATOR_TRUSTED_ORIGIN must be one canonical HTTPS Tailscale origin without a port or path')
  return value
}
