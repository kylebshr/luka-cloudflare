// Secrets aren't in the generated `Env`: `wrangler types` would type them as always set,
// but they're optional (without them APNs is a no-op, as in local dev).

export interface Secrets {
  /** APNs `.p8` key contents. */
  PUSH_NOTIFICATION_PEM?: string;
  /** APNs key ID. */
  PUSH_NOTIFICATION_ID?: string;
  TEAM_IDENTIFIER?: string;
}

export function secrets(env: Env): Secrets {
  return env as unknown as Secrets;
}

/** The APNs signing configuration, or undefined when any part of it is unset. */
export function apnsKey(env: Env): { pem: string; keyID: string; teamID: string } | undefined {
  const { PUSH_NOTIFICATION_PEM: pem, PUSH_NOTIFICATION_ID: keyID, TEAM_IDENTIFIER: teamID } = secrets(env);
  return pem && keyID && teamID ? { pem, keyID, teamID } : undefined;
}
