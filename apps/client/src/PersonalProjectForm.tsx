import { useEffect, useRef, useState } from "react";
import {
  PersonalProjectRejectedError,
  type PersonalProjectFields,
} from "@praxis/application";
import "./personal-projects.css";

export function PersonalProjectForm({
  initial,
  createSave,
  onSaved,
  onCancel,
  onBusyChange,
  modal = false,
}: {
  initial: PersonalProjectFields | null;
  createSave: () => (fields: PersonalProjectFields) => Promise<string>;
  onSaved: (id: string) => Promise<void>;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
  modal?: boolean;
}) {
  const [save] = useState(createSave);
  const [isEdit] = useState(initial !== null);
  const [name, setName] = useState(initial?.name ?? "");
  const [outcome, setOutcome] = useState(initial?.outcome ?? "");
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false),
    saved = useRef<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = isEdit ? "编辑项目" : "新建项目";
  useEffect(() => {
    if (modal && dialog.current && !dialog.current.open)
      dialog.current.showModal();
    return () => dialog.current?.close();
  }, [modal]);
  useEffect(() => {
    // An open draft also protects the parent's navigation and background refresh.
    onBusyChange(true);
    return () => onBusyChange(false);
  }, [onBusyChange]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  const form = (
    <form
      className="personal-project-form"
      aria-label="项目基本信息"
      onSubmit={async (e) => {
        e.preventDefault();
        if (active.current) return;
        active.current = true;
        setBusy(true);
        setError("");
        try {
          if (!saved.current)
            saved.current = await save({
              name,
              outcome,
              targetDate: initial?.targetDate ?? null,
            });
          setUnknown(false);
          await onSaved(saved.current);
        } catch (error) {
          setUnknown(
            !saved.current && !(error instanceof PersonalProjectRejectedError),
          );
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          active.current = false;
          setBusy(false);
        }
      }}
    >
      <h2 id="personal-project-form-heading">{heading}</h2>
      <label htmlFor="personal-project-name">项目名称</label>
      <input
        autoFocus
        required
        id="personal-project-name"
        value={name}
        disabled={busy || unknown || !!saved.current}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="personal-project-outcome">目标（可选）</label>
      <textarea
        id="personal-project-outcome"
        rows={3}
        value={outcome}
        disabled={busy || unknown || !!saved.current}
        onChange={(e) => setOutcome(e.target.value)}
      />
      {error && (
        <p role="alert">
          {error}
          {unknown
            ? "。保存结果未确认，请重试原操作。"
            : saved.current
              ? "。项目已保存，请重试打开。"
              : "。输入已保留，可取消后重新读取。"}
        </p>
      )}
      <div className="personal-project-form-actions">
        <button type="submit" disabled={busy}>
          {busy
            ? "保存中…"
            : saved.current
              ? "重试打开项目"
              : unknown
                ? "重试保存"
                : isEdit
                  ? "保存项目"
                  : "创建项目"}
        </button>
        <button type="button" disabled={busy || unknown} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
  return modal ? (
    <dialog
      ref={dialog}
      className="personal-project-modal"
      aria-labelledby="personal-project-form-heading"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy && !unknown) onCancel();
      }}
    >
      {form}
    </dialog>
  ) : (
    form
  );
}
