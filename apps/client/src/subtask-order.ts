export function reorderIds(
  ids: readonly string[],
  from: string,
  to: string,
  after: boolean,
): string[] | null {
  if (from === to || !ids.includes(from) || !ids.includes(to)) return null;
  const next = ids.filter((id) => id !== from);
  const index = next.indexOf(to);
  next.splice(after ? index + 1 : index, 0, from);
  return next.every((id, position) => id === ids[position]) ? null : next;
}
