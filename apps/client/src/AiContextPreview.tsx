import type { AiGenerateRequest } from "../../api/src/ai-contract";

export function AiContextPreview({
  context,
}: {
  context: AiGenerateRequest["context"];
}) {
  if (!context.project) return null;
  const recovery = context.recovery;
  const recoveryRows = recovery
    ? [
        ["完成标准", recovery.definitionOfDone],
        ["当前阻塞", recovery.blockerText],
        ["上次上下文", recovery.lastContext],
        ["重启提示", recovery.restartHint],
        ["等待说明", recovery.waitingNote],
        ["回看日期", recovery.reviewDate ?? ""],
        [
          "下一步",
          recovery.nextActionCleared
            ? "已明确清空下一步"
            : (context.tasks.find(
                (task) => task.id === recovery.nextActionTaskId,
              )?.title ?? ""),
        ],
      ].filter(([, content]) => content)
    : [];
  return (
    <details className="ai-context-preview">
      <summary>
        本次使用资料 · {context.tasks.length} 项任务 ·{" "}
        {context.recentRecords?.length ?? 0} 条记录
      </summary>
      <div className="ai-context-content">
        <p className="ai-context-date">
          资料日期：{context.date} · {context.timeZone}
        </p>
        <strong>{context.project.name}</strong>
        {context.project.outcome && <p>项目成果：{context.project.outcome}</p>}
        {context.truncated && (
          <p className="ai-context-truncated">
            部分资料已摘录，记录最多取最近 5 条；下方展示的是实际发送内容。
          </p>
        )}
        <section>
          <h3>项目恢复卡</h3>
          {recovery ? (
            <>
              <small>
                更新于 {new Date(recovery.updatedAt).toLocaleString()}
              </small>
              {recoveryRows.length ? (
                <dl>
                  {recoveryRows.map(([label, content]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{content}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>恢复卡暂无填写内容。</p>
              )}
            </>
          ) : (
            <p>
              {context.recovery === undefined
                ? "这份旧草稿未读取恢复卡，重新生成可使用当前项目资料。"
                : "此项目尚未保存恢复卡。"}
            </p>
          )}
        </section>
        <section>
          <h3>近期项目专属记录</h3>
          {context.recentRecords?.length ? (
            context.recentRecords.map((record) => (
              <article className="ai-context-record" key={record.id}>
                <strong>{record.title || "未命名记录"}</strong>
                <small>
                  {(
                    {
                      progress: "推进",
                      decision: "决定",
                      evidence: "依据",
                      note: "笔记",
                      review: "回顾",
                      idea: "想法",
                      question: "问题",
                      strategy: "策略",
                    } as Record<string, string>
                  )[record.recordType] ?? "记录"}{" "}
                  · {new Date(record.updatedAt).toLocaleString()}
                  {record.truncated ? " · 摘录" : ""}
                </small>
                <p>{record.bodyExcerpt || "记录正文为空。"}</p>
              </article>
            ))
          ) : (
            <p>没有本次可用的项目专属记录。</p>
          )}
        </section>
        <details className="ai-context-tasks">
          <summary>项目任务 · {context.tasks.length} 项</summary>
          <ul>
            {context.tasks.map((task) => (
              <li key={task.id}>
                <strong>{task.title}</strong>
                <small>
                  状态：
                  {(
                    {
                      todo: "待办",
                      in_progress: "进行中",
                      blocked: "阻塞",
                      waiting: "等待",
                      completed: "已完成",
                      cancelled: "已取消",
                    } as Record<string, string>
                  )[task.status] ?? task.status}{" "}
                  ·{" "}
                  {task.estimatedMinutes == null
                    ? "未估时"
                    : task.estimatedMinutes + " 分钟"}
                  {task.plannedStart ? " · 计划开始 " + task.plannedStart : ""}
                  {task.plannedEnd ? " · 计划结束 " + task.plannedEnd : ""}
                  {task.executionDate ? " · 执行日 " + task.executionDate : ""}
                </small>
                {task.completionCriteria && (
                  <p>完成标准：{task.completionCriteria}</p>
                )}
                {task.statusReason && <p>状态说明：{task.statusReason}</p>}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}
