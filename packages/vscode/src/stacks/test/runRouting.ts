/** Prefer the deepest published project for the same file or case selection. */
export function routeToOwners<T>(
  items: readonly T[],
  resolve: (item: T) => { key: string; root: string } | undefined,
): { kept: T[]; dropped: T[] } {
  const deepestRoots = new Map<string, number>();
  const entries = items.map((item) => {
    const target = resolve(item);
    if (target) {
      deepestRoots.set(
        target.key,
        Math.max(deepestRoots.get(target.key) ?? 0, target.root.length),
      );
    }
    return { item, target };
  });
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const { item, target } of entries) {
    if (!target || target.root.length === deepestRoots.get(target.key)) {
      kept.push(item);
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}
