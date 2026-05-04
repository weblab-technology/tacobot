const DEFAULT_EMOJIS: readonly string[] = ["taco"];

export function countTacos(
  text: string,
  emojiNames: readonly string[] = DEFAULT_EMOJIS,
): number {
  if (!text) return 0;
  if (emojiNames.length === 0) return 0;
  // Anchor on both colons so `:tacos:` (or any longer name) doesn't match
  // `:taco:`. Names are escaped because the alt-emoji name comes from env.
  const re = new RegExp(`:(?:${emojiNames.map(escapeRegex).join("|")}):`, "g");
  return text.match(re)?.length ?? 0;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;

export function findUserIds(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    seen.add(m[1]);
  }
  return [...seen];
}
