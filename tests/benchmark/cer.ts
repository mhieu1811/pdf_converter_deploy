export function normalizeForComparison(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Character-level Levenshtein distance over NFC code points divided by reference length. */
export function characterErrorRate(reference: string, actual: string): number {
  const ref = Array.from(normalizeForComparison(reference));
  const act = Array.from(normalizeForComparison(actual));
  if (ref.length === 0) return act.length === 0 ? 0 : Infinity;
  return levenshtein(ref, act) / ref.length;
}

function levenshtein(a: string[], b: string[]): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}
