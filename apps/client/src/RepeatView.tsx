import { useLanRefresh } from "./useLanRefresh";
import { calendarDate } from "@praxis/application";
import { useEffect, useState } from "react";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import { invoke } from "@tauri-apps/api/core";
type Template = {
  id: string;
  title: string;
  projectId: string | null;
  startDate: string;
  timeZone: string;
  intervalDays: number;
  weekdays: string;
  enabled: boolean;
  expandedThrough: string | null;
  version: number;
};
type Command = { operationId: string; occurredAt: string; action: object };
const retry = new RetriableCommands<Command>();
type Occurrence = {
  id: string;
  version: number;
  occurrenceKey: string;
  title: string;
  exception: boolean;
  status: string;
};
type Row = {
  template: Template;
  through: string;
  remaining: number;
  futureTasks: Occurrence[];
  rules: {
    effectiveDate: string;
    title: string;
    intervalDays: number;
    weekdays: string;
    timeZone: string;
  }[];
};
export function RepeatView() {
  const [createId, setCreateId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<Row[]>([]),
    [projects, setProjects] = useState<
      { id: string; name: string; status: string; archivedAt: string | null }[]
    >([]),
    [title, setTitle] = useState(""),
    [start, setStart] = useState(""),
    [interval, setInterval] = useState(1),
    [days, setDays] = useState<number[]>([]),
    [project, setProject] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [stop, setStop] = useState<Template | null>(null);
  useLanRefresh(
    () => invoke<{ templates: Row[] }>("recurrence_snapshot"),
    (s) => setRows(s.templates),
    busy || stop !== null,
  );
  async function refresh() {
    const s = await invoke<{ templates: Row[] }>("recurrence_snapshot");
    setRows(s.templates);
    const p = await invoke<{
      projects: typeof projects;
      settings: { timeZone: string }[];
    }>("productivity_snapshot");
    setProjects(p.projects);
    setStart(
      (current) =>
        current || calendarDate(new Date(), p.settings[0]?.timeZone || "UTC"),
    );
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  async function run(action: object) {
    setBusy(true);
    setError("");
    try {
      await retry.execute(
        "recurrence",
        (c) => JSON.stringify(c.action) === JSON.stringify(action),
        () => ({
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          action,
        }),
        (command) => invoke("recurrence_command", { command }),
      );
      await refresh();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="content-view">
      <h2>重复任务</h2>
      <p>
        固定日历规则只生成独立的顶层任务和计划日期，不自动设置期限。补齐包含离线遗漏和未来30天；完成某一次不移动后续日期。
      </p>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy}>
        <legend>新建规则</legend>
        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          开始日期
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          每隔天数
          <input
            type="number"
            min={1}
            max={3650}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
          />
        </label>
        <p>选择星期时按指定星期执行；不选择则按每隔天数。</p>
        <div className="weekday-options" aria-label="执行星期">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={days.includes(d)}
                onChange={(e) =>
                  setDays(
                    e.target.checked
                      ? [...days, d]
                      : days.filter((x) => x !== d),
                  )
                }
              />
              周{["一", "二", "三", "四", "五", "六", "日"][d - 1]}
            </label>
          ))}
        </div>
        <label>
          归属
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">独立任务</option>
            {projects
              .filter(
                (p) =>
                  !p.archivedAt &&
                  !["completed", "cancelled", "archived"].includes(p.status),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!title.trim()}
          onClick={() =>
            void run({
              type: "create",
              id: createId,
              title,
              projectId: project || null,
              startDate: start,
              intervalDays: interval,
              weekdays: days,
            }).then((ok) => {
              if (ok) {
                setTitle("");
                setCreateId(crypto.randomUUID());
              }
            })
          }
        >
          保存规则
        </button>
      </fieldset>
      {rows.map(({ template: t, through, remaining, futureTasks, rules }) => (
        <article key={t.id}>
          <h3>{t.title}</h3>
          <p>
            {t.enabled ? "启用" : "已停止"} · {t.timeZone} · 从 {t.startDate}{" "}
            开始
          </p>
          <p>
            已检查至 {t.expandedThrough || "尚未展开"}；到 {through} 尚余{" "}
            {remaining} 项
          </p>
          {t.enabled && (
            <>
              <button
                disabled={busy || remaining === 0}
                onClick={() =>
                  void run({
                    type: "expand",
                    id: t.id,
                    through,
                    batchSize: 100,
                  })
                }
              >
                补齐下一批（最多100项）
              </button>
              <RuleEditor
                template={t}
                tasks={futureTasks}
                rules={rules}
                busy={busy}
                run={run}
              />
              <button disabled={busy} onClick={() => setStop(t)}>
                停止规则…
              </button>
            </>
          )}
        </article>
      ))}
      {stop && (
        <div role="dialog" aria-label="停止重复规则">
          <p>
            停止“{stop.title}
            ”后不再生成新任务。已生成的任务、历史与未来发生项全部保留；请在近期页面逐项处理未来任务，再结束项目。
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void run({
                type: "stop",
                id: stop.id,
                expectedVersion: stop.version,
              }).then((ok) => {
                if (ok) setStop(null);
              })
            }
          >
            确认停止并保留已生成任务
          </button>
          <button disabled={busy} onClick={() => setStop(null)}>
            返回
          </button>
        </div>
      )}
    </section>
  );
}

