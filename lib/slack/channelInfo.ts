import { getBoltApp } from "./bolt";

type Entry = { name: string; fetchedAt: number };

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();

export function _resetChannelInfoCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Resolve a Slack channel's name via conversations.info. Module-level cache
 * with a 1h TTL and in-flight dedup so repeated lookups for the same id within
 * a short window cost one Slack call. Returns null on missing channel or API
 * failure — callers should fall back to displaying the raw id.
 */
export async function resolveChannelName(id: string): Promise<string | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.name;

  const existing = inflight.get(id);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await getBoltApp().client.conversations.info({ channel: id });
      const name = res.channel?.name?.trim() || null;
      if (name) cache.set(id, { name, fetchedAt: Date.now() });
      return name;
    } catch (err) {
      // Slack WebAPI errors carry a string code on err.data.error
      // (e.g. "missing_scope", "channel_not_found", "not_in_channel").
      // Surface it explicitly so missing scopes are easy to diagnose.
      const code = (err as { data?: { error?: string } } | undefined)?.data?.error;
      if (code) {
        console.warn(`[conversations.info] ${id} -> ${code}`);
      } else {
        console.warn(`[conversations.info] failed for ${id}`, err);
      }
      return null;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, p);
  return p;
}
