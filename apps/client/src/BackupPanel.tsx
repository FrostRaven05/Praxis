import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { contentError } from "./content-storage";
interface Backup {
  name: string;
  path: string;
  bytes: number;
}
export function BackupPanel() {
  const [items, setItems] = useState<Backup[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
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
    try {
      const path = await invoke<string>("backup_create");
      setNotice(`本机备份已保存：${path}`);
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
    try {
      const path = await invoke<string>("backup_restore", {
        name: selected.name,
      });
      setNotice(
        `恢复副本已验证：${path}。请退出并重新打开应用以切换。当前数据库仍保留；重启前的新修改不会自动进入恢复副本。`,
      );
      setSelected(null);
    } catch (e) {
      setError(contentError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content-card">
      <h2>本地备份与恢复</h2>
      <p>
        包含当前任务、项目、记录、历史和未同步操作。升级迁移前自动建立一致性备份；恢复写入新文件，保留原数据库。
      </p>
      <button disabled={busy} onClick={() => void create()}>
        立即备份
      </button>
      <button disabled={busy} onClick={() => void reload()}>
        刷新备份列表
      </button>
      {loading && <p role="status">正在读取备份…</p>}
      {!loading && !error && items.length === 0 && <p>尚无本地备份。</p>}
      {items.map((b) => (
        <div key={b.name}>
          <p>
            {b.name} · {b.bytes} 字节
          </p>
          <small>{b.path}</small>
          <button disabled={busy} onClick={() => setSelected(b)}>
            选择恢复
          </button>
        </div>
      ))}
      {selected && (
        <div role="group" aria-label="恢复确认">
          <h3>恢复 {selected.name}</h3>
          <p>
            将检查备份完整性并创建新数据库。下次启动切换，原数据库不覆盖。请先备份当前最新修改。
          </p>
          <button disabled={busy} onClick={() => void restore()}>
            确认恢复到新文件
          </button>
          <button disabled={busy} onClick={() => setSelected(null)}>
            取消
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
