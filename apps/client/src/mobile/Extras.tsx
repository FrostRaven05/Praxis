import { useEffect, useRef, useState } from "react";
import {
  WorkspaceRejectedError,
  previewWorkspaceImport,
} from "@praxis/storage-mobile";
import type {
  WorkspaceEntity,
  WorkspaceSnapshot,
  WorkspaceChange,
  WorkspaceCommand,
  WorkspaceKind,
} from "@praxis/storage-mobile";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import "./extras.css";
import { SearchPanel } from "./SearchPanel";
import { ProjectChecks, CommandHistory } from "./ReviewHistory";
import { exportMobileJson } from "./export-file";
import {
  ruleAt,
  matchesRule,
  preserveRuleHistory,
  futureRuleChanges,
  type ScheduleRule,
} from "./schedule-rules";
export type ExtraSection =
  | "habits"
  | "repeat"
  | "records"
  | "templates"
  | "review"
  | "search"
  | "trash"
  | "settings"
  | "stats"
  | "focus";
type Props = {
  section: ExtraSection;
  snapshot: WorkspaceSnapshot;
  refresh: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const title = (e: WorkspaceEntity) => str(e.data.title) || "未命名";
const iso = () => new Date().toISOString();
const calendarDay = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const addDay = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const change = (
  e: WorkspaceEntity,
  data = e.data,
  deleted = false,
): WorkspaceChange => ({
  id: e.id,
  kind: e.kind,
  expectedVersion: e.version,
  data,
  deleted,
});
const fresh = (
  kind: WorkspaceKind,
  data: Record<string, unknown>,
): WorkspaceChange => ({
  id: crypto.randomUUID(),
  kind,
  expectedVersion: null,
  data,
});
const labels: Record<string, string> = {
  task: "任务",
  project: "项目",
  record: "记录",
  habit: "习惯",
  recurrence: "重复",
  review: "回顾",
  strategy: "策略",
  decision: "决策",
  view: "视图",
  focus: "专注",
  section: "分区",
  plan: "安排",
  habit_check: "打卡",
  settings: "设置",
};
export function Extras({ section, snapshot, refresh, onBusyChange }: Props) {
  const live = snapshot.entities.filter((e) => !e.deleted),
    settings = live.find((e) => e.kind === "settings");
  const timeZone = str(settings?.data.timeZone) || "Asia/Hong_Kong";
  const day = (date = new Date()) => calendarDay(date, timeZone);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [reviewTarget, setReviewTarget] = useState<WorkspaceEntity | null>(
    null,
  );
  const [rulePreview, setRulePreview] = useState<{
    changes: WorkspaceChange[];
    preserved: number;
  } | null>(null);
  const [effectiveDate, setEffectiveDate] = useState(addDay(day(), 1));
  const [trigger, setTrigger] = useState(""),
    [normalVersion, setNormalVersion] = useState(""),
    [minimumVersion, setMinimumVersion] = useState("");
  const [projectId, setProjectId] = useState(""),
    [taskId, setTaskId] = useState("");
  const importOperation = useRef<string | null>(null);
  const [spaces, setSpaces] = useState<
    { id: string; title: string; active: boolean }[]
  >([]);
  const [pending, setPending] = useState<WorkspaceCommand | null>(null);
  const [name, setName] = useState(""),
    [body, setBody] = useState(""),
    [selected, setSelected] = useState<WorkspaceEntity | null>(null),
    [recordKind, setRecordKind] = useState<WorkspaceKind>("record");
  const [date, setDate] = useState(day()),
    [frequency, setFrequency] = useState("daily"),
    [target, setTarget] = useState(3),
    [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [zone, setZone] = useState("Asia/Hong_Kong"),
    [json, setJson] = useState(""),
    [preview, setPreview] = useState(""),
    [confirmImport, setConfirmImport] = useState(false),
    [tick, setTick] = useState(Date.now());
  useEffect(() => {
    setZone(timeZone);
  }, [timeZone]);
  useEffect(() => {
    if (section === "settings")
      void mobileStorage
        .workspaceList()
        .then(setSpaces)
        .catch((e) => setError(String(e)));
  }, [section, snapshot]);
  useEffect(() => {
    setSelected(null);
    setName("");
    setBody("");
    setRecordKind(
      section === "review"
        ? "review"
        : section === "templates"
          ? "strategy"
          : "record",
    );
    setRulePreview(null);
    setFrequency("daily");
    setError("");
    setMessage("");
    setPreview("");
    setConfirmImport(false);
  }, [section]);
  const dirty =
    ["records", "templates", "review", "habits", "repeat"].includes(section) &&
    !!(name || body);
  useEffect(() => {
    onBusyChange?.(busy || !!pending || dirty);
  }, [busy, pending, dirty, onBusyChange]);
  useEffect(() => {
    setRulePreview(null);
  }, [frequency, target, weekdays, effectiveDate]);
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function run(changes: WorkspaceChange[], done?: () => void) {
    const cmd = pending ?? {
      operationId: crypto.randomUUID(),
      occurredAt: iso(),
      changes,
    };
    setPending(cmd);
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    let uncertain = false;
    try {
      await mobileStorage.workspaceCommand(cmd);
      setPending(null);
      await refresh();
      setMessage("已保存到本机");
      done?.();
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) setPending(null);
      else uncertain = true;
      setError(e instanceof Error ? e.message : "保存失败，请重试");
    } finally {
      setBusy(false);
      onBusyChange?.(uncertain);
    }
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  function reset() {
    setSelected(null);
    setName("");
    setBody("");
    setProjectId("");
    setTaskId("");
  }
  function edit(e: WorkspaceEntity) {
    setSelected(e);
    setName(title(e));
    setBody(str(e.data.body));
    setRecordKind(e.kind);
    setProjectId(str(e.data.projectId));
    setTaskId(str(e.data.taskId));
  }
  const button = (label: string, fn: () => void, cls = "") => (
    <button type="button" className={cls} disabled={busy} onClick={fn}>
      {label}
    </button>
  );
  const editor = (
    <form
      className="mx-form"
      onSubmit={(e) => {
        e.preventDefault();
        const data = {
          ...selected?.data,
          title: name.trim(),
          body,
          projectId: projectId || null,
          taskId: taskId || null,
        };
        void run(
          [selected ? change(selected, data) : fresh(recordKind, data)],
          reset,
        );
      }}
    >
      <label>
        标题
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={10000}
        />
      </label>
      <label>
        正文
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
        />
      </label>
      <label>
        关联项目
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setTaskId("");
          }}
        >
          <option value="">无</option>
          {live
            .filter((e) => e.kind === "project")
            .map((e) => (
              <option key={e.id} value={e.id}>
                {title(e)}
              </option>
            ))}
        </select>
      </label>
      <label>
        关联任务
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
          <option value="">无</option>
          {live
            .filter(
              (e) =>
                e.kind === "task" &&
                (!projectId || e.data.projectId === projectId),
            )
            .map((e) => (
              <option key={e.id} value={e.id}>
                {title(e)}
              </option>
            ))}
        </select>
      </label>
      <button disabled={busy || !name.trim()}>
        保存{selected ? "修改" : "记录"}
      </button>
      {selected && button("取消编辑", reset)}
    </form>
  );
  let content;
  if (section === "stats") {
    const tasks = live.filter((e) => e.kind === "task"),
      done = tasks.filter((e) => e.data.status === "completed");
    content = (
      <>
        <div className="mx-metrics">
          <div>
            <strong>{done.length}</strong>已完成任务
          </div>
          <div>
            <strong>
              {
                tasks.filter(
                  (e) =>
                    !["completed", "cancelled"].includes(str(e.data.status)),
                ).length
              }
            </strong>
            待推进任务
          </div>
          <div>
            <strong>
              {
                live.filter(
                  (e) => e.kind === "project" && e.data.status === "active",
                ).length
              }
            </strong>
            活跃项目
          </div>
        </div>
        <h3>近七天完成记录</h3>
        {Array.from({ length: 7 }, (_, i) => addDay(day(), i - 6)).map((d) => {
          const n = done.filter(
            (e) => day(new Date(str(e.data.completedAt || e.updatedAt))) === d,
          ).length;
          return (
            <div className="mx-bar" key={d}>
              <span>{d.slice(5)}</span>
              <meter min={0} max={Math.max(done.length, 1)} value={n} />
              <b>{n}</b>
            </div>
          );
        })}
        <p className="mx-muted">
          基于本工作空间已保存的数据；撤销完成后统计随之更新。
        </p>
      </>
    );
  } else if (section === "focus") {
    const sessions = live.filter((e) => e.kind === "focus"),
      active = sessions.find((e) => !e.data.endedAt),
      elapsed = active
        ? Math.max(
            0,
            Math.floor((tick - Date.parse(str(active.data.startedAt))) / 1000),
          )
        : 0;
    content = (
      <>
        <div className="mx-clock">
          {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
          {String(elapsed % 60).padStart(2, "0")}
        </div>
        {active ? (
          <>
            <p>{title(active)}</p>
            {button(
              "结束并保存",
              () =>
                void run([
                  change(active, {
                    ...active.data,
                    endedAt: iso(),
                    durationSeconds: elapsed,
                  }),
                ]),
            )}
          </>
        ) : (
          <form
            className="mx-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run([
                fresh("focus", {
                  title: name.trim() || "自由专注",
                  startedAt: iso(),
                  endedAt: null,
                }),
              ]);
            }}
          >
            <label>
              本次专注
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：阅读项目资料"
              />
            </label>
            <button disabled={busy}>开始专注</button>
          </form>
        )}
        <h3>专注历史</h3>
        {sessions
          .filter((e) => e.data.endedAt)
          .reverse()
          .map((e) => (
            <article key={e.id}>
              <b>{title(e)}</b>
              <p>
                {Math.floor(Number(e.data.durationSeconds) / 60)} 分钟 ·{" "}
                {day(new Date(str(e.data.startedAt)))}
              </p>
            </article>
          ))}
        <p className="mx-muted">
          时间会跨页面和应用重启继续累计；不包含系统后台提醒。
        </p>
      </>
    );
  } else if (
    section === "records" ||
    section === "templates" ||
    section === "review"
  ) {
    const kinds: WorkspaceKind[] =
      section === "templates"
        ? ["strategy", "decision"]
        : section === "review"
          ? ["review"]
          : ["record"];
    const templates: Record<string, string> = {
      strategy:
        "问题：\n\n指导方针：\n\n一致行动：\n\n明确不做：\n\n调整或停止条件：",
      decision:
        "事实：\n\n解释：\n\n替代解释：\n\n预期：\n\n检查日期：\n\n实际结果：\n\n更新：",
      review:
        "回顾期间：\n\n成果：\n\n阻塞：\n\n停止或暂停事项：\n\n下周重点：",
      record: "",
    };
    content = (
      <>
        <div className="mx-actions">
          {kinds.map((k) =>
            button("新建" + labels[k], () => {
              reset();
              setRecordKind(k);
              setBody(templates[k] || "");
            }),
          )}
        </div>
        {(name || body || selected) && editor}
        <h3>已保存{section === "review" ? "回顾" : "内容"}</h3>
        {live
          .filter((e) => kinds.includes(e.kind))
          .reverse()
          .map((e) => (
            <article key={e.id}>
              <details>
                <summary>
                  {title(e)} <small>{labels[e.kind]}</small>
                </summary>
                <p className="mx-muted">
                  {e.data.projectId
                    ? `关联项目：${live.find((p) => p.id === e.data.projectId)?.data.title || "原项目已移除"}`
                    : ""}
                  {e.data.taskId
                    ? ` · 关联任务：${live.find((t) => t.id === e.data.taskId)?.data.title || "原任务已移除"}`
                    : ""}
                </p>
                <p className="mx-body">{str(e.data.body)}</p>
                <div className="mx-actions">
                  {button("编辑", () => edit(e))}
                  {button(
                    "移入回收站",
                    () => void run([change(e, e.data, true)]),
                  )}
                </div>
              </details>
            </article>
          ))}
        {section === "records" && !name && !body && !selected && <>{editor}</>}{" "}
        {section === "review" && (
          <ProjectChecks
            entities={snapshot.entities}
            today={day()}
            onSelect={(p) => {
              if (dirty) {
                setReviewTarget(p);
                return;
              }
              reset();
              setRecordKind("review");
              setProjectId(p.id);
              setName(`${title(p)} · ${day()} 回顾`);
              setBody(templates.review || "");
            }}
          />
        )}
      </>
    );
  } else if (section === "habits" || section === "repeat") {
    const kind = section === "habits" ? "habit" : "recurrence";
    content = (
      <>
        <form
          className="mx-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected) {
              const next: ScheduleRule = {
                effectiveDate,
                frequency,
                target,
                interval: target,
                weekdays,
                paused: false,
                active: true,
                timeZone,
              };
              const impact =
                kind === "recurrence"
                  ? futureRuleChanges(selected, next, snapshot.entities)
                  : { changes: [], preserved: 0 };
              setRulePreview({
                changes: [
                  change(selected, preserveRuleHistory(selected, next)),
                  ...impact.changes,
                ],
                preserved: impact.preserved,
              });
            } else
              void run(
                [
                  fresh(kind, {
                    title: name.trim(),
                    trigger,
                    normalVersion,
                    minimumVersion,
                    projectId: projectId || null,
                    frequency,
                    target,
                    interval: target,
                    weekdays,
                    startDate: date,
                    ruleHistory: [
                      {
                        effectiveDate: date,
                        frequency,
                        target,
                        interval: target,
                        weekdays,
                        paused: false,
                        active: true,
                        timeZone,
                      },
                    ],
                    paused: false,
                    active: true,
                    timeZone,
                  }),
                ],
                reset,
              );
          }}
        >
          <label>
            {kind === "habit" ? "习惯名称" : "重复任务标题"}
            <input
              required
              readOnly={!!selected}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="mx-grid">
            <label>
              规则
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                <option value="daily">每天</option>
                <option value="weekdays">指定星期</option>
                <option value={kind === "habit" ? "weekly" : "interval"}>
                  {kind === "habit" ? "每周 N 次" : "每隔 N 天"}
                </option>
              </select>
            </label>
            <label>
              开始日期
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
          </div>
          {kind === "habit" && !selected && (
            <>
              <label>
                触发情境
                <input
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                  placeholder="例如：早餐后"
                />
              </label>
              <label>
                正常版本
                <input
                  value={normalVersion}
                  onChange={(e) => setNormalVersion(e.target.value)}
                />
              </label>
              <label>
                最低版本
                <input
                  value={minimumVersion}
                  onChange={(e) => setMinimumVersion(e.target.value)}
                  placeholder="忙碌时也能完成的一小步"
                />
              </label>
              <label>
                关联项目
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">无</option>
                  {live
                    .filter((e) => e.kind === "project")
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {title(e)}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          {frequency === "weekdays" ? (
            <div className="mx-actions">
              {["日", "一", "二", "三", "四", "五", "六"].map((d, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={weekdays.includes(i)}
                    onChange={() =>
                      setWeekdays(
                        weekdays.includes(i)
                          ? weekdays.filter((n) => n !== i)
                          : [...weekdays, i],
                      )
                    }
                  />
                  {d}
                </label>
              ))}
            </div>
          ) : (
            frequency !== "daily" && (
              <label>
                次数 / 间隔天数
                <input
                  type="number"
                  min={1}
                  max={kind === "habit" ? 7 : 365}
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                />
              </label>
            )
          )}
          {selected && (
            <label>
              规则生效日期
              <input
                type="date"
                min={addDay(day(), 1)}
                required
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </label>
          )}
          <button
            disabled={
              busy ||
              !name.trim() ||
              (frequency === "weekdays" && !weekdays.length)
            }
          >
            {selected ? "预览规则变更" : "创建"}
          </button>
          {selected &&
            button("取消编辑", () => {
              reset();
              setRulePreview(null);
            })}
          {rulePreview && (
            <div>
              <p>
                从 {effectiveDate} 生效；取消未来任务{" "}
                {rulePreview.changes.length - 1} 项，保留手动例外{" "}
                {rulePreview.preserved} 项。过去记录不变。
              </p>
              {button(
                "确认新规则",
                () =>
                  void run(rulePreview.changes, () => {
                    reset();
                    setRulePreview(null);
                  }),
              )}
            </div>
          )}
        </form>
        {kind === "habit" && (
          <label>
            记录日期
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={day()}
            />
          </label>
        )}
        {live
          .filter((e) => e.kind === kind)
          .map((e) => {
            const check = live.find(
              (c) =>
                c.kind === "habit_check" &&
                c.data.habitId === e.id &&
                c.data.date === date,
            );
            const weekday = new Date(date + "T12:00:00Z").getUTCDay();
            const monday = addDay(date, -((weekday + 6) % 7));
            const rule = ruleAt(e, date);
            const applicable = date <= day() && matchesRule(rule, date);
            const checks = live.filter(
              (c) =>
                c.kind === "habit_check" &&
                c.data.habitId === e.id &&
                str(c.data.date) >= monday &&
                str(c.data.date) <= addDay(monday, 6),
            );
            const weekDates = Array.from({ length: 7 }, (_, i) =>
              addDay(monday, i),
            );
            const available = weekDates.filter((d) =>
              matchesRule(ruleAt(e, d), d),
            );
            const partial =
              weekDates.some(
                (d) => d < str(e.data.startDate) || ruleAt(e, d).paused,
              ) ||
              weekDates.some(
                (d) =>
                  ruleAt(e, d).effectiveDate !==
                  ruleAt(e, monday).effectiveDate,
              );
            const goal =
              rule.frequency === "weekly"
                ? Math.min(rule.target, available.length)
                : available.length;
            return (
              <article key={e.id}>
                <h3>{title(e)}</h3>
                {kind === "habit" && (
                  <p className="mx-muted">
                    {str(e.data.trigger)} {str(e.data.normalVersion)}{" "}
                    {e.data.minimumVersion
                      ? `最低版本：${str(e.data.minimumVersion)}`
                      : ""}
                  </p>
                )}
                {button("修改未来规则", () => {
                  setSelected(e);
                  setName(title(e));
                  const r = ruleAt(e, addDay(day(), 1));
                  setFrequency(r.frequency);
                  setTarget(e.kind === "habit" ? r.target : r.interval);
                  setWeekdays(r.weekdays);
                  setEffectiveDate(addDay(day(), 1));
                  setRulePreview(null);
                })}
                <p>
                  {rule.frequency === "daily"
                    ? "每天"
                    : rule.frequency === "weekly"
                      ? `每周 ${rule.target} 次`
                      : rule.frequency === "interval"
                        ? `每隔 ${rule.interval} 天`
                        : "指定星期"}{" "}
                  ·{" "}
                  {ruleAt(e, date).paused || !ruleAt(e, date).active
                    ? "已暂停"
                    : "启用中"}
                </p>
                {kind === "habit" ? (
                  <>
                    <p>
                      本周完成{" "}
                      {checks.filter((c) => c.data.status === "done").length}{" "}
                      次，跳过{" "}
                      {checks.filter((c) => c.data.status === "skipped").length}{" "}
                      次；目标 {goal} 次。剩余适用日期{" "}
                      {
                        available.filter(
                          (d) =>
                            d >= day() &&
                            !checks.some((c) => c.data.date === d),
                        ).length
                      }{" "}
                      天
                      {partial && (
                        <small>（新建、规则变更或暂停造成的不完整周）</small>
                      )}
                    </p>
                    <div className="mx-actions">
                      {applicable &&
                        button(
                          check?.data.status === "done" ? "已完成" : "完成",
                          () =>
                            void run([
                              check
                                ? change(check, {
                                    ...check.data,
                                    status: "done",
                                  })
                                : fresh("habit_check", {
                                    habitId: e.id,
                                    date,
                                    status: "done",
                                    timeZone,
                                    recordedAt: iso(),
                                    ruleEffectiveDate: rule.effectiveDate,
                                  }),
                            ]),
                        )}
                      {applicable &&
                        button(
                          "跳过",
                          () =>
                            void run([
                              check
                                ? change(check, {
                                    ...check.data,
                                    status: "skipped",
                                  })
                                : fresh("habit_check", {
                                    habitId: e.id,
                                    date,
                                    status: "skipped",
                                    timeZone,
                                    recordedAt: iso(),
                                    ruleEffectiveDate: rule.effectiveDate,
                                  }),
                            ]),
                        )}
                      {!applicable && <small>当前日期不适用或习惯已暂停</small>}
                      {check &&
                        button(
                          "撤销",
                          () => void run([change(check, check.data, true)]),
                        )}
                      {button(
                        ruleAt(e, addDay(day(), 1)).paused
                          ? "明日起恢复"
                          : "明日起暂停",
                        () =>
                          void run([
                            change(
                              e,
                              preserveRuleHistory(e, {
                                ...ruleAt(e, date),
                                effectiveDate: addDay(day(), 1),
                                paused: !ruleAt(e, addDay(day(), 1)).paused,
                              }),
                            ),
                          ]),
                      )}
                    </div>
                  </>
                ) : (
                  <div className="mx-actions">
                    {button("补齐至未来 30 天", () => {
                      const changes: WorkspaceChange[] = [];
                      let cursor = str(e.data.startDate);
                      const end = addDay(day(), 30);
                      let count = 0;
                      while (cursor <= end && count < 3660) {
                        const match = matchesRule(ruleAt(e, cursor), cursor);
                        if (
                          match &&
                          !snapshot.entities.some(
                            (t) =>
                              t.kind === "task" &&
                              t.data.recurrenceId === e.id &&
                              t.data.originalDate === cursor,
                          )
                        )
                          changes.push(
                            fresh("task", {
                              title: title(e),
                              status: "todo",
                              executionDate: cursor,
                              originalDate: cursor,
                              recurrenceId: e.id,
                              priority: 0,
                              tags: [],
                            }),
                          );
                        cursor = addDay(cursor, 1);
                        count++;
                      }
                      if (count >= 3660 && cursor <= end) {
                        setError("此模板跨度超过十年，请调整开始日期后重试");
                        return;
                      }
                      if (changes.length) void run(changes);
                      else setMessage("当前范围已补齐，或模板已停止");
                    })}
                    {button(
                      !ruleAt(e, addDay(day(), 1)).active
                        ? "明日起恢复"
                        : "明日起停止",
                      () =>
                        void run([
                          change(
                            e,
                            preserveRuleHistory(e, {
                              ...ruleAt(e, day()),
                              effectiveDate: addDay(day(), 1),
                              active: !ruleAt(e, addDay(day(), 1)).active,
                            }),
                          ),
                        ]),
                    )}
                  </div>
                )}
              </article>
            );
          })}
      </>
    );
  } else if (section === "search") {
    content = (
      <SearchPanel entities={snapshot.entities} today={day()} save={run} />
    );
  } else if (section === "trash") {
    content = (
      <>
        <p className="mx-muted">
          恢复时会检查关联内容；父项目或父任务已删除时，请先恢复父项。
        </p>
        {snapshot.entities
          .filter((e) => e.deleted)
          .map((e) => (
            <article key={e.id}>
              <small>{labels[e.kind]}</small>
              <h3>{title(e)}</h3>
              {button("恢复", () => void run([change(e)]))}
            </article>
          ))}
      </>
    );
  } else {
    content = (
      <>
        <h3>工作空间</h3>
        <label>
          切换工作空间
          <select
            value={spaces.find((w) => w.active)?.id ?? ""}
            onChange={(e) =>
              void action(async () => {
                await mobileStorage.workspaceSwitch(e.target.value);
                await refresh();
              })
            }
          >
            {spaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </label>
        <p>本机离线保存 · 云同步尚未连接</p>
        <form
          className="mx-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run([
              settings
                ? change(settings, { ...settings.data, timeZone: zone })
                : fresh("settings", { timeZone: zone }),
            ]);
          }}
        >
          <label>
            工作空间时区
            <input
              value={zone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="Asia/Hong_Kong"
            />
          </label>
          <p className="mx-muted">既有任务日期、重复模板与打卡历史保持原值。</p>
          <button disabled={busy}>保存时区</button>
        </form>
        <CommandHistory
          key={spaces.find((w) => w.active)?.id}
          timeZone={timeZone}
        />
        <h3>数据导出与恢复</h3>
        {button(
          "生成完整本机 JSON",
          () =>
            void action(async () => {
              setJson(await mobileStorage.workspaceExport());
              setPreview("");
              setMessage("已生成导出内容，可复制或下载保存");
            }),
        )}
        <label>
          导出内容 / 待恢复文件
          <textarea
            className="mx-json"
            rows={7}
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              importOperation.current = null;
              setPreview("");
              setConfirmImport(false);
            }}
          />
        </label>
        <div className="mx-actions">
          {button(
            "复制 JSON",
            () =>
              void action(async () => {
                await navigator.clipboard.writeText(json);
                setMessage("已复制");
              }),
          )}
          {button(
            "保存或分享 JSON",
            () =>
              void action(async () => {
                if (!json) throw new Error("请先生成导出内容");
                await exportMobileJson(json);
                setMessage("已打开系统分享，请在目标应用中完成保存");
              }),
          )}
        </div>
        <label>
          选择 JSON 文件
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action(async () => {
                  if (file.size > 25_000_000) throw new Error("文件大于 25 MB");
                  setJson(await file.text());
                  importOperation.current = null;
                  setPreview("");
                  setConfirmImport(false);
                });
            }}
          />
        </label>
        {button("预览恢复", () => {
          try {
            const result = previewWorkspaceImport(json);
            setPreview(
              `已校验 ${result.count} 项内容：${Object.entries(result.counts)
                .map(([kind, count]) => `${labels[kind] ?? kind} ${count}`)
                .join("，")}。将创建新工作空间。`,
            );
            setConfirmImport(false);
          } catch (e) {
            setError(e instanceof Error ? e.message : "JSON 无效");
          }
        })}
        {preview && (
          <>
            <p>{preview}</p>
            <label>
              <input
                type="checkbox"
                checked={confirmImport}
                onChange={(e) => setConfirmImport(e.target.checked)}
              />
              确认恢复到新工作空间，保留当前数据
            </label>
            <button
              disabled={busy || !confirmImport}
              onClick={() =>
                void action(async () => {
                  importOperation.current ??= crypto.randomUUID();
                  await mobileStorage.workspaceImport(
                    json,
                    importOperation.current,
                  );
                  importOperation.current = null;
                  await refresh();
                  setMessage("恢复完成");
                  setPreview("");
                })
              }
            >
              恢复到新工作空间
            </button>
          </>
        )}
        <p className="mx-muted">
          仅导出本机已有内容。未接入云同步；导出不包含账户密钥。
        </p>
      </>
    );
  }
  return (
    <section className="mobile-extras">
      <h2>
        {
          {
            habits: "习惯",
            repeat: "重复任务",
            records: "记录",
            templates: "策略与决策",
            review: "每周回顾",
            search: "搜索与视图",
            trash: "回收站",
            settings: "设置",
            stats: "进度统计",
            focus: "专注计时",
          }[section]
        }
      </h2>
      {reviewTarget && (
        <div role="alertdialog" aria-label="替换未保存回顾" className="mx-form">
          <p>
            当前回顾尚未保存。放弃当前编辑并为「{title(reviewTarget)}
            」创建回顾？
          </p>
          {button("保留当前编辑", () => setReviewTarget(null))}
          {button("放弃并新建回顾", () => {
            const p = reviewTarget;
            setReviewTarget(null);
            reset();
            setRecordKind("review");
            setProjectId(p.id);
            setName(`${title(p)} · ${day()} 回顾`);
            setBody(
              "回顾期间：\n\n成果：\n\n阻塞：\n\n停止或暂停事项：\n\n下周重点：",
            );
          })}
        </div>
      )}
      {dirty && !busy && !pending && (
        <div className="mx-muted">
          当前有编辑内容。
          {button("放弃编辑", () => {
            reset();
            setRulePreview(null);
          })}
        </div>
      )}
      {error && (
        <div className="mx-error" role="alert">
          {error}
          {pending && button("重试同一操作", () => void run(pending.changes))}
        </div>
      )}
      {message && (
        <p role="status" className="mx-muted">
          {message}
        </p>
      )}
      <fieldset disabled={busy || (!!pending && !!error)}>{content}</fieldset>
    </section>
  );
}
export const MobileExtras = Extras;
