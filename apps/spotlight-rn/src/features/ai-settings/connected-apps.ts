import { supabase } from '@/lib/supabase';

/** One AI client (Claude, ChatGPT, ...) the user approved on the consent page. */
export type ConnectedApp = {
  clientId: string;
  name: string;
  grantedAt: string | null;
};

/**
 * Null = grants can't be listed here (no Supabase client, or the call failed,
 * e.g. the project's OAuth server is off). Uses supabase-js's OAuth 2.1 server
 * user API (`auth.oauth.listGrants`).
 */
export async function listConnectedApps(): Promise<ConnectedApp[] | null> {
  if (!supabase) {
    return null;
  }
  try {
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error || !Array.isArray(data)) {
      return null;
    }
    return data
      .filter((grant) => typeof grant?.client?.id === 'string')
      .map((grant) => ({
        clientId: grant.client.id,
        grantedAt: grant.granted_at ?? null,
        name: grant.client.name?.trim() || 'AI app',
      }));
  } catch {
    return null;
  }
}

/** Revokes consent plus that client's sessions and refresh tokens. True on success. */
export async function revokeConnectedApp(clientId: string): Promise<boolean> {
  if (!supabase) {
    return false;
  }
  try {
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
    return !error;
  } catch {
    return false;
  }
}
