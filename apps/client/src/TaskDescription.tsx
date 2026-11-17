import { feedbackMessage } from "./feedback-message";
import { useLayoutEffect, useRef, useState } from "react";
import {
  encodeNote,
  isImageSrc,
  noteBody,
  noteSubtitle,
  parseNote,
  withNoteBody,
  withNoteSubtitle,
  type NoteBlock,
} from "./task-note";

function fillNote(root: HTMLElement, value: string) {
  root.replaceChildren();
  const blocks = parseNote(value).filter(
    (block) => block.kind === "image" || block.text.trim(),
  );
  root.dataset.empty = blocks.length ? "false" : "true";
  if (!blocks.length) {
    root.append(document.createElement("br"));
    return;
  }
  for (const block of blocks) {
    if (block.kind === "text") {
      const paragraph = document.createElement("p");
      paragraph.textContent = block.text;
      root.append(paragraph);
    } else {
      const image = document.createElement("img");
      image.src = block.src;
      image.alt = "";
      root.append(image);
    }
  }
}

function readNote(root: HTMLElement) {
  const blocks: NoteBlock[] = [];
  const pending = { value: "" };
  const flush = () => {
    const text = pending.value.replace(/\u00a0/g, " ").trim();
    pending.value = "";
    if (text) blocks.push({ kind: "text", text });
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pending.value += node.textContent ?? "";
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node instanceof HTMLImageElement) {
      flush();
      const src = node.getAttribute("src") ?? "";
      if (isImageSrc(src)) blocks.push({ kind: "image", src });
      return;
    }
    if (node.tagName === "BR") {
      pending.value += "\n";
      return;
    }
    const block = ["DIV", "P", "LI"].includes(node.tagName);
    if (block && pending.value) pending.value += "\n";
    for (const child of node.childNodes) walk(child);
  };
  for (const child of root.childNodes) walk(child);
  flush();
  return encodeNote(blocks);
}

async function compressImage(file: File) {
  const bitmap = await createImageBitmap(file);
  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 720 / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理这张图片");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.72;
  let url = canvas.toDataURL("image/jpeg", quality);
  while (url.length > 60_000 && quality > 0.42) {
    quality = Math.round((quality - 0.1) * 100) / 100;
    url = canvas.toDataURL("image/jpeg", quality);
  }
  if (!isImageSrc(url)) throw new Error("这张图片放不下，请换一张小一些的");
  return url;
}

export function TaskSubtitle({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="task-panel-subtitle"
      aria-label="副标题"
      placeholder="添加副标题"
      disabled={disabled}
      value={noteSubtitle(value)}
      onChange={(event) => onChange(withNoteSubtitle(value, event.target.value))}
    />
  );
}

export function TaskDescription({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const emitted = useRef<string | null>(null);
  const [error, setError] = useState("");
  const body = noteBody(value);
  useLayoutEffect(() => {
    const root = editor.current;
    if (!root || emitted.current === body) return;
    fillNote(root, body);
    emitted.current = body;
  }, [body]);
  function publish() {
    const root = editor.current;
    if (!root) return;
    try {
      const next = readNote(root);
      root.dataset.empty = next ? "false" : "true";
      if (next === emitted.current) return;
      emitted.current = next;
      setError("");
      onChange(withNoteBody(value, next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "描述没有保存");
      fillNote(root, emitted.current ?? "");
    }
  }
  async function insert(source: File) {
    const root = editor.current;
    if (!root || disabled) return;
    setError("");
    try {
      const src = await compressImage(source);
      const image = document.createElement("img");
      image.src = src;
      image.alt = "";
      const selection = document.getSelection();
      const range =
        selection &&
        selection.rangeCount > 0 &&
        root.contains(selection.anchorNode)
          ? selection.getRangeAt(0)
          : null;
      if (range) {
        range.deleteContents();
        range.insertNode(image);
        range.setStartAfter(image);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      } else root.append(image);
      publish();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片没有插入");
    }
  }
  return (
    <div className="task-description-field">
      <div
        ref={editor}
        className="task-description"
        role="textbox"
        aria-multiline="true"
        aria-label="任务描述"
        aria-disabled={disabled || undefined}
        contentEditable={disabled ? "false" : "true"}
        data-placeholder="添加描述"
        suppressContentEditableWarning
        onInput={publish}
        onPaste={(event) => {
          const items = event.clipboardData?.items;
          const picture = items && [...items].find((item) => item.type.startsWith("image/"));
          if (picture) {
            const source = picture.getAsFile();
            event.preventDefault();
            if (source) void insert(source);
            return;
          }
          const text = event.clipboardData?.getData("text/plain");
          if (text == null) return;
          event.preventDefault();
          const selection = document.getSelection();
          if (!selection?.rangeCount) return;
          const range = selection.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          publish();
        }}
      />
      <button
        type="button"
        className="task-description-image"
        aria-label="插入图片"
        disabled={disabled}
        onClick={() => file.current?.click()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="m21 16-5-5-9 8" />
        </svg>
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const source = event.target.files?.[0];
          event.target.value = "";
          if (source) void insert(source);
        }}
      />
      {error && (
        <p className="task-description-error" role="alert">
          {feedbackMessage(error)}
        </p>
      )}
    </div>
  );
}
