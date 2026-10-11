type Data = Record<string, unknown>;
const linksOf = (data: Data) => {
  const links = Array.isArray(data.links) ? [...(data.links as Data[])] : [];
  for (const kind of ["project", "task"] as const) {
    const id = data[kind + "Id"];
    if (id && !links.some((l) => l.targetType === kind && l.targetId === id))
      links.push({ targetType: kind, targetId: id });
  }
  return links;
};
export function firstRecordLink(data: Data, kind: "project" | "task") {
  return String(
    data[kind + "Id"] ??
      linksOf(data).find((l) => l.targetType === kind)?.targetId ??
      "",
  );
}
export function editRecordLinks(
  data: Data,
  projectId: string,
  taskId: string,
): Data[] {
  let links = linksOf(data).map((l) => ({ ...l }));
  for (const [kind, next] of [
    ["project", projectId],
    ["task", taskId],
  ] as const) {
    const previous = firstRecordLink(data, kind);
    if (next === previous) continue;
    const index = links.findIndex(
      (l) => l.targetType === kind && l.targetId === previous,
    );
    if (index >= 0) {
      if (next) links[index] = { ...links[index], targetId: next };
      else links.splice(index, 1);
    } else if (next) links.unshift({ targetType: kind, targetId: next });
  }
  const seen = new Set<string>();
  return links.filter((l) => {
    const key = `${l.targetType}/${l.targetId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
