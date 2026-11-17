import { feedbackMessage } from "./feedback-message";
import { useEffect, useRef, useState } from "react";
import type { AiApplyReceipt, AiRun } from "../../api/src/ai-contract";
import { personalAgentStorage } from "./personal-agent-storage";
import { AiGatewayError } from "./ai-storage";
import {
  newPersonalAgentDraft,
  personalAgentApply,
  personalAgentBasis,
  personalAgentKey,
  receivePersonalAgentRun,
  restorePersonalAgentDraft,
  resolvePersonalAgentApply,
  type PersonalAgentDraft,
  type PersonalAgentMode,
  type PersonalAgentSnapshot,
} from "./personal-agent-model";
import "./personal-agent.css";

export function PersonalAgentPanel({
  mode,
  projectId,
  onClose,
  onApplied,
  onOpenTask,
  port = personalAgentStorage,
}: {
  mode: PersonalAgentMode;
  projectId?: string;
  onClose: () => void;
  onApplied?: (receipt: AiApplyReceipt) => void | Promise<void>;
  onOpenTask?: (id: string) => void;
  port?: typeof personalAgentStorage;
}) {
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
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [enabled, setEnabled] = useState(false),
    [loading, setLoading] = useState(true),
    [stale, setStale] = useState(false);
  const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));
  function update(next: PersonalAgentDraft, critical = false) {
    if (!key.current) throw Error("尚未确定个人账号作用域");
    // Persist before remote or business mutations. Storage failure leaves the visible draft intact.
    if (critical) localStorage.setItem(key.current, JSON.stringify(next));
    draftRef.current = next;
    if (alive.current) setDraft(next);
    if (!critical)
      try {
        localStorage.setItem(key.current, JSON.stringify(next));
      } catch {
        if (alive.current)
          setError(
            "无法保存设备恢复记录，输入仍保留在面板。请检查存储空间后再生成或采用。",
          );
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
      throw Error(
        "账号或工作空间已变化，请返回原作用域后查询；原草稿和回执标识已保留。",
      );
  }
  async function acknowledge(receipt: AiApplyReceipt) {
    await checkScope();
    const current = draftRef.current!;
    update({ ...current, pending: null, receipt });
    window.dispatchEvent(new Event("praxis-lan-sync"));
    if (alive.current) {
      setNotice(
        receipt.undone
          ? "此批任务此前已撤销，保留原回执。"
          : "已创建任务，正式任务按原方式同步。",
      );
      await onApplied?.(receipt);
    }
  }
  function accept(run: AiRun) {
    const current = draftRef.current;
    if (!current) return;
    update(receivePersonalAgentRun(current, run));
  }
  async function poll(id: string, token: number) {
    try {
      if (++polls.current > 75)
        throw Error(
          "生成结果仍未确认，请主动查询或停止；手动任务管理不受影响。",
        );
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
        const fresh = await port.read(projectId);
        if (!alive.current) return;
        setSnapshot(fresh);
        key.current = personalAgentKey(fresh, mode);
        const raw = localStorage.getItem(key.current),
          saved = restorePersonalAgentDraft(raw, fresh, mode);
        if (raw && !saved) {
          setError(
            "保存的个人草稿格式无法读取，原记录未覆盖。请使用原高级助手或保留副本后重新开始。",
          );
          return;
        }
        const initial = saved ?? newPersonalAgentDraft(fresh, mode);
        update(initial);
        if (saved)
          setNotice(
            "已恢复此账号、设备和项目的草稿；生成与采用结果可继续核对。",
          );
        if (
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
  async function generate() {
    if (busyRef.current || !draftRef.current || !snapshot) return;
    const current = draftRef.current;
    if (current.pending || current.receipt) return;
    busyRef.current = true;
    setWorking(true);
    setError("");
    try {
      await checkScope();
      if (mode === "decompose" && !projectId)
        throw Error("请先创建一个项目，再把目标拆成任务。");
      if (mode === "decompose" && !snapshot.canDecompose)
        throw Error(
          snapshot.facts.truncated
            ? "当前项目超过100项安全读取边界，请手动管理或拆分项目。原草稿及回执仍可核对。"
            : "请先恢复项目为进行中；原草稿和采用回执仍可核对。",
        );
      if (projectId && !snapshot.context.project)
        throw Error("原项目暂不可见，仍可先核对之前采用的回执。");
      const unresolved =
        current.request && (!current.run || current.run.status === "running");
      const fresh = unresolved ? snapshot : await port.read(projectId);
      if (fresh.scopeKey !== current.scopeKey)
        throw Error("个人账号已变化，请重新打开行动助手。");
      const request = unresolved
        ? current.request!
        : {
            id: crypto.randomUUID(),
            mode:
              mode === "next" ? ("resume" as const) : ("decompose" as const),
            input: current.input.trim(),
            constraints:
              mode === "next"
                ? "只读解释一个已有行动，不新建任务，不改日期和状态。"
                : "给出3至7项平铺任务；不配置估时、依赖或奖励。",
            context: fresh.context,
          };
      if (!request.input || request.input.length > 8000)
        throw Error("请输入1至8000字的目标。");
      if (!unresolved) {
        if (key.current && current.request)
          localStorage.setItem(
            key.current + ":history:" + current.request.id,
            JSON.stringify(current),
          );
        setSnapshot(fresh);
        setStale(false);
        update({ ...current, request, run: null, tasks: [] }, true);
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
      if (alive.current) setError("停止结果尚未确认，请查询原生成：" + fail(e));
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
        const fresh = await port.read(projectId);
        if (!fresh.canDecompose)
          throw Error(
            fresh.facts.truncated
              ? "当前项目超过100项安全采用边界，请手动管理或拆分项目；原草稿保留。"
              : "请先恢复项目为进行中，再采用新任务。",
          );
        if (fresh.scopeKey !== current.scopeKey)
          throw Error("账号已变化，请返回原作用域。");
        if (
          !current.request ||
          personalAgentBasis(current.request.context) !==
            personalAgentBasis(fresh.context)
        ) {
          setStale(true);
          throw Error(
            "项目或任务已更新，草稿仍保留，请重新读取后生成，避免覆盖新进展。",
          );
        }
        current = update(
          { ...current, pending: personalAgentApply(current) },
          true,
        );
      }
      await acknowledge(await resolvePersonalAgentApply(current, port));
    } catch (e) {
      const message = fail(e);
      if (alive.current) {
        if (
          [
            "AI_STALE_PROJECT",
            "AI_INVALID_COMMAND",
            "AI_INVALID_DEPENDENCIES",
            "AI_ALREADY_APPLIED",
          ].includes(message)
        ) {
          // A definite rejection may release this attempt; an account failure never does.
          update({ ...draftRef.current!, pending: null });
          if (message === "AI_STALE_PROJECT") setStale(true);
        }
        setError(
          message +
            (draftRef.current?.pending
              ? "。采用结果未确认，请核对并重试同一次采用。"
              : "。输入和草稿已保留。"),
        );
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
      setStale(false);
      setNotice("已保留上一轮记录，开始新的草稿。");
      setError("");
    } catch (e) {
      setError(fail(e));
    }
  }
  const unresolved =
    !!draft?.request && (!draft.run || draft.run.status === "running");
  const locked =
    loading || working || !!draft?.pending || !!draft?.receipt || unresolved;
  const source = draft?.request?.context ?? snapshot?.context;
  const run = draft?.run;
  const selected = draft?.tasks.filter((t) => t.selected) ?? [];
  const patch = (
    id: string,
    change: Partial<PersonalAgentDraft["tasks"][number]>,
  ) => {
    try {
      update({
        ...draftRef.current!,
        tasks: draftRef.current!.tasks.map((t) =>
          t.id === id ? { ...t, ...change } : t,
        ),
      });
    } catch (e) {
      setError(fail(e));
    }
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
      <header>
        <div>
          <small>下一步建议</small>
          <h2>{mode === "decompose" ? "把目标拆成任务" : "接下来修什么"}</h2>
        </div>
        <button
          className="personal-agent-close"
          aria-label="关闭行动助手"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {loading && <p role="status">正在读取当前账号的任务…</p>}
      {snapshot && (
        <section className="personal-agent-facts" aria-label="任务事实">
          <ul>
            <li>
              <b>{snapshot.facts.taskCount}</b>任务
            </li>
            <li>
              <b>{snapshot.facts.completed}</b>已完成
            </li>
            <li data-alert={snapshot.facts.overdue > 0 || undefined}>
              <b>{snapshot.facts.overdue}</b>逾期
            </li>
            {snapshot.facts.progress !== null && (
              <li>
                <b>{snapshot.facts.progress}%</b>进度
              </li>
            )}
          </ul>
          {snapshot.facts.truncated && (
            <p>
              任务建议只使用本次前100项任务；上方统计仍覆盖当前范围全部任务。可进入具体项目缩小范围。
            </p>
          )}
        </section>
      )}
      {mode === "next" && snapshot && (
        <section
          className="personal-agent-suggestions"
          aria-label="系统下一步建议"
        >
          <h3>建议先做</h3>
          {!snapshot.suggestions.length && (
            <p>
              当前没有可直接推进的任务，可检查阻塞与未来安排，或手动添加下一步。
            </p>
          )}
          <ol>
            {snapshot.suggestions.map((t) => (
              <li key={t.taskId}>
                <button
                  disabled={working}
                  onClick={() => {
                    onClose();
                    onOpenTask?.(t.taskId);
                  }}
                >
                  {t.title}
                </button>
                <p>{t.reason}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {draft && mode === "decompose" && (
        <label className="personal-agent-input">
          项目目标
          <textarea
            aria-label="项目目标"
            rows={3}
            maxLength={8000}
            value={draft.input}
            disabled={locked}
            onChange={(e) => {
              try {
                update({ ...draftRef.current!, input: e.target.value });
              } catch (e) {
                setError(fail(e));
              }
            }}
          />
        </label>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="personal-agent-error" role="alert">
          {feedbackMessage(error)}
        </p>
      )}
      {mode === "decompose" && snapshot && !snapshot.canDecompose && (
        <p role="status">
          {snapshot.facts.truncated
            ? "该项目超过本版AI的100项安全读取和采用边界。请手动添加任务或拆分项目；原任务、草稿和采用回执均保留。"
            : "该项目当前不可新增AI任务，可先恢复项目或核对历史采用回执。"}
        </p>
      )}
      {draft && (
        <div className="personal-agent-controls">
          {unresolved ? (
            <>
              <span role="status">
                {working ? "正在生成或查询…" : "生成结果待确认"}
              </span>
              <button disabled={working} onClick={() => void query()}>
                查询原生成
              </button>
              <button
                disabled={working || !enabled}
                onClick={() => void generate()}
              >
                重试原生成请求
              </button>
              <button disabled={busyRef.current} onClick={() => void cancel()}>
                停止生成
              </button>
            </>
          ) : (
            <button
              disabled={
                !enabled ||
                working ||
                !!draft.pending ||
                !!draft.receipt ||
                stale ||
                (mode === "decompose" && !snapshot?.canDecompose) ||
                !draft.input.trim()
              }
              onClick={() => void generate()}
            >
              {mode === "next" ? "请 AI 解释下一步" : "生成任务草稿"}
            </button>
          )}
          {run && (
            <small>
              生成状态：{run.status} {run.model ? `· ${run.model}` : ""}
            </small>
          )}
        </div>
      )}
      {run?.status === "failed" && (
        <p role="alert">
          {run.error?.message ?? "本次生成失败，原输入和标识保留。"}
        </p>
      )}
      {run?.status === "cancelled" && (
        <p role="status">已停止生成，未修改任务。</p>
      )}
      {run?.proposal && (
        <section aria-label="AI生成内容">
          <h3>{mode === "next" ? "AI 解释" : "待确认任务草稿"}</h3>
          <p>{run.proposal.summary}</p>
          {run.proposal.question && <p>需要补充：{run.proposal.question}</p>}
          {mode === "decompose" && run.proposal.suggestedTaskId && (
            <p>
              已有行动可复用：
              <button
                onClick={() => {
                  onClose();
                  onOpenTask?.(run.proposal!.suggestedTaskId!);
                }}
              >
                {source?.tasks.find(
                  (t) => t.id === run.proposal?.suggestedTaskId,
                )?.title ?? "原任务"}
              </button>
              ，无需重复创建。
            </p>
          )}
          {mode === "next" && (
            <>
              {stale && (
                <p role="alert">
                  这份 AI
                  解释基于较早的任务快照，不代表当前最新状态。可开始新一轮重新读取。
                </p>
              )}
              <p>{run.proposal.nextAction}</p>
              {run.proposal.suggestedTaskId && (
                <small>
                  引用现有任务：
                  {source?.tasks.find(
                    (t) => t.id === run.proposal?.suggestedTaskId,
                  )?.title ?? "任务已变化"}{" "}
                  · {run.proposal.suggestedTaskId}
                </small>
              )}
              <p>此处只读，没有采用或修改任务操作。</p>
            </>
          )}
          {mode === "decompose" && draft && (
            <>
              <p>尚未确认时不会出现在任务或进度中。</p>
              {draft.tasks.map((t) => (
                <fieldset key={t.id} disabled={locked}>
                  <label className="personal-agent-select">
                    <input
                      type="checkbox"
                      checked={t.selected}
                      onChange={(e) =>
                        patch(t.id, { selected: e.target.checked })
                      }
                    />
                    保留此项
                  </label>
                  <label>
                    任务标题
                    <input
                      aria-label="任务标题"
                      value={t.title}
                      maxLength={300}
                      onChange={(e) => patch(t.id, { title: e.target.value })}
                    />
                  </label>
                  <label>
                    说明（可选）
                    <textarea
                      aria-label="说明（可选）"
                      value={t.notes}
                      maxLength={4000}
                      rows={2}
                      onChange={(e) => patch(t.id, { notes: e.target.value })}
                    />
                  </label>
                  <label>
                    截止日期（可选）
                    <input
                      aria-label="截止日期（可选）"
                      type="date"
                      value={t.deadline ?? ""}
                      onChange={(e) =>
                        patch(t.id, { deadline: e.target.value || null })
                      }
                    />
                  </label>
                </fieldset>
              ))}
              {stale && (
                <p role="alert">
                  {draft.pending
                    ? "当前资料已变化，请先核对原采用回执，不会重新生成或重复创建。"
                    : "当前任务已更新；草稿保留，需要重新生成后再采用。"}
                </p>
              )}
              {draft.receipt ? (
                <p role="status">
                  {draft.receipt.undone ? "已撤销的历史采用" : "已经采用"} ·{" "}
                  {draft.receipt.taskIds.length} 项任务 · 回执{" "}
                  {draft.receipt.operationId}
                </p>
              ) : (
                <button
                  disabled={
                    working ||
                    (stale && !draft.pending) ||
                    !port.canApply ||
                    (!selected.length && !draft.pending) ||
                    run.status !== "ready"
                  }
                  onClick={() => void apply()}
                >
                  {draft.pending
                    ? "核对并重试同一次采用"
                    : `确认创建 ${selected.length} 项任务`}
                </button>
              )}
            </>
          )}
        </section>
      )}
      {draft && !unresolved && run && !draft.pending && (
        <button disabled={working} onClick={startAgain}>
          开始新一轮（保留历史）
        </button>
      )}
    </dialog>
  );
}
