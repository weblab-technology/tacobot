import { getBoltApp } from "./bolt";

/**
 * Pick a human-readable name from a Slack user object. Prefers display_name,
 * then real_name, then the user's `name` field. Returns null if none are set.
 */
export function pickName(u: {
  profile?: { display_name?: string; real_name?: string };
  name?: string;
}): string | null {
  const dn = u.profile?.display_name?.trim();
  if (dn) return dn;
  const rn = u.profile?.real_name?.trim();
  if (rn) return rn;
  const n = u.name?.trim();
  return n || null;
}

type Entry = { name: string; fetchedAt: number };

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();

export function _resetUserInfoCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Resolve a Slack user's display name via users.info. Module-level cache with
 * a 1h TTL and in-flight dedup so repeated lookups for the same id within a
 * short window cost one Slack call. Returns null on bot/deleted/missing users
 * or if the API call fails — callers should treat null as "no good name yet".
 */
export async function resolveUserName(id: string): Promise<string | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.name;

  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await getBoltApp().client.users.info({ user: id });
      if (!res.user || res.user.is_bot || res.user.deleted) return null;
      const name = pickName(res.user);
      if (name) cache.set(id, { name, fetchedAt: Date.now() });
      return name;
    } catch (err) {
      console.warn(`[users.info] failed for ${id}`, err);
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}
