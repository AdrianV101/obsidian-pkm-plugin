/**
 * Merge ranked lists by reciprocal rank fusion: a note scores the sum of 1 / (k + rank) over the
 * lists that contain it, so notes found by several rankers rise without any score scale being shared.
 * @param {Array<Array<string|{ path: string }>>} lists - each best first
 * @param {{ k?: number }} [opts]
 * @returns {Array<{ path: string, rank: number }>} best first (rank starts at 1); equal scores sort by path
 */
export function fuseRankings(lists, { k = 60 } = {}) {
  const scores = new Map();
  for (const list of lists) {
    const seen = new Set();
    let position = 0;
    for (const item of list) {
      const p = typeof item === "string" ? item : item.path;
      if (seen.has(p)) continue;
      seen.add(p);
      position++;
      scores.set(p, (scores.get(p) ?? 0) + 1 / (k + position));
    }
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p], i) => ({ path: p, rank: i + 1 }));
}
