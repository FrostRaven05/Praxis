import { feedbackMessage } from "./feedback-message";
import { cleanAiProse } from "./ai-prose";
import { useEffect, useRef, useState } from "react";
import {
  AI_MAX_TASKS,
  type AiApplyReceipt,
  type AiRun,
} from "../../api/src/ai-contract";
import { personalAgentStorage } from "./personal-agent-storage";
import { AiGatewayError } from "./ai-storage";
import {
  addPersonalAgentTask,
  draftAvailableDependencies,
  draftParentKeys,
  draftReadyLeafTasks,
  newPersonalAgentDraft,
  personalAgentApply,
  personalAgentBasis,
  personalAgentKey,
  receivePersonalAgentRun,
  restorePersonalAgentDraft,
  resolvePersonalAgentApply,
  togglePersonalAgentTask,
  type PersonalAgentDraft,
  type PersonalAgentMode,
  type PersonalAgentSnapshot,
  type PersonalAgentTask,
} from "./personal-agent-model";
import "./personal-agent.css";

export function PersonalAgentPanel({
  mode,
  projectId,
  initialInput,
  onClose,
  onApplied,
  onOpenTask,
  onOpenProject,
  onStartPomodoro,
  onScheduleToday,
  port = personalAgentStorage,
}: {
  mode: PersonalAgentMode;
  projectId?: string | undefined;
  initialInput?: string | undefined;
  onClose: () => void;
  onApplied?: (receipt: AiApplyReceipt) => void | Promise<void>;
  onOpenTask?: (id: string) => void;
  onOpenProject?: (id: string) => void;
  onStartPomodoro?: (task: { id: string; title: string }) => void;
  onScheduleToday?: (taskId: string) => void | Promise<void>;
  port?: typeof personalAgentStorage;
}) {
  const creatingProject = mode === "decompose" && !projectId;
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(false),
    key = useRef<string | null>(null),
    draftRef = useRef<PersonalAgentDraft | null>(null),
    busyRef = useRef(false),
    epoch = useRef(0),
    pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    polls = useRef(0);
  const [snapshot, setSnapshot] = useState<PersonalAgentSnapshot | null>(null),
    [draft, setDraft] = useState<PersonalAgentDraft | null>(null),
    [clarifyAnswer, setClarifyAnswer] = useState(""),
    [editingGoal, setEditingGoal] = useState(false),
    [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set()),
    [schedulingId, setSchedulingId] = useState<string | null>(null),
    [scheduledIds, setScheduledIds] = useState<Set<string>>(() => new Set()),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [enabled, setEnabled] = useState(false),
    [loading, setLoading] = useState(true),
    [stale, setStale] = useState(false);

  const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));

  function update(next: PersonalAgentDraft, critical = false) {
    if (!key.current) throw Error("尚未确定个人账号作用域");
    if (critical) localStorage.setItem(key.current, JSON.stringify(next));
    draftRef.current = next;
    if (alive.current) setDraft(next);
    if (!critical)
      try {
        localStorage.setItem(key.current, JSON.stringify(next));
      } catch {
        if (alive.current)
          setError("本地存储空间不足，暂无法保存草稿备份。");
      }
    return next;
  }

  function stopPoll() {
    epoch.current++;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }

  async function checkScope() {
    if (!draftRef.current || (await port.scope()) !== draftRef.current.scopeKey)
      throw Error("账号已切换，请重新打开后再试。");
  }

  async function acknowledge(receipt: AiApplyReceipt) {
    await checkScope();
    const current = draftRef.current!;
    const scheduledToday = Boolean(current.pending?.scheduleToday);
    update({ ...current, pending: null, receipt });
    window.dispatchEvent(new Event("praxis-lan-sync"));
    if (alive.current) {
      setNotice(
        receipt.undone
          ? "此批任务此前已撤销"
          : creatingProject
            ? scheduledToday
              ? "已创建项目与任务，并已将第一步加入今日"
              : "已创建项目与任务"
            : scheduledToday
              ? "已创建任务，并已将第一步加入今日"
              : "已创建任务",
      );
      await onApplied?.(receipt);
    }
  }

  function accept(run: AiRun) {
    const current = draftRef.current;
    if (!current) return;
    update(receivePersonalAgentRun(current, run));
    if (run.status === "ready") setEditingGoal(false);
  }

  async function poll(id: string, token: number) {
    try {
      if (++polls.current > 75)
        throw Error("生成耗时较长，请点「查询进度」或「停止」。");
      await checkScope();
      const run = await port.run(id);
      if (!alive.current || token !== epoch.current) return;
      accept(run);
      setError("");
      if (run.status === "running")
        pollTimer.current = setTimeout(() => void poll(id, token), 1200);
      else setWorking(false);
    } catch (e) {
      if (alive.current && token === epoch.current) {
        setWorking(false);
        setError(fail(e));
      }
    }
  }

  useEffect(() => {
    alive.current = true;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current?.showModal();
    void (async () => {
      try {
        const fresh = await port.read(
          projectId,
          creatingProject ? { newProject: true } : undefined,
        );
        if (!alive.current) return;
        setSnapshot(fresh);
        key.current = personalAgentKey(fresh, mode);
        const raw = localStorage.getItem(key.current),
          saved = restorePersonalAgentDraft(raw, fresh, mode);
        if (raw && !saved) {
          setError("上次保存的草稿无法读取，请点「重新开始」。");
          return;
        }
        let initial = saved ?? newPersonalAgentDraft(fresh, mode, initialInput);
        if (
          saved &&
          creatingProject &&
          initialInput?.trim() &&
          !saved.request &&
          !saved.run &&
          !saved.pending &&
          !saved.receipt
        ) {
          initial = { ...saved, input: initialInput.trim() };
        }
        update(initial);
        if (
          !creatingProject &&
          initial.request &&
          personalAgentBasis(initial.request.context) !==
            personalAgentBasis(fresh.context)
        )
          setStale(true);
        try {
          const service = await port.status();
          if (alive.current) setEnabled(service.enabled);
        } catch {
          /* 未连接时不额外提示 */
        }
      } catch (e) {
        if (alive.current) setError(fail(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
      stopPoll();
      dialog.current?.close();
      previous?.focus();
    };
  }, []);

  async function generate(overrideInput?: string) {
    if (busyRef.current || !draftRef.current || !snapshot) return;
    const current = draftRef.current;
    if (current.pending || current.receipt) return;
    busyRef.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await checkScope();
      if (mode === "decompose" && !creatingProject && !snapshot.canDecompose)
        throw Error(
          snapshot.facts.truncated
            ? "当前项目任务超过 100 项，建议拆分后再使用 AI 拆解。"
            : "请先恢复项目为进行中再拆解。",
        );
      if (projectId && !snapshot.context.project)
        throw Error("当前项目已不可见，请关闭后重新打开。");
      const unresolved =
        !overrideInput &&
        !!current.request &&
        (!current.run || current.run.status === "running");
      const fresh = unresolved
        ? snapshot
        : await port.read(
            projectId,
            creatingProject ? { newProject: true } : undefined,
          );
      if (fresh.scopeKey !== current.scopeKey)
        throw Error("账号已变化，请重新打开。");
      const nextInput = (overrideInput ?? current.input).trim();
      const request = unresolved
        ? current.request!
        : {
            id: crypto.randomUUID(),
            mode:
              mode === "next" ? ("resume" as const) : ("decompose" as const),
            input: nextInput,
            constraints:
              mode === "next"
                ? "用自然亲切的个人助理口吻推荐一个已有任务先做，不新建任务、不改日期状态。文字简洁易读，严禁出现任何任务ID、UUID或「只读约束」等系统术语。"
                : creatingProject
                  ? "用自然简洁的助理口吻新建个人项目并拆成两级任务与依赖；不配置估时或奖励，文字中不要出现任务ID或系统术语。"
                  : "用自然简洁的助理口吻拆成两级或平铺任务与依赖；不配置估时或奖励，文字中不要出现任务ID或系统术语。",
            context: fresh.context,
          };
      if (!request.input || request.input.length > 8000)
        throw Error("请先填写项目目标。");
      if (!unresolved) {
        if (key.current && current.request)
          localStorage.setItem(
            key.current + ":history:" + current.request.id,
            JSON.stringify(current),
          );
        setSnapshot(fresh);
        setStale(false);
        setExpandedIds(new Set());
        update(
          {
            ...current,
            input: overrideInput ?? current.input,
            request,
            run: null,
            tasks: [],
            firstStepTaskId: null,
          },
          true,
        );
      }
      stopPoll();
      polls.current = 0;
      const token = epoch.current;
      const run = await port.generate(request);
      if (!alive.current || token !== epoch.current) return;
      accept(run);
      if (run.status === "running")
        pollTimer.current = setTimeout(() => void poll(run.id, token), 1000);
      else setWorking(false);
    } catch (e) {
      if (alive.current) {
        if (
          e instanceof AiGatewayError &&
          ([400, 401, 403, 413, 429].includes(e.status) ||
            ["AI_DISABLED", "AI_NOT_CONFIGURED"].includes(e.code))
        )
          update({ ...draftRef.current!, request: null, run: null });
        setWorking(false);
        setError(fail(e));
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function query() {
    if (!draftRef.current?.request || busyRef.current) return;
    stopPoll();
    polls.current = 0;
    setWorking(true);
    await poll(draftRef.current.request.id, epoch.current);
  }

  async function cancel() {
    const current = draftRef.current;
    if (!current?.request || busyRef.current) return;
    busyRef.current = true;
    stopPoll();
    setWorking(true);
    setError("");
    try {
      await checkScope();
      const run = await port.cancel(current.request.id);
      if (alive.current) accept(run);
    } catch (e) {
      if (alive.current) setError("停止失败：" + fail(e));
    } finally {
      busyRef.current = false;
      if (alive.current) setWorking(false);
    }
  }

  async function apply() {
    if (busyRef.current || !draftRef.current || mode !== "decompose") return;
    busyRef.current = true;
    setWorking(true);
    setError("");
    try {
      await checkScope();
      let current = draftRef.current;
      if (!current.pending) {
        const fresh = await port.read(
          projectId,
          creatingProject ? { newProject: true } : undefined,
        );
        if (!creatingProject && !fresh.canDecompose)
          throw Error(
            fresh.facts.truncated
              ? "当前项目任务超过 100 项，请手动管理或拆分项目。"
              : "请先恢复项目为进行中再创建任务。",
          );
        if (fresh.scopeKey !== current.scopeKey)
          throw Error("账号已变化，请返回原账号。");
        if (
          !creatingProject &&
          (!current.request ||
            personalAgentBasis(current.request.context) !==
              personalAgentBasis(fresh.context))
        ) {
          setStale(true);
          throw Error("项目任务有新变动，请重新生成后再创建。");
        }
        current = update(
          { ...current, pending: personalAgentApply(current) },
          true,
        );
      }
      await acknowledge(await resolvePersonalAgentApply(current, port));
    } catch (e) {
      const msg = fail(e);
      if (alive.current) {
        if (
          [
            "AI_STALE_PROJECT",
            "AI_INVALID_COMMAND",
            "AI_INVALID_DEPENDENCIES",
            "AI_ALREADY_APPLIED",
          ].includes(msg)
        ) {
          update({ ...draftRef.current!, pending: null });
          if (msg === "AI_STALE_PROJECT") setStale(true);
        }
        setError(msg);
      }
    } finally {
      busyRef.current = false;
      if (alive.current) setWorking(false);
    }
  }

  function startAgain() {
    if (!snapshot || !draftRef.current || working || draftRef.current.pending)
      return;
    try {
      if (key.current && draftRef.current.request)
        localStorage.setItem(
          key.current + ":history:" + draftRef.current.request.id,
          JSON.stringify(draftRef.current),
        );
      update(newPersonalAgentDraft(snapshot, mode));
      setClarifyAnswer("");
      setEditingGoal(false);
      setExpandedIds(new Set());
      setStale(false);
      setNotice("");
      setError("");
    } catch (e) {
      setError(fail(e));
    }
  }

  function answerAndRegenerate() {
    const answer = clarifyAnswer.trim();
    if (!answer || !draftRef.current || working) return;
    const combined = `${draftRef.current.input.trim()}\n补充条件：${answer}`.slice(
      0,
      8000,
    );
    setClarifyAnswer("");
    void generate(combined);
  }

  async function scheduleNextTask(taskId: string) {
    if (!onScheduleToday || schedulingId || working) return;
    setSchedulingId(taskId);
    setError("");
    try {
      await onScheduleToday(taskId);
      if (alive.current) {
        setScheduledIds((prev) => new Set([...prev, taskId]));
      }
    } catch (e) {
      if (alive.current) setError(fail(e));
    } finally {
      if (alive.current) setSchedulingId(null);
    }
  }

  const unresolved =
    !!draft?.request && (!draft.run || draft.run.status === "running");
  const locked =
    loading || working || !!draft?.pending || !!draft?.receipt || unresolved;
  const source = draft?.request?.context ?? snapshot?.context;
  const run = draft?.run;
  const tasks = draft?.tasks ?? [];
  const selected = tasks.filter((t) => t.selected);
  const selectedParents = draftParentKeys(tasks, true);
  const readyLeaves = draftReadyLeafTasks(tasks);
  const chosenFirstStep =
    readyLeaves.find((t) => t.id === draft?.firstStepTaskId) ??
    readyLeaves[0] ??
    null;
  const willScheduleToday = Boolean(
    draft?.addFirstStepToToday && chosenFirstStep,
  );
  const rootTasks = tasks.filter((t) => t.parentKey === null);
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const hasDraftResult =
    mode === "decompose" && !!run?.proposal && tasks.length > 0;
  const goalChanged = Boolean(
    draft?.request && draft.input.trim() !== draft.request.input,
  );

  const patchDraft = (change: Partial<PersonalAgentDraft>) => {
    try {
      update({ ...draftRef.current!, ...change });
    } catch (e) {
      setError(fail(e));
    }
  };

  const patchTasks = (nextTasks: PersonalAgentTask[]) => {
    const nextReady = draftReadyLeafTasks(nextTasks);
    const keepFirst = nextReady.some(
      (t) => t.id === draftRef.current?.firstStepTaskId,
    );
    patchDraft({
      tasks: nextTasks,
      firstStepTaskId: keepFirst
        ? draftRef.current!.firstStepTaskId
        : (nextReady[0]?.id ?? null),
    });
  };

  const patchTask = (
    id: string,
    change: Partial<PersonalAgentDraft["tasks"][number]>,
  ) => {
    patchTasks(
      draftRef.current!.tasks.map((t) =>
        t.id === id ? { ...t, ...change } : t,
      ),
    );
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderNextTaskActions = (taskId: string, title: string) => {
    const contextTask = source?.tasks.find((t) => t.id === taskId);
    const alreadyToday =
      scheduledIds.has(taskId) ||
      (source?.date != null && contextTask?.executionDate === source.date);
    return (
      <div className="pa-next-actions">
        {onStartPomodoro && (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={working || schedulingId !== null}
            onClick={() => {
              onStartPomodoro({ id: taskId, title });
              onClose();
            }}
          >
            ▶ 番茄钟开干
          </button>
        )}
        {onScheduleToday && (
          <button
            type="button"
            className="pa-btn"
            disabled={working || schedulingId !== null || alreadyToday}
            onClick={() => void scheduleNextTask(taskId)}
          >
            {schedulingId === taskId
              ? "加入中…"
              : alreadyToday
                ? "已在今日"
                : "+ 加入今日"}
          </button>
        )}
        {onOpenTask && (
          <button
            type="button"
            className="pa-btn pa-btn-ghost"
            disabled={working || schedulingId !== null}
            onClick={() => {
              onClose();
              onOpenTask(taskId);
            }}
          >
            查看
          </button>
        )}
      </div>
    );
  };

  const renderTaskRow = (t: PersonalAgentTask, isChild: boolean) => {
    const isParent = selectedParents.has(t.key);
    const availableDeps = draftAvailableDependencies(tasks, t.id);
    const children = isChild ? [] : tasks.filter((c) => c.parentKey === t.key);
    const selectedChildCount = children.filter((c) => c.selected).length;
    const expanded = expandedIds.has(t.id);
    const hasMeta = Boolean(
      t.notes.trim() || t.deadline || t.dependsOn.length > 0,
    );

    return (
      <fieldset
        key={t.id}
        data-task-key={t.key}
        disabled={locked}
        className={[
          "pa-item",
          isChild ? "is-child" : isParent ? "is-phase" : "is-root",
          !t.selected ? "is-muted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="pa-item-main">
          <input
            type="checkbox"
            className="pa-check"
            aria-label={`选择 ${t.title || t.key}`}
            checked={t.selected}
            onChange={(e) =>
              patchTasks(
                togglePersonalAgentTask(
                  draftRef.current!.tasks,
                  t.id,
                  e.target.checked,
                ),
              )
            }
          />
          <span className="pa-step-badge">{t.key}</span>
          <input
            className="pa-title-input"
            aria-label="任务标题"
            placeholder={isChild ? "填写具体子任务…" : "填写阶段或任务名称…"}
            value={t.title}
            maxLength={300}
            onChange={(e) => patchTask(t.id, { title: e.target.value })}
          />
          <div className="pa-item-tools">
            {isParent && (
              <span className="pa-tag pa-tag-phase">
                阶段 · {selectedChildCount} 个子任务
              </span>
            )}
            {t.deadline && !expanded && (
              <span className="pa-tag">{t.deadline.slice(5)}</span>
            )}
            {!isChild && !draft?.receipt && (
              <button
                type="button"
                className="pa-icon-btn"
                title="为此项添加子任务"
                aria-label="+ 为此项添加子任务"
                disabled={locked || tasks.length >= AI_MAX_TASKS}
                onClick={() => {
                  const next = addPersonalAgentTask(
                    draftRef.current!.tasks,
                    t.key,
                  );
                  patchTasks(next);
                }}
              >
                + 子任务
              </button>
            )}
            <button
              type="button"
              className={`pa-icon-btn${expanded || hasMeta ? " is-active" : ""}`}
              aria-expanded={expanded}
              onClick={() => toggleExpand(t.id)}
            >
              {expanded ? "收起" : "详情"}
            </button>
          </div>
        </div>

        {!isParent && t.selected && t.dependsOn.length > 0 && !expanded && (
          <div className="pa-inline-deps">
            {t.dependsOn.map((depKey) => {
              const dep = byKey.get(depKey);
              return (
                <span className="pa-dep-chip" key={depKey}>
                  <span>
                    前置：{depKey}
                    {dep?.title ? ` · ${dep.title}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除前置依赖 ${depKey}`}
                    disabled={locked}
                    onClick={() =>
                      patchTask(t.id, {
                        dependsOn: t.dependsOn.filter((k) => k !== depKey),
                      })
                    }
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {expanded && (
          <div className="pa-item-detail">
            <div className="pa-detail-row">
              <textarea
                aria-label="说明（可选）"
                placeholder="补充说明或完成标准（选填）"
                value={t.notes}
                maxLength={4000}
                rows={2}
                onChange={(e) => patchTask(t.id, { notes: e.target.value })}
              />
              <input
                aria-label="截止日期（可选）"
                title="截止日期（可选）"
                type="date"
                className="pa-date-input"
                value={t.deadline ?? ""}
                onChange={(e) =>
                  patchTask(t.id, { deadline: e.target.value || null })
                }
              />
            </div>
            {!isParent && t.selected && (
              <div className="pa-detail-deps">
                {t.dependsOn.map((depKey) => {
                  const dep = byKey.get(depKey);
                  return (
                    <span className="pa-dep-chip" key={depKey}>
                      <span>
                        前置：{depKey}
                        {dep?.title ? ` · ${dep.title}` : ""}
                      </span>
                      <button
                        type="button"
                        aria-label={`移除前置依赖 ${depKey}`}
                        disabled={locked}
                        onClick={() =>
                          patchTask(t.id, {
                            dependsOn: t.dependsOn.filter((k) => k !== depKey),
                          })
                        }
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
                {availableDeps.length > 0 && (
                  <select
                    aria-label={`为 ${t.key} 添加前置依赖`}
                    className="pa-dep-select"
                    value=""
                    disabled={locked}
                    onChange={(e) => {
                      const depKey = e.target.value;
                      if (!depKey) return;
                      patchTask(t.id, {
                        dependsOn: [...t.dependsOn, depKey],
                      });
                    }}
                  >
                    <option value="">+ 添加前置依赖…</option>
                    {availableDeps.map((candidate) => (
                      <option key={candidate.key} value={candidate.key}>
                        {candidate.key} · {candidate.title || "未命名步骤"}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        )}

        {!isChild && children.length > 0 && (
          <div className="pa-subtask-tree">
            {children.map((child) => renderTaskRow(child, true))}
          </div>
        )}
      </fieldset>
    );
  };

  return (
    <dialog
      ref={dialog}
      className="personal-agent-dialog"
      aria-label="行动助手"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="pa-shell">
        <header className="pa-header">
          <div className="pa-header-title">
            <h2>
              {creatingProject
                ? "AI 拆解新建项目"
                : mode === "decompose"
                  ? "拆成步骤"
                  : "接下来做什么"}
            </h2>
            {!creatingProject && snapshot?.context.project?.name && (
              <span className="pa-project-pill">
                {snapshot.context.project.name}
              </span>
            )}
            {mode === "next" && snapshot && (
              <span className="pa-stats-pill">
                共 {snapshot.facts.taskCount} 项
                {snapshot.facts.overdue > 0
                  ? ` · ${snapshot.facts.overdue} 项逾期`
                  : ""}
              </span>
            )}
          </div>
          <button
            type="button"
            className="pa-close"
            aria-label="关闭行动助手"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="pa-body">
          {loading && (
            <p className="pa-status" role="status">
              正在读取…
            </p>
          )}
          {notice && !draft?.receipt && (
            <p className="pa-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="pa-error" role="alert">
              {feedbackMessage(error)}
            </p>
          )}

          {mode === "next" && snapshot && (
            <div className="pa-next-view">
              <section
                className="pa-next-list"
                aria-label="系统下一步建议"
              >
                {!snapshot.suggestions.length ? (
                  <p className="pa-empty">
                    目前没有可直接推进的任务，可以去新建或拆解一个目标。
                  </p>
                ) : (
                  snapshot.suggestions.map((t, index) => (
                    <article
                      className={`pa-next-card${index === 0 ? " is-top" : ""}`}
                      key={t.taskId}
                    >
                      <div className="pa-next-card-head">
                        <strong className="pa-next-title">{t.title}</strong>
                        <span className="pa-tag">{t.reason}</span>
                      </div>
                      {renderNextTaskActions(t.taskId, t.title)}
                    </article>
                  ))
                )}
              </section>

              <section className="pa-ai-pick">
                {unresolved ? (
                  <div className="pa-running-bar">
                    <span role="status">
                      {working ? "AI 正在分析下一步…" : "等待查询结果"}
                    </span>
                    <button
                      type="button"
                      className="pa-btn"
                      disabled={working}
                      onClick={() => void query()}
                    >
                      查询
                    </button>
                    <button
                      type="button"
                      className="pa-btn pa-btn-ghost"
                      disabled={busyRef.current}
                      onClick={() => void cancel()}
                    >
                      停止
                    </button>
                  </div>
                ) : run?.proposal ? (
                  <div
                    className="pa-ai-pick-card"
                    aria-label="AI生成内容"
                  >
                    <div className="pa-ai-pick-head">
                      <span>✦ AI 推荐先做</span>
                      <button
                        type="button"
                        className="pa-icon-btn"
                        disabled={working || !enabled}
                        onClick={startAgain}
                      >
                        换个建议
                      </button>
                    </div>
                    {stale && (
                      <p className="pa-warn" role="alert">
                        任务已更新，可点「换个建议」重新读取。
                      </p>
                    )}
                    {(() => {
                      const pickedTask = run.proposal.suggestedTaskId
                        ? source?.tasks.find(
                            (t) => t.id === run.proposal?.suggestedTaskId,
                          )
                        : null;
                      const summaryText = cleanAiProse(run.proposal.summary);
                      const nextActionText = cleanAiProse(
                        run.proposal.nextAction,
                      );
                      return (
                        <>
                          {pickedTask && (
                            <h3 className="pa-ai-pick-task">
                              {pickedTask.title}
                            </h3>
                          )}
                          {summaryText && (
                            <p className="pa-ai-pick-summary">{summaryText}</p>
                          )}
                          {nextActionText &&
                            nextActionText !== pickedTask?.title && (
                              <p className="pa-ai-pick-action">
                                <span>下一步</span>
                                {nextActionText}
                              </p>
                            )}
                          {run.proposal.suggestedTaskId &&
                            renderNextTaskActions(
                              run.proposal.suggestedTaskId,
                              pickedTask?.title ?? nextActionText,
                            )}
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="pa-ai-pick-trigger">
                    <button
                      type="button"
                      className="pa-btn"
                      disabled={!enabled || working || stale}
                      onClick={() => void generate()}
                    >
                      ✦ 让 AI 挑一个最值得先做的
                    </button>
                    {!enabled && !loading && (
                      <span className="pa-muted-hint">未配置 AI 模型</span>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {mode === "decompose" && draft && (
            <div className="pa-decompose-view">
              {hasDraftResult && !editingGoal && !draft.receipt ? (
                <div className="pa-goal-bar">
                  <span className="pa-goal-preview" title={draft.input}>
                    {draft.input}
                  </span>
                  <button
                    type="button"
                    className="pa-icon-btn"
                    disabled={locked}
                    onClick={() => setEditingGoal(true)}
                  >
                    修改目标
                  </button>
                </div>
              ) : (
                !draft.receipt && (
                  <div className="pa-goal-editor">
                    <textarea
                      aria-label="项目目标"
                      placeholder={
                        creatingProject
                          ? "写下你想完成的项目目标，例如：下个月前上线个人作品集网站…"
                          : "写下这一阶段想推进的目标，AI 会自动拆成清晰步骤…"
                      }
                      rows={3}
                      maxLength={8000}
                      value={draft.input}
                      disabled={locked}
                      onChange={(e) => patchDraft({ input: e.target.value })}
                      onKeyDown={(e) => {
                        if (
                          (e.ctrlKey || e.metaKey) &&
                          e.key === "Enter" &&
                          enabled &&
                          !locked &&
                          draft.input.trim()
                        ) {
                          e.preventDefault();
                          void generate();
                        }
                      }}
                    />
                    <div className="pa-goal-actions">
                      {unresolved ? (
                        <>
                          <span className="pa-muted-hint" role="status">
                            {working ? "正在拆解中…" : "结果待确认"}
                          </span>
                          <button
                            type="button"
                            className="pa-btn"
                            disabled={working}
                            onClick={() => void query()}
                          >
                            查询进度
                          </button>
                          <button
                            type="button"
                            className="pa-btn pa-btn-ghost"
                            disabled={busyRef.current}
                            onClick={() => void cancel()}
                          >
                            停止
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="pa-btn pa-btn-primary"
                            disabled={
                              !enabled ||
                              working ||
                              !!draft.pending ||
                              !!draft.receipt ||
                              (stale && !goalChanged) ||
                              (!creatingProject && !snapshot?.canDecompose) ||
                              !draft.input.trim()
                            }
                            onClick={() => void generate()}
                          >
                            {creatingProject
                              ? "生成项目与任务草稿"
                              : "生成任务草稿"}
                          </button>
                          {editingGoal && hasDraftResult && (
                            <button
                              type="button"
                              className="pa-btn pa-btn-ghost"
                              disabled={working}
                              onClick={() => setEditingGoal(false)}
                            >
                              取消
                            </button>
                          )}
                          {!enabled && !loading && (
                            <span className="pa-muted-hint">
                              请先在设置中配置 AI 模型
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              )}

              {!creatingProject && snapshot && !snapshot.canDecompose && (
                <p className="pa-warn" role="status">
                  {snapshot.facts.truncated
                    ? "当前项目任务超过 100 项，请手动管理或拆分成子项目。"
                    : "项目当前未处于进行中状态，暂不可拆解。"}
                </p>
              )}

              {run?.status === "failed" && (
                <p className="pa-error" role="alert">
                  {run.error?.message ?? "生成失败，请重试。"}
                </p>
              )}
              {run?.status === "cancelled" && (
                <p className="pa-muted-hint" role="status">
                  已停止生成
                </p>
              )}

              {run?.proposal?.question && !draft.receipt && (
                <div className="pa-clarify-card" role="status">
                  <p className="pa-clarify-q">
                    {cleanAiProse(run.proposal.question)}
                  </p>
                  <div className="pa-clarify-row">
                    <input
                      aria-label="补充回答"
                      placeholder="简单回答一句即可继续拆解…"
                      value={clarifyAnswer}
                      disabled={working}
                      onChange={(e) => setClarifyAnswer(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          answerAndRegenerate();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="pa-btn pa-btn-primary"
                      disabled={working || !enabled || !clarifyAnswer.trim()}
                      onClick={answerAndRegenerate}
                    >
                      补充并重新生成
                    </button>
                  </div>
                </div>
              )}

              {run?.proposal && tasks.length > 0 && (
                <section className="pa-draft" aria-label="AI生成内容">
                  {creatingProject && (
                    <div className="pa-project-hero">
                      <input
                        className="pa-project-name"
                        aria-label="项目名称"
                        placeholder="项目名称"
                        required
                        maxLength={120}
                        disabled={locked}
                        value={draft.projectName}
                        onChange={(e) =>
                          patchDraft({ projectName: e.target.value })
                        }
                      />
                      <input
                        className="pa-project-outcome"
                        aria-label="预期成果（可选）"
                        placeholder="预期成果（可选）"
                        maxLength={2000}
                        disabled={locked}
                        value={draft.projectOutcome}
                        onChange={(e) =>
                          patchDraft({ projectOutcome: e.target.value })
                        }
                      />
                    </div>
                  )}

                  {run.proposal.summary && !draft.receipt && (
                    <p className="pa-summary">{run.proposal.summary}</p>
                  )}

                  {run.proposal.suggestedTaskId && (
                    <div className="pa-reuse-bar">
                      <span>已有相似任务可直接推进：</span>
                      <button
                        type="button"
                        className="pa-icon-btn is-active"
                        onClick={() => {
                          onClose();
                          onOpenTask?.(run.proposal!.suggestedTaskId!);
                        }}
                      >
                        {source?.tasks.find(
                          (t) => t.id === run.proposal?.suggestedTaskId,
                        )?.title ?? "查看任务"}
                      </button>
                    </div>
                  )}

                  {stale && (
                    <p className="pa-warn" role="alert">
                      {draft.pending
                        ? "数据有更新，请点下方按钮核对原创建结果。"
                        : "项目任务有变动，请重新生成后再创建。"}
                    </p>
                  )}

                  <div className="pa-tree">
                    {rootTasks.map((t) => renderTaskRow(t, false))}
                  </div>

                  {!draft.receipt && (
                    <button
                      type="button"
                      className="pa-add-root"
                      disabled={locked || tasks.length >= AI_MAX_TASKS}
                      onClick={() =>
                        patchTasks(
                          addPersonalAgentTask(draftRef.current!.tasks, null),
                        )
                      }
                    >
                      + 添加步骤
                    </button>
                  )}
                </section>
              )}
            </div>
          )}
        </div>

        {mode === "decompose" && draft && (hasDraftResult || draft.receipt) && (
          <footer className="pa-footer">
            {draft.receipt ? (
              <div className="pa-receipt-bar">
                <span className="pa-receipt-ok" role="status">
                  ✓ {notice || `已创建 ${draft.receipt.taskIds.length} 项任务`}
                </span>
                <div className="pa-footer-btns">
                  <button
                    type="button"
                    className="pa-btn pa-btn-ghost"
                    disabled={working}
                    onClick={startAgain}
                  >
                    继续拆新目标
                  </button>
                  {creatingProject && draft.receipt.projectId && onOpenProject ? (
                    <button
                      type="button"
                      className="pa-btn pa-btn-primary"
                      onClick={() => onOpenProject(draft.receipt!.projectId!)}
                    >
                      打开新项目
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pa-btn pa-btn-primary"
                      onClick={onClose}
                    >
                      完成
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {readyLeaves.length > 0 && (
                  <div className="pa-today-row">
                    <label className="pa-today-toggle">
                      <input
                        type="checkbox"
                        checked={draft.addFirstStepToToday}
                        disabled={locked}
                        onChange={(e) =>
                          patchDraft({
                            addFirstStepToToday: e.target.checked,
                            firstStepTaskId:
                              draft.firstStepTaskId ?? readyLeaves[0]?.id ?? null,
                          })
                        }
                      />
                      <span>把第一步加入今日安排</span>
                    </label>
                    {draft.addFirstStepToToday &&
                      (readyLeaves.length === 1 ? (
                        <span className="pa-today-chip">
                          将安排：{chosenFirstStep?.key} ·{" "}
                          {chosenFirstStep?.title || "未命名步骤"}
                        </span>
                      ) : (
                        <select
                          aria-label="加入今日的第一步"
                          className="pa-today-select"
                          value={chosenFirstStep?.id ?? ""}
                          disabled={locked}
                          onChange={(e) =>
                            patchDraft({ firstStepTaskId: e.target.value })
                          }
                        >
                          {readyLeaves.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.key} · {item.title || "未命名步骤"}
                            </option>
                          ))}
                        </select>
                      ))}
                  </div>
                )}
                <div className="pa-footer-actions">
                  <button
                    type="button"
                    className="pa-btn pa-btn-ghost"
                    disabled={working || !!draft.pending}
                    onClick={startAgain}
                  >
                    重新开始
                  </button>
                  <button
                    type="button"
                    className="pa-btn pa-btn-primary"
                    disabled={
                      working ||
                      (stale && !draft.pending) ||
                      !port.canApply ||
                      (!selected.length && !draft.pending) ||
                      (creatingProject &&
                        !draft.projectName.trim() &&
                        !draft.pending) ||
                      run?.status !== "ready"
                    }
                    onClick={() => void apply()}
                  >
                    {draft.pending
                      ? "核对并重试创建"
                      : creatingProject
                        ? `确认创建项目与 ${selected.length} 项任务${willScheduleToday ? "（含第一步加入今日）" : ""}`
                        : `确认创建 ${selected.length} 项任务${willScheduleToday ? "（含第一步加入今日）" : ""}`}
                  </button>
                </div>
              </>
            )}
          </footer>
        )}
      </div>
    </dialog>
  );
}
