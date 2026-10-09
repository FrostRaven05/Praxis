import { useEffect, useRef, useState } from "react";
import { mobileStorage } from "../../../packages/storage-mobile/src/native";
import type {
  MobileCapture,
  SaveCaptureCommand,
} from "../../../packages/storage-mobile/src";
import "./mobile-capture.css";
import {
  CaptureRejectedError,
  MAX_CAPTURE_CHARACTERS,
} from "../../../packages/storage-mobile/src";

export function MobileCaptureView({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const [items, setItems] = useState<MobileCapture[]>([]);
  const [queue, setQueue] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<MobileCapture | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<SaveCaptureCommand | null>(null);
  const saving = useRef(false);
  const composing = useRef(false);
  const characterCount = Array.from(text).length;
  useEffect(() => {
    onBusyChange?.(busy || text.length > 0 || pending.current !== null);
    return () => onBusyChange?.(false);
  }, [busy, text, onBusyChange]);
  async function refresh() {
    try {
      const [rows, count] = await Promise.all([
        mobileStorage.listCaptures(),
        mobileStorage.captureQueueCount(),
      ]);
      setItems(rows);
      setQueue(count);
    } catch {
      setError("无法读取本机收集项，请重试。输入仍保留。");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const foreground = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", foreground);
    return () => document.removeEventListener("visibilitychange", foreground);
  }, []);
  async function save() {
    if (
      saving.current ||
      !text.trim() ||
      characterCount > MAX_CAPTURE_CHARACTERS
    )
      return;
    saving.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    pending.current ??= {
      operationId: crypto.randomUUID(),
      id: editing?.id ?? crypto.randomUUID(),
      expectedVersion: editing?.version ?? null,
      rawText: text,
      occurredAt: new Date().toISOString(),
    };
    try {
      await mobileStorage.saveCapture(pending.current);
      pending.current = null;
      setText("");
      setEditing(null);
      setNotice("已保存到本机");
      await refresh();
    } catch (e) {
      if (e instanceof CaptureRejectedError) pending.current = null;
      setError(e instanceof Error ? e.message : "保存失败，原文仍保留。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="mobile-capture" aria-label="手机收集箱">
      <h1>收件箱</h1>
      <p role="status">本地模式 · 内容仅保存在这台手机，尚未接入同步</p>
      <p>待同步操作：{queue ?? "正在读取"} · 需要保留本机应用数据</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (composing.current) return;
          void save();
        }}
      >
        <label htmlFor="mobile-capture-text">
          {editing ? "编辑原文" : "记下原文"}
        </label>
        <textarea
          id="mobile-capture-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          disabled={busy}
          readOnly={pending.current !== null}
          placeholder="想法、待办、线索，先原样记下来"
          rows={5}
        />
        {characterCount > MAX_CAPTURE_CHARACTERS && (
          <p role="alert">
            原文超过 100,000 个字符，请缩短后保存；内容未被截断。
          </p>
        )}
        <button
          type="submit"
          disabled={
            busy || !text.trim() || characterCount > MAX_CAPTURE_CHARACTERS
          }
        >
          {busy
            ? "保存中…"
            : pending.current
              ? "重试保存"
              : editing
                ? "保存编辑"
                : "保存到本机"}
        </button>
        {editing && !pending.current && error && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setError("");
              setNotice("原文已保留，点击保存到本机可建立新的收集项。");
            }}
          >
            另存原文
          </button>
        )}
        {editing && !pending.current && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setText("");
            }}
          >
            取消编辑
          </button>
        )}
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending.current && !busy && (
        <p>
          上次保存结果尚未确认，请重试同一操作。原文暂时锁定，避免重复或覆盖。
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setError("");
          void refresh();
        }}
      >
        刷新本机收件箱
      </button>
      {loading ? (
        <p>正在读取本机内容…</p>
      ) : items.length === 0 && !error ? (
        <p>还没有收集项。</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <p className="mobile-capture-original">{item.rawText}</p>
              <small>
                本机保存 · {new Date(item.updatedAt).toLocaleString()}
              </small>
              <button
                type="button"
                disabled={busy || !!pending.current || !!text}
                onClick={() => {
                  setEditing(item);
                  setText(item.rawText);
                  setError("");
                  setNotice("");
                }}
              >
                编辑原文
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
