import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import "./search-views.css";

type Condition = { field: string; op: string; value: string };
type Query = {
  text: string;
  entityType: string;
  projectId: string | null;
  status: string | null;
  includeArchived: boolean;
  groups: Condition[][];
  sort: string;
  groupBy: string;
};
type Saved = {
  id: string;
  name: string;
  query: Query;
  followed: boolean;
  version: number;
};
type Snapshot = {
  views: Saved[];
  projects: { id: string; name: string }[];
  labels: { id: string; name: string }[];
  presets: { name: string; query: Query }[];
};
type Row = {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  group: string;
  projectName?: string;
  priority?: number;
};
type Result = {
  rows: Row[];
  warnings: string[];
  timeZone: string;
  today: string;
};
type Command = {
  operationId: string;
  occurredAt: string;
  action: Record<string, unknown>;
};
const retries = new RetriableCommands<Command>();
const empty: Query = {
  text: "",
  entityType: "all",
  projectId: null,
  status: null,
  includeArchived: false,
  groups: [],
  sort: "title",
  groupBy: "type",
};
const types: Record<string, string> = {
  task: "任务",
  project: "项目",
  record: "记录",
  habit: "习惯",
  all: "全部",
};
const statuses: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  waiting: "等待",
  blocked: "阻塞",
  completed: "已完成",
  cancelled: "已取消",
  active: "活跃",
  paused: "暂停",
  draft: "草稿",
};
const fields: Record<string, string> = {
  project: "项目",
  status: "任务状态",
  label: "标签",
  priority: "优先级",
  estimate: "预计分钟",
  plan: "计划日期",
  deadline: "截止日期",
  followUp: "跟进日期",
  nextAction: "主下一步",
  independent: "独立任务",
  projectActive: "项目活跃",
  unblocked: "未阻塞",
};
const ops: Record<string, string> = {
  eq: "等于",
  lte: "不晚于 / 不超过",
  gte: "不早于 / 不少于",
  empty: "未设置",
  present: "已设置",
  due: "今天或更早",
  thisWeek: "本周（周一至周日）",
};
const dateFields = ["plan", "deadline", "followUp"];
const boolFields = ["nextAction", "independent", "projectActive", "unblocked"];
function defaultCondition(field = "status"): Condition {
  return {
    field,
    op: dateFields.includes(field) ? "present" : "eq",
    value:
      field === "status"
        ? "todo"
        : field === "priority"
          ? "4"
          : field === "estimate"
            ? "15"
            : boolFields.includes(field)
              ? "true"
              : "",
  };
}
export function FollowedViews({
  onOpen,
  disabled = false,
  revision = 0,
}: {
  onOpen: (id: string) => void;
  disabled?: boolean;
  revision?: number;
}) {
  const [views, setViews] = useState<Saved[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    invoke<Snapshot>("view_snapshot")
      .then((s) => {
        if (alive) {
          setViews(s.views.filter((v) => v.followed));
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  return (
    <nav aria-label="关注的工作视图">
      {views.map((v) => (
        <button key={v.id} disabled={disabled} onClick={() => onOpen(v.id)}>
          {v.name}
        </button>
      ))}
      {error && <small role="status">工作视图暂时无法加载</small>}
    </nav>
  );
}
export function SearchViews({
  initialViewId,
  onChanged,
}: {
  initialViewId?: string | null;
  onChanged?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState<Query>(empty);
  const [result, setResult] = useState<Result | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [name, setName] = useState("");
  const [followed, setFollowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const lock = useRef(false);
  const request = useRef(0);
  const loadedId = useRef<string | null>(null);
  const newId = useRef(crypto.randomUUID());
  async function refresh() {
    const s = await invoke<Snapshot>("view_snapshot");
    setSnapshot(s);
    return s;
  }
  async function search(q: Query) {
    const generation = ++request.current;
    setError("");
    setBusy(true);
    try {
      const data = await invoke<Result>("view_query", { query: q });
      if (generation === request.current) setResult(data);
    } catch (e) {
      if (generation === request.current) setError(String(e));
    } finally {
      if (generation === request.current) setBusy(false);
    }
  }
  function choose(v: { query: Query; name: string } & Partial<Saved>) {
    setQuery(v.query);
    setSaved(v.id ? (v as Saved) : null);
    setName(v.name);
    setFollowed(v.followed ?? false);
    setNotice("");
    setDeleteConfirm(false);
    newId.current = crypto.randomUUID();
    void search(v.query);
  }
  useEffect(() => {
    let alive = true;
    invoke<Snapshot>("view_snapshot")
      .then((s) => {
        if (alive) setSnapshot(s);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    if (snapshot && initialViewId && loadedId.current !== initialViewId) {
      const v = snapshot.views.find((v) => v.id === initialViewId);
      if (v) {
        loadedId.current = initialViewId;
        choose(v);
      } else {
        loadedId.current = initialViewId;
        setError("这个视图已删除或不可用。");
      }
    }
  }, [initialViewId, snapshot]);
  async function command(action: Record<string, unknown>) {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await retries.execute(
        String(action.id),
        (c) => JSON.stringify(c.action) === JSON.stringify(action),
        () => ({
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          action,
        }),
        (c) => invoke("view_command", { command: c }),
      );
      await refresh().catch((e) =>
        setError(`保存成功，但列表刷新失败：${String(e)}`),
      );
      onChanged?.();
      return true;
    } catch (e) {
      setError(
        String(e).includes("STATE_CONFLICT")
          ? "视图已改变。输入已保留；请重新载入视图后再保存，或另存副本。"
          : String(e),
      );
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save(copy: boolean) {
    const id = copy || !saved ? newId.current : saved.id;
    if (
      await command({
        type: "save",
        id,
        expectedVersion: copy ? null : (saved?.version ?? null),
        name,
        query,
        followed,
      })
    ) {
      const version = copy || !saved ? 0 : saved.version + 1;
      setSaved({ id, name, query, followed, version });
      newId.current = crypto.randomUUID();
      setNotice("已保存到本机。排序、分组及关注设置已保留。");
    }
  }
  function updateGroup(gi: number, ci: number, c: Condition) {
    setQuery((q) => ({
      ...q,
      groups: q.groups.map((g, i) =>
        i === gi ? g.map((old, j) => (j === ci ? c : old)) : g,
      ),
    }));
  }
  function condition(c: Condition, gi: number, ci: number) {
    const allowed = dateFields.includes(c.field)
      ? ["eq", "lte", "gte", "empty", "present", "due", "thisWeek"]
      : c.field === "estimate"
        ? ["eq", "lte", "gte"]
        : c.field === "priority"
          ? ["eq", "lte"]
          : ["eq"];
    let values: { id: string; name: string }[] | undefined;
    if (c.field === "project") values = snapshot?.projects;
    if (c.field === "label") values = snapshot?.labels;
    if (c.field === "status")
      values = Object.entries(statuses)
        .filter(([id]) => !["active", "paused", "draft"].includes(id))
        .map(([id, name]) => ({ id, name }));
    if (boolFields.includes(c.field))
      values = [
        { id: "true", name: "是" },
        { id: "false", name: "否" },
      ];
    if (c.field === "priority")
      values = [1, 2, 3, 4].map((n) => ({ id: String(n), name: `P${n}` }));
    return (
      <div className="view-condition" key={ci}>
        <select
          aria-label={`条件 ${gi + 1}-${ci + 1} 字段`}
          value={c.field}
          onChange={(e) =>
            updateGroup(gi, ci, defaultCondition(e.target.value))
          }
        >
          {Object.entries(fields).map(([v, n]) => (
            <option key={v} value={v}>
              {n}
            </option>
          ))}
        </select>
        <select
          aria-label="比较方式"
          value={c.op}
          onChange={(e) =>
            updateGroup(gi, ci, {
              ...c,
              op: e.target.value,
              value: ["empty", "present", "due", "thisWeek"].includes(
                e.target.value,
              )
                ? ""
                : c.value,
            })
          }
        >
          {allowed.map((op) => (
            <option key={op} value={op}>
              {ops[op]}
            </option>
          ))}
        </select>
        {!["empty", "present", "due", "thisWeek"].includes(c.op) &&
          (values ? (
            <select
              aria-label="条件值"
              value={c.value}
              onChange={(e) =>
                updateGroup(gi, ci, { ...c, value: e.target.value })
              }
            >
              <option value="">请选择</option>
              {c.value && !values.some((v) => v.id === c.value) && (
                <option value={c.value}>已删除引用：{c.value}</option>
              )}
              {values.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="条件值"
              type={dateFields.includes(c.field) ? "date" : "number"}
              min="1"
              max="1440"
              value={c.value}
              onChange={(e) =>
                updateGroup(gi, ci, { ...c, value: e.target.value })
              }
            />
          ))}
        <button
          type="button"
          onClick={() =>
            setQuery((q) => ({
              ...q,
              groups: q.groups
                .map((g, i) => (i === gi ? g.filter((_, j) => j !== ci) : g))
                .filter((g) => g.length),
            }))
          }
        >
          移除条件
        </button>
      </div>
    );
  }
  const groups = new Map<string, Row[]>();
  for (const row of result?.rows ?? []) {
    const label = statuses[row.group] ?? types[row.group] ?? row.group;
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return (
    <section className="search-views" aria-label="搜索与视图">
      <h2>搜索与工作视图</h2>
      <p>本机离线搜索。回收站内容不参与结果；保存的视图只包含任务。</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!snapshot ? (
        <p>
          正在加载视图…{" "}
          <button
            onClick={() => void refresh().catch((e) => setError(String(e)))}
          >
            重新加载
          </button>
        </p>
      ) : (
        <>
          <div className="view-shortcuts">
            <label>
              载入视图
              <select
                aria-label="载入视图"
                value={saved?.id ?? ""}
                disabled={busy}
                onChange={(e) => {
                  const v = snapshot.views.find((v) => v.id === e.target.value);
                  if (v) choose(v);
                }}
              >
                <option value="">选择已保存视图</option>
                {snapshot.views.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.followed ? "★ " : ""}
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy}
              onClick={() => choose({ name: "", query: empty })}
            >
              新搜索
            </button>
            {snapshot.presets.map((p) => (
              <button key={p.name} disabled={busy} onClick={() => choose(p)}>
                {p.name}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void search(query);
            }}
          >
            <fieldset disabled={busy}>
              <legend>搜索范围</legend>
              <label>
                文字
                <input
                  aria-label="搜索文字"
                  value={query.text}
                  onChange={(e) => setQuery({ ...query, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      (e.nativeEvent.isComposing || e.keyCode === 229)
                    )
                      e.preventDefault();
                  }}
                  placeholder="标题或正文"
                />
              </label>
              <label>
                类型
                <select
                  value={query.entityType}
                  onChange={(e) =>
                    setQuery({
                      ...query,
                      entityType: e.target.value,
                      groups: e.target.value === "task" ? query.groups : [],
                    })
                  }
                >
                  {Object.entries(types).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                项目范围
                <select
                  value={query.projectId ?? ""}
                  onChange={(e) =>
                    setQuery({ ...query, projectId: e.target.value || null })
                  }
                >
                  <option value="">所有项目</option>
                  {snapshot.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                状态
                <select
                  value={query.status ?? ""}
                  onChange={(e) =>
                    setQuery({ ...query, status: e.target.value || null })
                  }
                >
                  <option value="">全部状态</option>
                  {Object.entries(statuses).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={query.includeArchived}
                  onChange={(e) =>
                    setQuery({ ...query, includeArchived: e.target.checked })
                  }
                />
                包含归档项目及其任务
              </label>
            </fieldset>
            {query.entityType === "task" && (
              <fieldset disabled={busy}>
                <legend>
                  条件组：组内全部符合（AND），组间任一符合（OR，最多 3 组）
                </legend>
                {query.groups.map((group, gi) => (
                  <div className="view-group" key={gi}>
                    <p>条件组 {gi + 1}</p>
                    {group.map((c, ci) => condition(c, gi, ci))}
                    <button
                      type="button"
                      disabled={group.length >= 12}
                      onClick={() =>
                        setQuery({
                          ...query,
                          groups: query.groups.map((g, i) =>
                            i === gi ? [...g, defaultCondition()] : g,
                          ),
                        })
                      }
                    >
                      添加 AND 条件
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={query.groups.length >= 3}
                  onClick={() =>
                    setQuery({
                      ...query,
                      groups: [...query.groups, [defaultCondition()]],
                    })
                  }
                >
                  添加 OR 条件组
                </button>
                <p>
                  预计时长由你填写；“零碎处理”的 15 分钟阈值可在条件中修改。
                </p>
              </fieldset>
            )}
            <fieldset disabled={busy}>
              <legend>展示</legend>
              <label>
                排序
                <select
                  value={query.sort}
                  onChange={(e) => setQuery({ ...query, sort: e.target.value })}
                >
                  {Object.entries({
                    title: "标题",
                    priority: "优先级",
                    plan: "计划日期",
                    deadline: "截止日期",
                    followUp: "跟进日期",
                    created: "创建时间",
                  }).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                分组
                <select
                  value={query.groupBy}
                  onChange={(e) =>
                    setQuery({ ...query, groupBy: e.target.value })
                  }
                >
                  {Object.entries({
                    none: "不分组",
                    project: "项目",
                    status: "状态",
                    priority: "优先级",
                    type: "类型",
                  }).map(([v, n]) => (
                    <option key={v} value={v}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit">
                {busy ? "查询中…" : "搜索 / 应用筛选"}
              </button>
            </fieldset>
          </form>
          {query.entityType === "task" && (
            <fieldset disabled={busy}>
              <legend>保存任务视图</legend>
              <label>
                视图名称
                <input
                  aria-label="视图名称"
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={followed}
                  onChange={(e) => setFollowed(e.target.checked)}
                />
                关注到侧栏
              </label>
              <button disabled={!name.trim()} onClick={() => void save(false)}>
                {saved ? "保存视图修改" : "保存新视图"}
              </button>
              {saved && (
                <>
                  <button
                    disabled={!name.trim()}
                    onClick={() => void save(true)}
                  >
                    另存副本
                  </button>
                  <button onClick={() => setDeleteConfirm(true)}>
                    删除视图
                  </button>
                  {deleteConfirm && (
                    <span>
                      仅删除视图，保留任务。
                      <button
                        onClick={() => {
                          void command({
                            type: "delete",
                            id: saved.id,
                            expectedVersion: saved.version,
                          }).then((ok) => {
                            if (ok) {
                              setSaved(null);
                              setDeleteConfirm(false);
                              setNotice("视图已删除，任务保留。");
                            }
                          });
                        }}
                      >
                        确认删除视图
                      </button>
                      <button onClick={() => setDeleteConfirm(false)}>
                        返回
                      </button>
                    </span>
                  )}
                </>
              )}
            </fieldset>
          )}
          {result ? (
            <div aria-live="polite">
              {result.warnings.map((w) => (
                <p role="alert" key={w}>
                  {w}
                </p>
              ))}
              <p>
                {result.rows.length} 项 · 工作空间时区 {result.timeZone} ·{" "}
                {result.today}。结果对应最近一次查询。
              </p>
              {!result.rows.length && <p>没有符合当前搜索和条件的内容。</p>}
              {[...groups].map(([group, rows]) => (
                <section key={group}>
                  <h3>{group}</h3>
                  {rows.map((row) => (
                    <article key={`${row.type}:${row.id}`}>
                      <button onClick={() => setDetail(row)}>
                        {row.title || "无标题记录"}
                      </button>
                      <small>
                        {types[row.type]} · {statuses[row.status] ?? row.status}
                        {row.projectName ? ` · ${row.projectName}` : ""}
                      </small>
                      <p>{row.body.slice(0, 180)}</p>
                      {row.type === "task" && (
                        <button
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent("praxis-work-task", {
                                detail: row.id,
                              }),
                            )
                          }
                        >
                          打开任务
                        </button>
                      )}
                      {row.type === "project" && (
                        <button
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent("praxis-work-project", {
                                detail: row.id,
                              }),
                            )
                          }
                        >
                          打开项目
                        </button>
                      )}
                    </article>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <p>输入文字或选择预设后查询；尚未执行搜索。</p>
          )}
        </>
      )}
      {detail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="搜索内容全文"
          className="view-detail"
        >
          <h3>{detail.title || "无标题记录"}</h3>
          <p>
            {types[detail.type]} · {statuses[detail.status] ?? detail.status}
          </p>
          <div>{detail.body}</div>
          <button autoFocus onClick={() => setDetail(null)}>
            关闭全文
          </button>
        </div>
      )}
    </section>
  );
}
