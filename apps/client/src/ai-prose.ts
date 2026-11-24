const UUID_BODY =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const BRACKETED_UUID = new RegExp(
  `\\s*[（(\\[]\\s*(?:(?:task\\s*)?id\\s*[:：=]?\\s*)?${UUID_BODY}\\s*[）)\\]]`,
  "gi",
);

const LABELED_UUID = new RegExp(
  `\\s*(?:(?:任务\\s*|task\\s*)?id\\s*[:：=]\\s*)${UUID_BODY}`,
  "gi",
);

const BARE_UUID = new RegExp(`\\s*${UUID_BODY}`, "gi");

/** Strip leaked task UUIDs and tidy spacing so AI replies read naturally. */
export function cleanAiProse(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(BRACKETED_UUID, "")
    .replace(LABELED_UUID, "")
    .replace(BARE_UUID, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([，。！？；：、])/g, "$1")
    .replace(/([（(])\s*([）)])/g, "")
    .trim();
}
