import { feedbackMessage } from "./feedback-message";
import { useLanRefresh } from "./useLanRefresh";
import { useEffect, useState } from "react";
import { invoke } from "./native-recovery";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import "./habits.css";

type Habit = {
  createdAt: string;
  version: number;
  id: string;
  name: string;
  notes: string;
  triggerContext: string;
  normalVersion: string;
  minimumVersion: string;
  projectId: string | null;
  startDate: string;
};
type Entry = {
  status: "done" | "skipped" | null;
  note: string;
  version: number;
  timezone: string;
  occurredAt: string;
  scheduleVersion: number;
};
type Rule = {
  version: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  frequency: string;
  weeklyTarget: number;
  weekdays: string;
  paused: boolean;
};
export type Row = {
  placement: {
    dayPeriod: import("@praxis/application").DayPeriod;
    dayRank: number;
    version: number | null;
  };
  rules: Rule[];
  habit: Habit;
  entry: Entry | null;
  schedule: {
    intervalDays?: number;
    paused: boolean;
    frequency: string;
    weeklyTarget: number;
    weekdays: string;
  } | null;
  applicable: boolean;
  collapsed: boolean;
  week: {
    from: string;
    until: string;
    done: number;
    target: number;
    skipped: number;
    remainingDates: string[];
    state: string;
    incomplete: boolean;
  };
};
export type Snapshot = {
  date: string;
  today: string;
  timeZone: string;
  habits: Row[];
};
type Action = Record<string, unknown> & { type: string };
type Command = { operationId: string; occurredAt: string; action: Action };
const retries = new RetriableCommands<Command>();
async function send(action: Action) {
  await retries.execute(
    String(action.id),
    (c) => JSON.stringify(c.action) === JSON.stringify(action),
    () => ({
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action,
    }),
    (command) => invoke("habit_command", { command }),
  );
}
export function HabitsView({
  date,
  compact = false,
}: {
  date?: string;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState(
    date ?? new Date().toISOString().slice(0, 10),
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  useLanRefresh(
    () => invoke<Snapshot>("habit_snapshot", { date: date ?? selected }),
    (next) => {
      setSnapshot(next);
      setNotes({});
    },
    busy ||
      creating ||
      Object.entries(notes).some(
        ([id, note]) =>
          note !==
          (snapshot?.habits.find((row) => row.habit.id === id)?.entry?.note ??
            ""),
      ),
    date ?? selected,
  );
  async function refresh() {
    setSnapshot(
      await invoke<Snapshot>("habit_snapshot", { date: date ?? selected }),
    );
  }
  useEffect(() => {
    let alive = true;
    invoke<Snapshot>("habit_snapshot", { date: date ?? selected })
      .then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [date, selected]);
  useEffect(() => {
    if (!date)
      invoke<Snapshot>("habit_snapshot", {
        date: new Date().toISOString().slice(0, 10),
      })
        .then((s) => setSelected(s.today))
        .catch((e) => setError(String(e)));
    invoke<{ projects: { id: string; name: string }[] }>(
      "productivity_snapshot",
    )
      .then((s) => setProjects(s.projects))
      .catch((e) => setError(String(e)));
  }, []);
  async function save(action: Action) {
    setBusy(true);
    setError("");
    try {
      await send(action);
      await refresh();
      window.dispatchEvent(new Event("praxis-lan-sync"));
      return true;
    } catch (e) {
      setError(
        String(e).includes("STATE_CONFLICT")
          ? "记录已改变，已刷新；请检查后重试。"
          : String(e),
      );
      await refresh().catch(() => {});
      return false;
    } finally {
      setBusy(false);
    }
  }
  function record(row: Row, status: "done" | "skipped" | null) {
    if (!snapshot) return;
    void save({
      type: "entry",
      id: row.habit.id,
      date: date ?? selected,
      status,
      note: notes[row.habit.id] ?? row.entry?.note ?? "",
      timeZone: snapshot.timeZone,
      expectedVersion: row.entry?.version ?? null,
    });
  }
  function card(row: Row) {
    const h = row.habit;
    const w = row.week;
    return (
      <article className="habit-card" key={h.id} data-habit-id={h.id}>
        <h3>{h.name}</h3>
        <p>
          {(row.schedule?.intervalDays ?? 1) > 1
            ? `每 ${row.schedule?.intervalDays} 天`
            : row.schedule?.frequency === "weekly"
              ? `每周 ${row.schedule.weeklyTarget} 次`
              : row.schedule?.frequency === "daily"
                ? "每日"
                : row.schedule
                  ? `星期 ${JSON.parse(row.schedule.weekdays).join("、")}`
                  : "该日尚未开始"}{" "}
          ·{" "}
          {row.applicable
            ? row.entry?.status === "done"
              ? "已完成"
              : row.entry?.status === "skipped"
                ? "已跳过"
                : "未记录"
            : row.schedule?.paused
              ? "已暂停"
              : "该日不适用"}
        </p>
        {(h.triggerContext || h.normalVersion || h.minimumVersion) && (
          <p>
            触发：{h.triggerContext || "—"}；正常版本：{h.normalVersion || "—"}
            ；最低版本：{h.minimumVersion || "—"}
          </p>
        )}
        {h.notes && <p>{h.notes}</p>}
        {h.projectId && (
          <p>
            关联项目：
            {projects.find((p) => p.id === h.projectId)?.name ?? "项目引用"}
            （仅提供上下文）
          </p>
        )}
        <p>
          {w.from} ～ {w.until}：{w.done}/{w.target}，跳过 {w.skipped} 天 ·{" "}
          {w.state}
          {w.incomplete ? " · 不完整周，不作完整周达标评价" : ""}
        </p>
        <p>
          剩余可用日期 {w.remainingDates.length} 天：
          {w.remainingDates.join("、") || "无"}
        </p>
        {(row.applicable || row.entry?.status) && (
          <>
            <label>
              本次备注 / 跳过理由
              <input
                aria-label={`${h.name}备注`}
                value={notes[h.id] ?? row.entry?.note ?? ""}
                onChange={(e) => setNotes({ ...notes, [h.id]: e.target.value })}
              />
            </label>
            <div className="habit-actions">
              <button
                disabled={
                  busy ||
                  !row.applicable ||
                  (date ?? selected) > (snapshot?.today ?? "")
                }
                onClick={() => record(row, "done")}
              >
                完成
              </button>
              <button
                disabled={
                  busy ||
                  !row.applicable ||
                  (date ?? selected) > (snapshot?.today ?? "")
                }
                onClick={() => record(row, "skipped")}
              >
                跳过
              </button>
              <button
                disabled={busy || !row.entry?.status}
                onClick={() => record(row, null)}
              >
                撤销记录
              </button>
            </div>
          </>
        )}
        {!compact && snapshot && (
          <RuleForm
            key={`${h.id}:${h.version}`}
            row={row}
            today={snapshot.today}
            zone={snapshot.timeZone}
            busy={busy}
            save={save}
          />
        )}
        {row.entry?.status && (
          <small>
            原日期 {date ?? selected} · {row.entry.timezone} · 规则版本{" "}
            {row.entry.scheduleVersion + 1}
          </small>
        )}
      </article>
    );
  }
  const rows = (snapshot?.habits ?? []).filter(
    (row) =>
      (!compact || row.applicable) &&
      `${row.habit.name} ${row.habit.notes} ${row.habit.triggerContext} ${row.habit.normalVersion} ${row.habit.minimumVersion}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="habits-panel" aria-label="习惯">
      <header>
        <h2>{compact ? "当天习惯" : "习惯"}</h2>
        {!compact && (
          <button disabled={busy} onClick={() => setCreating(!creating)}>
            创建习惯
          </button>
        )}
      </header>
      <p>每周从周一开始。未记录不会变成逾期待办；每周次数由你选择执行日期。</p>
      {!compact && (
        <label>
          记录日期
          <input
            type="date"
            value={selected}
            onChange={(e) => e.target.value && setSelected(e.target.value)}
          />
        </label>
      )}
      <label>
        搜索习惯
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名称、说明或实践版本"
        />
      </label>
      {error && <p role="alert">{feedbackMessage(error)}</p>}
      {creating && (
        <HabitForm
          date={snapshot?.today ?? selected}
          projects={projects}
          busy={busy}
          save={async (action) => {
            if (await save(action)) setCreating(false);
          }}
        />
      )}
      {rows.filter((r) => !r.collapsed).map(card)}
      {rows.some((r) => r.collapsed) && (
        <details>
          <summary>本周已达标（仍可记录额外完成）</summary>
          {rows.filter((r) => r.collapsed).map(card)}
        </details>
      )}
      {snapshot && !rows.length && (
        <p>
          {compact
            ? "当天没有适用习惯。"
            : "暂无匹配习惯，可以创建一个小实践。"}
        </p>
      )}
    </section>
  );
}
function HabitForm({
  date,
  projects,
  busy,
  save,
}: {
  date: string;
  projects: { id: string; name: string }[];
  busy: boolean;
  save: (a: Action) => Promise<void>;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [frequency, setFrequency] = useState("daily");
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  return (
    <form
      className="habit-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void save({
          type: "create",
          id,
          name: String(f.get("name")),
          startDate: String(f.get("startDate")),
          frequency,
          weekdays: frequency === "weekdays" ? weekdays : [],
          weeklyTarget: Number(f.get("weeklyTarget") ?? 1),
          triggerContext: String(f.get("triggerContext")),
          normalVersion: String(f.get("normalVersion")),
          minimumVersion: String(f.get("minimumVersion")),
          notes: String(f.get("notes")),
          projectId: String(f.get("projectId")) || null,
        });
      }}
    >
      <label>
        习惯名称
        <input name="name" required maxLength={500} />
      </label>
      <label>
        开始日期
        <input name="startDate" type="date" required defaultValue={date} />
      </label>
      <label>
        频率
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
        >
          <option value="daily">每日</option>
          <option value="weekdays">指定星期</option>
          <option value="weekly">每周 N 次</option>
        </select>
      </label>
      {frequency === "weekdays" && (
        <fieldset>
          <legend>适用星期</legend>
          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
            <label key={d}>
              <input
                type="checkbox"
                checked={weekdays.includes(d)}
                onChange={(e) =>
                  setWeekdays(
                    e.target.checked
                      ? [...weekdays, d]
                      : weekdays.filter((w) => w !== d),
                  )
                }
              />
              周{d === 7 ? "日" : d}
            </label>
          ))}
        </fieldset>
      )}
      {frequency === "weekly" && (
        <label>
          每周目标
          <input
            name="weeklyTarget"
            type="number"
            min={1}
            max={7}
            defaultValue={3}
            required
          />
        </label>
      )}
      <label>
        触发情境
        <input name="triggerContext" />
      </label>
      <label>
        正常版本
        <input name="normalVersion" />
      </label>
      <label>
        最低版本
        <input name="minimumVersion" />
      </label>
      <label>
        说明
        <textarea name="notes" />
      </label>
      <label>
        关联项目
        <select name="projectId">
          <option value="">独立习惯</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy || (frequency === "weekdays" && !weekdays.length)}>
        保存习惯
      </button>
    </form>
  );
}

function RuleForm({
  row,
  today,
  zone,
  busy,
  save,
}: {
  row: Row;
  today: string;
  zone: string;
  busy: boolean;
  save: (a: Action) => Promise<boolean>;
}) {
  const latest = [...row.rules].sort((a, b) => b.version - a.version)[0] ?? {
    version: 0,
    effectiveFrom: row.habit.startDate,
    effectiveUntil: null,
    frequency: "daily",
    weeklyTarget: 1,
    weekdays: "[]",
    paused: false,
  };
  const [open, setOpen] = useState(false);
  const [frequency, setFrequency] = useState(latest.frequency);
  const [weekdays, setWeekdays] = useState<number[]>(
    JSON.parse(latest.weekdays),
  );
  const [target, setTarget] = useState(latest.weeklyTarget);
  const [paused, setPaused] = useState(latest.paused);
  const [when, setWhen] = useState("tomorrow");
  const [preview, setPreview] = useState<Action | null>(null);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(
    d.getUTCDate() + (when === "tomorrow" ? 1 : (8 - d.getUTCDay()) % 7 || 7),
  );
  const effective = d.toISOString().slice(0, 10);
  return (
    <div>
      <details>
        <summary>规则历史与生效区间</summary>
        {[...row.rules]
          .sort((a, b) => a.version - b.version)
          .map((r) => (
            <p key={r.version}>
              版本 {r.version + 1}：{r.effectiveFrom} 至{" "}
              {r.effectiveUntil ? `${r.effectiveUntil}（不含）` : "以后"} ·{" "}
              {r.paused
                ? "暂停"
                : r.frequency === "weekly"
                  ? `每周 ${r.weeklyTarget} 次`
                  : r.frequency === "daily"
                    ? "每日"
                    : `星期 ${JSON.parse(r.weekdays).join("、")}`}
            </p>
          ))}
      </details>
      {latest.effectiveFrom > today ? (
        <p>已安排 {latest.effectiveFrom} 生效的规则，生效后可再次调整。</p>
      ) : (
        <button
          disabled={busy}
          onClick={() => {
            setOpen(!open);
            setPreview(null);
          }}
        >
          暂停、恢复或变更规则
        </button>
      )}
      {open && (
        <form
          className="habit-form"
          onSubmit={(e) => {
            e.preventDefault();
            setPreview({
              type: "rule",
              id: row.habit.id,
              expectedVersion: row.habit.version,
              effectiveFrom: effective,
              timeZone: zone,
              frequency,
              weekdays: frequency === "weekdays" ? weekdays : [],
              weeklyTarget: target,
              paused,
              confirmed: true,
            });
          }}
        >
          <fieldset disabled={busy || !!preview}>
            <legend>新规则</legend>
            <label>
              执行状态
              <select
                value={String(paused)}
                onChange={(e) => setPaused(e.target.value === "true")}
              >
                <option value="false">执行 / 恢复</option>
                <option value="true">暂停</option>
              </select>
            </label>
            <label>
              频率
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
              >
                <option value="daily">每日</option>
                <option value="weekdays">指定星期</option>
                <option value="weekly">每周 N 次</option>
              </select>
            </label>
            {frequency === "weekdays" && (
              <div>
                {[1, 2, 3, 4, 5, 6, 7].map((v) => (
                  <label key={v}>
                    <input
                      type="checkbox"
                      checked={weekdays.includes(v)}
                      onChange={(e) =>
                        setWeekdays(
                          e.target.checked
                            ? [...weekdays, v]
                            : weekdays.filter((x) => x !== v),
                        )
                      }
                    />
                    周{v}
                  </label>
                ))}
              </div>
            )}
            {frequency === "weekly" && (
              <label>
                周目标
                <input
                  type="number"
                  min={1}
                  max={7}
                  value={target}
                  onChange={(e) => setTarget(Number(e.target.value))}
                />
              </label>
            )}
            <label>
              生效日期
              <select value={when} onChange={(e) => setWhen(e.target.value)}>
                <option value="tomorrow">次日</option>
                <option value="nextWeek">下周一</option>
              </select>
            </label>
            <button disabled={frequency === "weekdays" && !weekdays.length}>
              预览变更
            </button>
          </fieldset>
          {preview && (
            <div role="status">
              <p>
                {zone} 的 {effective} 起：
                {paused
                  ? "暂停，不产生执行要求"
                  : frequency === "weekly"
                    ? `每周 ${target} 次`
                    : frequency === "daily"
                      ? "每日"
                      : `星期 ${weekdays.join("、")}`}
                。原规则保留至生效日前一天；历史记录及其时区保持原样。跨规则或暂停的周标记为不完整周。
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void save(preview).then((ok) => {
                    if (ok) {
                      setOpen(false);
                      setPreview(null);
                    }
                  });
                }}
              >
                确认规则变更
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setPreview(null)}
              >
                返回修改
              </button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
