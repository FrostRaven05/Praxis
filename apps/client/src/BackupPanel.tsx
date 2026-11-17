import { feedbackMessage } from "./feedback-message";
import { useEffect, useState } from "react";
import { invoke } from "./native-recovery";
import { contentError } from "./content-storage";
interface Backup {
  name: string;
  path: string;
  bytes: number;
}
const VISIBLE = 5;
const kinds: Record<string, string> = {
  manual: "手动备份",
  "before-upgrade": "升级前自动备份",
};
// File names look like 20261011T140911-<kind>-<uuid>.db (UTC timestamp).
function describe(b: Backup) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-(.+)-[0-9a-f-]{36}\.db$/i.exec(
    b.name,
  );
  if (!m) return { when: b.name, kind: "" };
  const [, y, mo, d, h, mi, s, kind] = m;
  const date = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!));
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    when: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    kind: kinds[kind!] ?? kind!,
  };
}
function size(bytes: number) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
export function BackupPanel() {
  const [items, setItems] = useState<Backup[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [showAll, setShowAll] = useState(false),
    [selected, setSelected] = useState<Backup | null>(null);
  async function reload() {
    setLoading(true);
    try {
      setItems(await invoke<Backup[]>("backup_list"));
      setError("");
    } catch (e) {
      setError(contentError(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, []);
  async function create() {
    setBusy(true);
    setNotice("");
    try {
      await invoke<string>("backup_create");
      setNotice("");
      await reload();
    } catch (e) {
      setError(contentError(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!selected) return;
    setBusy(true);
    setNotice("");
    try {
      await invoke<string>("backup_restore", { name: selected.name });
      setNotice("恢复副本已验证，重新打开应用后生效；当前数据不会被覆盖。");
      setSelected(null);
    } catch (e) {
      setError(contentError(e));
    } finally {
      setBusy(false);
    }
  }
  const shown = showAll ? items : items.slice(0, VISIBLE);
  return (
    <section className="content-card backup-panel">
      <div className="backup-head">
        <div>
          <h2>本地备份</h2>
          <p>升级前会自动备份。恢复不会覆盖当前数据，重新打开应用后生效。</p>
        </div>
        <button
          className="backup-create"
          disabled={busy}
          onClick={() => void create()}
        >
          立即备份
        </button>
      </div>
      {loading && <p role="status">正在读取备份…</p>}
      {!loading && !error && items.length === 0 && (
        <p className="backup-empty">还没有备份。</p>
      )}
      {shown.length > 0 && (
        <ul className="backup-list">
          {shown.map((b) => {
            const info = describe(b);
            const confirming = selected?.name === b.name;
            return (
              <li key={b.name} title={b.path}>
                <span className="backup-when">{info.when}</span>
                <span className="backup-meta">
                  {[info.kind, size(b.bytes)].filter(Boolean).join(" · ")}
                </span>
                {confirming ? (
                  <span
                    className="backup-confirm"
                    role="group"
                    aria-label="恢复确认"
                  >
                    <button disabled={busy} onClick={() => void restore()}>
                      确认恢复
                    </button>
                    <button disabled={busy} onClick={() => setSelected(null)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setNotice("");
                      setSelected(b);
                    }}
                  >
                    恢复
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {items.length > VISIBLE && (
        <button className="backup-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起" : `显示全部 ${items.length} 条`}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {feedbackMessage(error)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
