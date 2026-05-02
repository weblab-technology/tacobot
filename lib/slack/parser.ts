const TACO_RE = /:taco:/g;

export function countTacos(text: string): number {
  if (!text) return 0;
  // Use exact `:taco:` token; no false positives from `:tacos:` because
  // we anchor on the closing colon.
  return text.match(TACO_RE)?.length ?? 0;
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