function RuleEditor({
  template: t,
  tasks,
  rules,
  busy,
  run,
}: {
  template: Template;
  tasks: Occurrence[];
  rules: Row["rules"];
  busy: boolean;
  run: (action: object) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false),
    [effective, setEffective] = useState(""),
    [title, setTitle] = useState(t.title),
    [interval, setInterval] = useState(t.intervalDays),
    [days, setDays] = useState<number[]>(JSON.parse(t.weekdays)),
    [zone, setZone] = useState(t.timeZone),
    [overwrite, setOverwrite] = useState(false),
    [preview, setPreview] = useState(false),
    [previewBusy, setPreviewBusy] = useState(false),
    [previewError, setPreviewError] = useState(""),
    [previewAction, setPreviewAction] = useState<object | null>(null),
    [effects, setEffects] = useState<
      {
        id: string;
        occurrenceKey: string;
        title: string;
        effect: string;
        nextStatus: string | null;
      }[]
    >([]);
  const action = () => ({
    type: "edit",
    id: t.id,
    expectedVersion: t.version,
    effectiveDate: effective,
    title,
    intervalDays: interval,
    weekdays: days,
    timeZone: zone,
    expectedTasks: tasks.map((x) => [x.id, x.version]),
    overwriteOverrides: overwrite,
  });
  function loadRule(date: string) {
    const rule =
      rules.filter((r) => r.effectiveDate <= date).at(-1) || rules[0];
    if (rule) {
      setTitle(rule.title);
      setInterval(rule.intervalDays);
      setDays(JSON.parse(rule.weekdays));
      setZone(rule.timeZone);
    }
  }
  async function requestPreview() {
    setPreviewBusy(true);
    setPreviewError("");
    try {
      const request = action();
      const result = await invoke<{ effects: typeof effects }>(
        "recurrence_edit_preview",
        { action: request },
      );
      setPreviewAction(request);
      setEffects(result.effects);
      setPreview(true);
    } catch (e) {
      setPreviewError(String(e));
    } finally {
      setPreviewBusy(false);
    }
  }
  return (
    <>
      <button
        disabled={busy}
        onClick={() => {
          setOpen(true);
          setPreview(false);
          const last = rules.at(-1);
          setEffective(last?.effectiveDate || "");
          loadRule(last?.effectiveDate || t.startDate);
          setOverwrite(false);
          setPreviewError("");
        }}
      >
        修改未来规则…
      </button>
      {open && (
        <div role="dialog" aria-label="修改未来重复规则">
          {previewError && <p role="alert">{previewError}</p>}
          <fieldset disabled={busy || preview || previewBusy}>
            <legend>从指定日期修改未来规则</legend>
            <p>
              仅本次：到任务详情修改标题或计划，原发生身份不变。此处修改未来规则；完成记录与生效日前任务保留。
            </p>
            <label>
              生效日期（明天起）
              <input
                type="date"
                value={effective}
                onChange={(e) => {
                  setEffective(e.target.value);
                  loadRule(e.target.value);
                }}
              />
            </label>
            <label>
              未来标题
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              每隔天数
              <input
                type="number"
                min={1}
                max={3650}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </label>
            <div className="weekday-options" aria-label="执行星期">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={days.includes(d)}
                    onChange={(e) =>
                      setDays(
                        e.target.checked
                          ? [...days, d]
                          : days.filter((x) => x !== d),
                      )
                    }
                  />
                  周{["一", "二", "三", "四", "五", "六", "日"][d - 1]}
                </label>
              ))}
            </div>
            <label>
              规则时区
              <input value={zone} onChange={(e) => setZone(e.target.value)} />
            </label>
            <label>
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              明确覆盖已手动修改的未来例外（包括取消）
            </label>
            <p>会替换生效日期之后已预约的规则版本。</p>
          </fieldset>
          {!preview ? (
            <button
              disabled={busy || previewBusy || !effective || !title.trim()}
              onClick={() => void requestPreview()}
            >
              预览受影响任务
            </button>
          ) : (
            <>
              <p>
                时区 {t.timeZone} → {zone}
                。已有发生键和完成记录不变；日期型实例仍显示原日期。下次补齐按新规则生成缺少的日期。
              </p>
              <ul>
                {effects.map((x) => (
                  <li key={x.id}>
                    {x.occurrenceKey} · {x.title} →{" "}
                    {x.effect === "preserveHistory"
                      ? "保留完成历史"
                      : x.effect === "preserveOverride"
                        ? "保留手动例外"
                        : x.effect === "update"
                          ? `标题改为 ${title}，恢复原定计划日期；保留进行状态（已取消项恢复待办）`
                          : "取消此未来任务"}
                  </li>
                ))}
              </ul>
              {!effects.length && <p>没有已生成的受影响任务。</p>}
              <button
                disabled={busy}
                onClick={() =>
                  previewAction &&
                  void run(previewAction).then((ok) => {
                    if (ok) setOpen(false);
                  })
                }
              >
                确认未来规则
              </button>
              <button disabled={busy} onClick={() => setPreview(false)}>
                返回修改
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => setOpen(false)}>
            关闭
          </button>
        </div>
      )}
    </>
  );
}
