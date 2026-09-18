/** Prefer the deepest published project among same-file selections. */
export function routeToOwners<T>(
  items: readonly T[],
  resolve: (item: T) => { uri: string; root: string } | undefined,
): { kept: T[]; dropped: T[] } {
  const deepestRoots = new Map<string, number>();
  const entries = items.map((item) => {
    const target = resolve(item);
    if (target) {
      deepestRoots.set(
        target.uri,
        Math.max(deepestRoots.get(target.uri) ?? 0, target.root.length),
      );
    }
    return { item, target };
  });
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const { item, target } of entries) {
    if (!target || target.root.length === deepestRoots.get(target.uri)) {
      kept.push(item);
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}
