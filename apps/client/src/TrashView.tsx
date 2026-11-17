import { feedbackMessage } from "./feedback-message";
import { useLanRefresh } from "./useLanRefresh";
import { useEffect, useState } from "react";
import { invoke } from "./native-recovery";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import { contentError } from "./content-storage";

type Command = { operationId: string; occurredAt: string; action: unknown };
const retry = new RetriableCommands<Command>();
interface Task {
  id: string;
  title: string;
  version: number;
  projectId: string | null;
  parentTaskId: string | null;
}
interface Project {
  id: string;
  title: string;
  version: number;
  linkCount: number;
  templateCount: number;
}
interface Entry {
  id: string;
  title: string;
  targetType: string;
  deletedAt: string;
  taskCount: number;
  recoveryStartedAt: string;
  expiresAt: string;
  canRestore: boolean;
}
interface Snapshot {
  tasks: Task[];
  projects: Project[];
  entries: Entry[];
  recoveryPolicy: string;
  settings: { recoveryDays: number; version: number };
}
export function TrashView({ onChanged }: { onChanged?: () => void }) {
  const [recoveryDays, setRecoveryDays] = useState("30");
  const [data, setData] = useState<Snapshot | null>(null);
  const [kind, setKind] = useState("task"),
    [id, setId] = useState("");
  const [mode, setMode] = useState("promote"),
    [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useLanRefresh(
    () => invoke<Snapshot>("trash_snapshot"),
    (next) => {
      setData(next);
      setRecoveryDays(String(next.settings.recoveryDays));
    },
    busy ||
      confirm ||
      recoveryDays !== String(data?.settings.recoveryDays ?? 30),
  );
  async function reload() {
    const snapshot = await invoke<Snapshot>("trash_snapshot");
    setData(snapshot);
    setRecoveryDays(String(snapshot.settings.recoveryDays));
  }
  useEffect(() => {
    void reload().catch((e) => setError(contentError(e)));
  }, []);
  const choices = kind === "task" ? data?.tasks : data?.projects;
  const selected = choices?.find((t) => t.id === id);
  const descendants = new Set<string>(id ? [id] : []);
  if (data && kind === "task") {
    let count = -1;
    while (count !== descendants.size) {
      count = descendants.size;
      for (const t of data.tasks)
        if (t.parentTaskId && descendants.has(t.parentTaskId))
          descendants.add(t.id);
    }
  }
  const count =
    kind === "project"
      ? (data?.tasks.filter((t) => t.projectId === id).length ?? 0)
      : Math.max(0, descendants.size - 1);
  async function command(action: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await retry.execute(
        "trash",
        (c) => JSON.stringify(c.action) === JSON.stringify(action),
        () => ({
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          action,
        }),
        (command) => invoke("trash_command", { command }),
      );
      await reload();
      onChanged?.();
      setId("");
      setConfirm(false);
      setNotice(
        "操作已保存。恢复会重新检查归属和父子关系；已提升或转为独立的任务保留当前位置。下一步需重新选择。",
      );
    } catch (e) {
      setError(contentError(e));
      await reload().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content-card" aria-label="回收站">
      <h2>回收站</h2>
      <p>{data?.recoveryPolicy}</p>
      {data && (
        <fieldset disabled={busy}>
          <legend>恢复窗口</legend>
          <label>
            允许恢复的天数{" "}
            <input
              type="number"
              min={1}
              max={3650}
              step={1}
              value={recoveryDays}
              onChange={(e) => setRecoveryDays(e.target.value)}
            />
          </label>
          <p>
            设置适用于现有回收站条目；缩短窗口可能使条目立即到期。延长窗口可让仍保留的条目重新满足恢复条件。
          </p>
          <button
            disabled={
              !Number.isInteger(Number(recoveryDays)) ||
              Number(recoveryDays) < 1 ||
              Number(recoveryDays) > 3650 ||
              Number(recoveryDays) === data.settings.recoveryDays
            }
            onClick={() =>
              void command({
                type: "settings",
                recoveryDays: Number(recoveryDays),
                expectedVersion: data.settings.version,
              })
            }
          >
            保存恢复窗口
          </button>
        </fieldset>
      )}
      <p>
        删除后从日常列表和统计隐藏，取消仍是任务状态。关联记录正文始终保留。
      </p>
      <fieldset disabled={busy}>
        <legend>移入回收站</legend>
        <label>
          内容类型{" "}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setId("");
              setMode(e.target.value === "task" ? "promote" : "detach");
              setConfirm(false);
            }}
          >
            <option value="task">任务</option>
            <option value="project">项目</option>
          </select>
        </label>
        <label>
          选择内容{" "}
          <select
            value={id}
            onChange={(e) => {
              setId(e.target.value);
              setConfirm(false);
            }}
          >
            <option value="">请选择</option>
            {choices?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <div role="group" aria-label="删除影响预览">
            <p>
              {selected.title}：
              {kind === "task"
                ? `${count} 个后代任务`
                : `${count} 个任务，${data?.projects.find((p) => p.id === id)?.linkCount ?? 0} 个项目记录链接，${data?.projects.find((p) => p.id === id)?.templateCount ?? 0} 个启用的重复模板（将停止）`}
              。
            </p>
            <label>
              处理方式{" "}
              <select
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setConfirm(false);
                }}
              >
                {kind === "task" ? (
                  <>
                    <option value="promote">保留子项，提升为顶层任务</option>
                    <option value="cascade">连同所有子项删除</option>
                  </>
                ) : (
                  <>
                    <option value="detach">
                      任务转为独立任务，解除项目链接
                    </option>
                    <option value="cascade">整项目及其任务移入回收站</option>
                  </>
                )}
              </select>
            </label>
            <p>
              指向被删除内容的记录链接会解除，原记录保留；相关依赖会移出工作图并保存在删除历史。恢复只重建仍符合约束的关系。
            </p>
            {kind === "project" && mode === "cascade" && (
              <label>
                <input
                  type="checkbox"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                确认整项目及 {count} 个任务删除
              </label>
            )}
            <button
              disabled={kind === "project" && mode === "cascade" && !confirm}
              onClick={() =>
                void command({
                  type: "delete",
                  targetType: kind,
                  id,
                  expectedVersion: selected.version,
                  mode,
                  confirmAll: confirm,
                  expectedTasks: data!.tasks.map((t) => [t.id, t.version]),
                })
              }
            >
              确认移入回收站
            </button>
          </div>
        )}
      </fieldset>
      {!data && !error && <p role="status">正在读取…</p>}
      {data?.entries.length === 0 && <p>回收站为空。</p>}
      {data?.entries.map((e) => (
        <article key={e.id}>
          <h3>{e.title}</h3>
          <p>
            {e.targetType === "project" ? "项目" : "任务"} · {e.taskCount}{" "}
            个任务 · {e.deletedAt}
          </p>
          <p>
            本机恢复起算：{e.recoveryStartedAt}；恢复截止：{e.expiresAt} ·{" "}
            {e.canRestore
              ? "可恢复"
              : "已超过当前恢复窗口，内容和同步删除标记仍保留"}
          </p>
          <button
            disabled={busy || !e.canRestore}
            onClick={() => void command({ type: "restore", batchId: e.id })}
          >
            恢复 {e.title}
          </button>
        </article>
      ))}
      <button
        disabled={busy}
        onClick={() => void reload().catch((e) => setError(contentError(e)))}
      >
        刷新回收站
      </button>
      {error && (
        <p role="alert" className="error">
          {feedbackMessage(error)}
        </p>
      )}
      <p role="status">{notice}</p>
    </section>
  );
}
