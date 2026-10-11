import { useState } from "react";
import type { WorkspaceChange, WorkspaceEntity } from "@praxis/storage-mobile";
import {
  emptyFilter,
  searchEntities,
  kindLabel,
  entityTitle,
  text,
  type SearchFilter,
} from "./extras-model";
export function SearchPanel({
  entities,
  today,
  save,
}: {
  entities: WorkspaceEntity[];
  today: string;
  save: (changes: WorkspaceChange[], done?: () => void) => Promise<void>;
}) {
  const [filter, setFilter] = useState<SearchFilter>(emptyFilter),
    [name, setName] = useState("");
  const live = entities.filter((e) => !e.deleted),
    results = searchEntities(entities, filter, today);
  const set = (key: keyof SearchFilter, value: string | boolean) =>
    setFilter({ ...filter, [key]: value });
  const groups = new Map<string, WorkspaceEntity[]>();
  for (const e of results) {
    const key =
      filter.group === "project"
        ? (live.find((p) => p.id === e.data.projectId)?.data.title as string) ||
          "独立内容"
        : filter.group === "status"
          ? (
              {
                todo: "待办",
                in_progress: "进行中",
                blocked: "阻塞",
                completed: "完成",
                cancelled: "取消",
                active: "活跃",
                archived: "归档",
              } as Record<string, string>
            )[text(e.data.status)] || "无状态"
          : filter.group === "kind"
            ? kindLabel(e.kind)
            : "全部结果";
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  const select = (
    key: keyof SearchFilter,
    label: string,
    options: [string, string][],
  ) => (
    <label>
      {label}
      <select
        value={String(filter[key])}
        onChange={(e) => set(key, e.target.value)}
      >
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="mx-form">
        <label>
          搜索标题或正文
          <input
            type="search"
            value={filter.query}
            onChange={(e) => set("query", e.target.value)}
          />
        </label>
        {select("preset", "常用清单", [
          ["", "自定义"],
          ["unplanned", "未安排独立任务"],
          ["focus", "集中推进（高优先级）"],
          ["small", "零碎处理（15 分钟内）"],
          ["waiting", "等待跟进"],
          ["week", "未来七日期限"],
        ])}
        <div className="mx-grid">
          {select("kind", "类型", [
            ["", "全部"],
            ...[
              "task",
              "project",
              "record",
              "habit",
              "strategy",
              "decision",
              "review",
            ].map((k) => [k, kindLabel(k)] as [string, string]),
          ])}
          {select("status", "状态", [
            ["", "不限"],
            ["todo", "待办"],
            ["in_progress", "进行中"],
            ["blocked", "阻塞"],
            ["completed", "完成"],
            ["cancelled", "取消"],
          ])}
          {select("projectId", "项目", [
            ["", "不限"],
            ...live
              .filter((e) => e.kind === "project")
              .map((e) => [e.id, entityTitle(e)] as [string, string]),
          ])}
          {select("priority", "优先级", [
            ["", "不限"],
            ["1", "P1 最高"],
            ["2", "P2 高"],
            ["3", "P3 中"],
            ["0", "P4 普通"],
          ])}
          {select("due", "真实期限", [
            ["", "不限"],
            ["overdue", "已逾期"],
            ["today", "今天到期"],
            ["week", "未来七日"],
          ])}
          {select("mode", "条件关系", [
            ["and", "全部满足 AND"],
            ["or", "任一满足 OR"],
          ])}
          {select("sort", "排序", [
            ["updated", "最近修改"],
            ["due", "期限从近到远"],
            ["priority", "优先级从高到低"],
            ["title", "标题"],
          ])}
          {select("group", "分组", [
            ["kind", "按类型"],
            ["project", "按项目"],
            ["status", "按状态"],
            ["none", "不分组"],
          ])}
        </div>
        <label>
          <input
            type="checkbox"
            checked={filter.includeArchived}
            onChange={(e) => set("includeArchived", e.target.checked)}
          />
          包含归档项目
        </label>
        <label>
          视图名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button
          disabled={!name.trim()}
          onClick={() =>
            void save(
              [
                {
                  id: crypto.randomUUID(),
                  kind: "view",
                  expectedVersion: null,
                  data: { ...filter, title: name.trim() },
                },
              ],
              () => setName(""),
            )
          }
        >
          保存视图
        </button>
      </div>
      <div className="mx-actions">
        {live
          .filter((e) => e.kind === "view")
          .map((e) => (
            <span key={e.id}>
              <button
                onClick={() =>
                  setFilter({
                    ...emptyFilter,
                    ...Object.fromEntries(
                      Object.keys(emptyFilter).map((k) => [
                        k,
                        e.data[k] ?? emptyFilter[k as keyof SearchFilter],
                      ]),
                    ),
                  })
                }
              >
                {entityTitle(e)}
              </button>
              <button
                aria-label={"删除视图 " + entityTitle(e)}
                onClick={() =>
                  void save([
                    {
                      id: e.id,
                      kind: e.kind,
                      expectedVersion: e.version,
                      data: e.data,
                      deleted: true,
                    },
                  ])
                }
              >
                ×
              </button>
            </span>
          ))}
      </div>
      {filter.projectId && !live.some((e) => e.id === filter.projectId) && (
        <p role="alert">视图引用的项目已删除，请重新选择。</p>
      )}
      <p>{results.length} 条结果</p>
      {[...groups].map(([group, items]) => (
        <section key={group}>
          <h3>{group}</h3>
          {items.map((e) => (
            <article key={e.id}>
              <small>
                {kindLabel(e.kind)}{" "}
                {text(e.data.dueDate) && `· 期限 ${text(e.data.dueDate)}`}
              </small>
              <b>{entityTitle(e)}</b>
              <p className="mx-body">
                {text(e.data.body || e.data.notes).slice(0, 300)}
              </p>
            </article>
          ))}
        </section>
      ))}
    </>
  );
}
