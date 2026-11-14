export type NoteBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; src: string };

const noteLimit = 90_000;

export function isImageSrc(src: string) {
  if (src.length < 30 || src.length > 70_000) return false;
  const prefix = /^data:image\/(?:jpeg|png|webp);base64,/i.exec(src);
  if (!prefix) return false;
  return /^[a-z0-9+/]+={0,2}$/i.test(src.slice(prefix[0].length));
}

export function parseNote(value: string): NoteBlock[] {
  if (!value.startsWith('{"praxisNote":1'))
    return value ? [{ kind: "text", text: value }] : [];
  try {
    const data = JSON.parse(value) as { blocks?: unknown };
    if (!Array.isArray(data.blocks)) return [{ kind: "text", text: value }];
    const blocks: NoteBlock[] = [];
    for (const block of data.blocks) {
      if (!block || typeof block !== "object") continue;
      const row = block as { kind?: unknown; text?: unknown; src?: unknown };
      if (row.kind === "text" && typeof row.text === "string" && row.text.trim())
        blocks.push({ kind: "text", text: row.text });
      if (
        row.kind === "image" &&
        typeof row.src === "string" &&
        isImageSrc(row.src)
      )
        blocks.push({ kind: "image", src: row.src });
    }
    return blocks.length ? blocks : [{ kind: "text", text: "" }];
  } catch {
    return [{ kind: "text", text: value }];
  }
}

export function readNoteDocument(value: string) {
  if (!value.startsWith('{"praxisNote":1'))
    return { subtitle: value, blocks: [] as NoteBlock[] };
  try {
    const data = JSON.parse(value) as { subtitle?: unknown };
    return {
      subtitle: typeof data.subtitle === "string" ? data.subtitle : "",
      blocks: parseNote(value).filter(
        (block) => block.kind === "image" || block.text.trim(),
      ),
    };
  } catch {
    return { subtitle: value, blocks: [] as NoteBlock[] };
  }
}

export function noteSubtitle(value: string) {
  return readNoteDocument(value).subtitle;
}

export function noteBody(value: string) {
  return encodeNote(readNoteDocument(value).blocks);
}

export function withNoteSubtitle(value: string, subtitle: string) {
  return writeNoteDocument({
    subtitle: subtitle.replace(/[\r\n]+/g, " "),
    blocks: readNoteDocument(value).blocks,
  });
}

export function withNoteBody(value: string, body: string) {
  return writeNoteDocument({
    subtitle: noteSubtitle(value),
    blocks: parseNote(body),
  });
}

export function noteCardText(value: string) {
  return notePlainText(value).replace(/\s+/g, " ").trim();
}

export function notePlainText(value: string) {
  const note = readNoteDocument(value);
  return [note.subtitle.trim(), ...note.blocks.flatMap((block) =>
    block.kind === "text" ? [block.text.trim()] : [],
  )]
    .filter(Boolean)
    .join("\n");
}

function writeNoteDocument(note: { subtitle: string; blocks: NoteBlock[] }) {
  const blocks = cleanBlocks(note.blocks);
  if (!blocks.length) return note.subtitle.trim() ? note.subtitle : "";
  const encoded = JSON.stringify({
    praxisNote: 1,
    subtitle: note.subtitle,
    blocks,
  });
  if (encoded.length > noteLimit) throw new Error("描述和图片过长，请减少图片");
  return encoded;
}

function cleanBlocks(blocks: NoteBlock[]) {
  const cleaned: NoteBlock[] = [];
  for (const block of blocks) {
    if (block.kind === "text") {
      const text = block.text.trim();
      if (text) cleaned.push({ kind: "text", text });
    } else if (isImageSrc(block.src)) cleaned.push(block);
  }
  return cleaned;
}

export function encodeNote(blocks: NoteBlock[]) {
  const cleaned = cleanBlocks(blocks);
  if (!cleaned.some((block) => block.kind === "image")) {
    return cleaned
      .map((block) => (block.kind === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  const encoded = JSON.stringify({ praxisNote: 1, blocks: cleaned });
  if (encoded.length > noteLimit)
    throw new Error("描述和图片过长，请减少图片");
  return encoded;
}
