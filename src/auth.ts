import type { AuthenticatedUser, AuthVerifier } from './types.js';

interface SupabaseUserResponse {
  id?: unknown;
  email?: unknown;
  user_metadata?: { full_name?: unknown; name?: unknown };
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSupabaseAuthVerifier(
  baseUrl: string,
  publishableKey: string,
): AuthVerifier {
  return async (token: string): Promise<AuthenticatedUser | null> => {
    const response = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok)
      throw new Error(`Supabase Auth returned ${response.status}`);

    const body = (await response.json()) as SupabaseUserResponse;
    if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) return null;
    const email = typeof body.email === 'string' ? body.email : null;
    const rawName = body.user_metadata?.full_name ?? body.user_metadata?.name;
    const fallbackName = email?.split('@')[0]?.trim() || 'Member';
    const displayName =
      typeof rawName === 'string' && rawName.trim()
        ? rawName.trim().slice(0, 120)
        : fallbackName;
    return { id: body.id, email, displayName };
  };
}
