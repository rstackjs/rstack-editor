/** Prefer owners among same-file selections; keep explicit non-owner runs. */
export function routeToOwners<T>(
  items: readonly T[],
  resolve: (
    item: T,
  ) => { uri: { toString(): string }; ownsFile: boolean } | undefined,
): T[] {
  const entries = items.map((item) => ({ item, target: resolve(item) }));
  const ownedUris = new Set(
    entries
      .filter(({ target }) => target?.ownsFile)
      .map(({ target }) => target!.uri.toString()),
  );
  return entries
    .filter(
      ({ target }) =>
        !target || target.ownsFile || !ownedUris.has(target.uri.toString()),
    )
    .map(({ item }) => item);
}
