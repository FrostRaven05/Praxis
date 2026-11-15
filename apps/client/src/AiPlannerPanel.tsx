import { AiContextPreview } from "./AiContextPreview";
import { useEffect, useRef, useState } from "react";
import type {
  AiApplyReceipt,
  AiGenerateRequest,
  AiRun,
} from "../../api/src/ai-contract";
import { accountStorage } from "./account-storage";
import { aiStorage, AiGatewayError } from "./ai-storage";
import {
  buildAiApplyCommand,
  plannerGenerateRequest,
  aiProposalSources,
  contextHasChanged,
  newPlannerDraft,
  plannerStorageKey,
  receiveAiRun,
  restorePlannerDraft,
  selectAiStep,
  type AiPlannerDraft,
  type AiPlannerLaunch,
  type EditableAiTask,
} from "./ai-planner-model";
import "./ai-planner.css";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const rejectionMessages: Record<string, string> = {
  AI_STALE_SOURCE: "原文已更新，请关闭后重新打开这条原文，再生成建议。",
  AI_STALE_PROJECT:
    "项目、任务或恢复资料已更新。请关闭后重新打开项目，再生成建议，避免覆盖新进展。",
  AI_INVALID_COMMAND:
    "所选内容未通过检查，请检查标题、完成标准与时长后再采用。",
  AI_INVALID_DEPENDENCIES:
    "步骤依赖未通过检查。请一并选择前置步骤，并将它们归入项目。",
  AI_ALREADY_APPLIED: "这份建议已被采用，请返回项目查看任务。",
  AI_OPERATION_CHANGED:
    "本次保存内容与恢复记录不一致，已停止写入。请重新打开面板核对。",
};
export function AiPlannerPanel({
  launch,
  onClose,
  onApplied,
}: {
  launch: AiPlannerLaunch;
  onClose: () => void;
  onApplied?: (receipt: AiApplyReceipt, input: string) => void | Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const scopeKey = useRef<string | null>(null);
  const initialLaunch = useRef(launch);
  const draftRef = useRef<AiPlannerDraft>(newPlannerDraft(launch));
  const [draft, setDraft] = useState(draftRef.current);
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [service, setService] = useState<{
    enabled: boolean;
    model: string | null;
  } | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [working, setWorking] = useState(false);
  const [undoBlocked, setUndoBlocked] = useState(false);
  const [staleDetected, setStaleDetected] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const actionBusy = useRef(false);
  const persist = (next: AiPlannerDraft) => {
    if (!scopeKey.current) return false;
    try {
      localStorage.setItem(scopeKey.current, JSON.stringify(next));
      if (mounted.current) setStorageWarning("");
      return true;
    } catch {
      if (mounted.current)
        setStorageWarning(
          "当前设备无法保存恢复记录，请检查存储空间。输入仍保留在面板中。",
        );
      return false;
    }
  };
  const update = (change: (current: AiPlannerDraft) => AiPlannerDraft) => {
    const next = change(draftRef.current);
    draftRef.current = next;
    persist(next);
    if (mounted.current) setDraft(next);
    return next;
  };
  const stopPolling = () => {
    generation.current++;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };
  const acceptRun = (run: AiRun) =>
    update((current) => receiveAiRun(current, run));
  async function poll(id: string, epoch: number) {
    try {
      const run = await aiStorage.run(id);
      if (!mounted.current || generation.current !== epoch) return;
      acceptRun(run);
      setError("");
      if (run.status === "running") {
        pollTimer.current = setTimeout(() => void poll(id, epoch), 1200);
      } else {
        setWorking(false);
      }
    } catch (e) {
      if (!mounted.current || generation.current !== epoch) return;
      setWorking(false);
      setError(message(e));
    }
  }
  function followRun(run: AiRun) {
    stopPolling();
    acceptRun(run);
    if (run.status === "running") {
      setWorking(true);
      pollTimer.current = setTimeout(
        () => void poll(run.id, generation.current),
        1000,
      );
    } else setWorking(false);
  }
  async function checkService() {
    setServiceError("");
    try {
      const result = await aiStorage.status();
      if (mounted.current) setService(result);
    } catch (e) {
      if (mounted.current) setServiceError(message(e));
    }
  }
  async function applied(receipt: AiApplyReceipt) {
    update((current) => ({
      ...current,
      pendingApply: null,
      receipt,
      undoOperationId: null,
    }));
    if (mounted.current) {
      setNotice(
        receipt.undone
          ? "已撤销本次采用，原文已保留。"
          : "所选步骤已保存。你可以回到项目或收件箱继续安排。",
      );
      setError("");
    }
    window.dispatchEvent(new Event("praxis-lan-sync"));
    try {
      await onApplied?.(
        receipt,
        draftRef.current.request?.input ?? draftRef.current.input,
      );
    } catch {
      if (mounted.current)
        setNotice("任务已保存，但页面刷新暂未完成。关闭面板后可重新打开查看。");
    }
  }
  async function reconcile() {
    const command = draftRef.current.pendingApply;
    if (!command || !aiStorage.canApply || actionBusy.current) return;
    actionBusy.current = true;
    setWorking(true);
    setError("");
    try {
      const receipt = await aiStorage.receipt(command.operationId);
      if (receipt) await applied(receipt);
      else if (mounted.current)
        setError(
          "尚未找到保存回执。请重试同一批采用；恢复记录与任务编号已保留。",
        );
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      actionBusy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element?.showModal();
    async function initialize() {
      try {
        const account = await accountStorage.status();
        if (!mounted.current) return;
        setSignedIn(!!account.user);
        if (!account.user) {
          setServiceError("请先在设置中登录账号，再使用规划助手。");
          setLoaded(true);
          return;
        }
        scopeKey.current = plannerStorageKey(
          account.user.id,
          account.baseUrl,
          initialLaunch.current,
        );
        const saved = restorePlannerDraft(
          localStorage.getItem(scopeKey.current),
        );
        if (saved) {
          draftRef.current = saved;
          setDraft(saved);
          setNotice("已恢复这个账号在当前设备上的输入与草稿。");
        } else persist(draftRef.current);
        setLoaded(true);
        void checkService();
        const current = draftRef.current;
        if (current.pendingApply && aiStorage.canApply) void reconcile();
        else if (
          current.request &&
          (!current.run || current.run.status === "running")
        ) {
          setWorking(true);
          void poll(current.request.id, generation.current);
        }
      } catch (e) {
        if (mounted.current) {
          setLoaded(true);
          setServiceError(message(e));
        }
      }
    }
    void initialize();
    return () => {
      mounted.current = false;
      stopPolling();
      element?.close();
      previousFocus?.focus();
    };
  }, []);
  async function generate() {
    if (
      actionBusy.current ||
      !signedIn ||
      draftRef.current.pendingApply ||
      draftRef.current.receipt
    )
      return;
    const current = draftRef.current;
    if (!current.input.trim()) {
      setError("先写下你想实现的目标或需要整理的想法。");
      return;
    }
    if (current.input.length > 8000 || current.constraints.length > 2000) {
      setError(
        "原文最多 8,000 个字符，补充条件最多 2,000 个字符。内容没有被截断。",
      );
      return;
    }
    const unresolved =
      current.request && (!current.run || current.run.status === "running");
    let request: AiGenerateRequest;
    try {
      request = plannerGenerateRequest(current, initialLaunch.current);
    } catch (e) {
      setError(message(e));
      return;
    }
    const next = unresolved
      ? current
      : {
          ...current,
          launch: initialLaunch.current,
          request,
          run: null,
          tasks: [],
          pendingApply: null,
        };
    draftRef.current = next;
    setDraft(next);
    if (!persist(next)) {
      setError(
        "无法保存本次生成的恢复记录，尚未发送请求。请检查设备存储后重试。",
      );
      return;
    }
    stopPolling();
    const epoch = generation.current;
    actionBusy.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const run = await aiStorage.generate(request);
      if (!mounted.current || generation.current !== epoch) return;
      followRun(run);
    } catch (e) {
      if (mounted.current && generation.current === epoch) {
        if (
          e instanceof AiGatewayError &&
          ([400, 401, 403, 413, 429].includes(e.status) ||
            ["AI_NOT_CONFIGURED", "AI_DISABLED"].includes(e.code))
        ) {
          update((value) => ({ ...value, request: null, run: null }));
        }
        setWorking(false);
        setError(message(e));
      }
    } finally {
      actionBusy.current = false;
    }
  }
  async function queryRun() {
    const request = draftRef.current.request;
    if (!request || actionBusy.current) return;
    stopPolling();
    setWorking(true);
    setError("");
    await poll(request.id, generation.current);
  }
  async function cancel() {
    const request = draftRef.current.request;
    if (!request || actionBusy.current) return;
    stopPolling();
    actionBusy.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await aiStorage.cancel(request.id);
      if (mounted.current) {
        if (result && typeof result.id === "string") followRun(result);
        else followRun(await aiStorage.run(request.id));
      }
    } catch (e) {
      if (mounted.current) {
        if (e instanceof AiGatewayError && e.status === 404) {
          update((current) => ({
            ...current,
            request: null,
            run: null,
            tasks: [],
          }));
          setNotice("未找到仍在运行的生成，输入已保留。");
        } else setError(message(e));
      }
    } finally {
      actionBusy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function applyDraft() {
    if (actionBusy.current || !aiStorage.canApply) return;
    setError("");
    let command;
    try {
      command = buildAiApplyCommand(draftRef.current);
    } catch (e) {
      setError(message(e));
      return;
    }
    const pending = update((current) => ({
      ...current,
      pendingApply: command,
    }));
    if (!persist(pending)) {
      update((current) => ({ ...current, pendingApply: null }));
      setError("无法保存恢复记录，尚未创建任务。请检查设备存储后重试。");
      return;
    }
    actionBusy.current = true;
    setWorking(true);
    try {
      const prior = await aiStorage.receipt(command.operationId);
      if (prior) await applied(prior);
      else
        await applied(
          await aiStorage.apply(
            command,
            draftRef.current.launch.localRecoveryReadSet,
          ),
        );
    } catch (e) {
      const code = message(e);
      if (Object.hasOwn(rejectionMessages, code)) {
        if (code === "AI_STALE_SOURCE" || code === "AI_STALE_PROJECT")
          setStaleDetected(true);
        update((current) => ({ ...current, pendingApply: null }));
        if (mounted.current) setError(rejectionMessages[code]!);
      } else if (mounted.current) {
        setError(
          "保存结果尚未确认。请查询结果或重试同一批采用，草稿已锁定以防重复创建。",
        );
      }
    } finally {
      actionBusy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  async function undo() {
    const receipt = draftRef.current.receipt;
    if (!receipt || receipt.undone || actionBusy.current || !aiStorage.canApply)
      return;
    const operationId = draftRef.current.undoOperationId ?? crypto.randomUUID();
    const next = update((current) => ({
      ...current,
      undoOperationId: operationId,
    }));
    if (!persist(next)) {
      setError("无法保存撤销的恢复记录，尚未执行撤销。");
      return;
    }
    actionBusy.current = true;
    setWorking(true);
    setError("");
    try {
      await aiStorage.undo(operationId, receipt.operationId);
      await applied({ ...receipt, undone: true });
    } catch (e) {
      if (mounted.current) {
        const detail = message(e);
        if (detail === "AI_UNDO_CONFLICT") {
          setUndoBlocked(true);
          update((current) => ({ ...current, undoOperationId: null }));
          setError(
            "任务已有后续修改、安排或关联内容，已保留这些内容，本次不能直接撤销。",
          );
        } else setError("撤销结果尚未确认，请重试原撤销；不会重新创建任务。");
      }
    } finally {
      actionBusy.current = false;
      if (mounted.current) setWorking(false);
    }
  }
  const generationUnconfirmed =
    !!draft.request && (!draft.run || draft.run.status === "running");
  const appliedAlready = !!draft.receipt;
  const locked =
    !loaded ||
    working ||
    !!draft.pendingApply ||
    appliedAlready ||
    generationUnconfirmed;
  const sourceContext = draft.request?.context ?? draft.launch.context;
  const source = sourceContext.source;
  const proposal = draft.run?.proposal;
  const selected = draft.tasks.filter((t) => t.selected);
  const changedInput =
    !!draft.request &&
    (draft.input !== draft.request.input ||
      draft.constraints !== draft.request.constraints ||
      (draft.availableMinutes ?? null) !==
        (draft.request.context.availableMinutes ?? null));
  const stale =
    staleDetected ||
    (!!draft.request &&
      contextHasChanged(draft.request.context, launch.context));
  const existing = sourceContext.tasks.find(
    (t) => t.id === proposal?.suggestedTaskId,
  );
  const proposalSources = aiProposalSources(proposal ?? null, sourceContext);
  const updateTask = (key: string, patch: Partial<EditableAiTask>) =>
    update((current) => ({
      ...current,
      tasks: current.tasks.map((t) => (t.key === key ? { ...t, ...patch } : t)),
    }));
  function startAgain() {
    if (
      actionBusy.current ||
      draftRef.current.pendingApply ||
      (draftRef.current.undoOperationId && !draftRef.current.receipt?.undone)
    )
      return;
    stopPolling();
    const fresh = newPlannerDraft(initialLaunch.current);
    update(() => fresh);
    setError("");
    setNotice("");
    setUndoBlocked(false);
    setStaleDetected(false);
  }
  return (
    <dialog
      ref={dialog}
      className="ai-planner-dialog"
      aria-label="AI 规划助手"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="ai-planner-shell">
        <header className="ai-planner-header">
          <div>
            <span className="ai-planner-eyebrow">把下一步变清晰</span>
            <h2>
              {launch.mode === "clarify"
                ? "整理想法"
                : launch.mode === "resume"
                  ? "继续推进"
                  : "拆成步骤"}
            </h2>
          </div>
          <button
            type="button"
            className="ai-planner-close"
            aria-label="关闭规划助手"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="ai-planner-body">
          <p className="ai-planner-scope">
            {sourceContext.project
              ? "本次使用此项目的名称、成果、恢复资料与 " +
                sourceContext.tasks.length +
                " 项任务状态。"
              : source
                ? "本次仅使用这条原文与你补充的条件。"
                : "本次仅使用你在这里填写的想法与条件。"}{" "}
            采用前可以逐项修改。
          </p>
          <AiContextPreview context={sourceContext} />
          {!loaded && <p role="status">正在读取账号与上次草稿…</p>}
          {storageWarning && (
            <p role="alert" className="ai-planner-warning">
              {storageWarning}
            </p>
          )}
          {notice && (
            <p role="status" className="ai-planner-notice">
              {notice}
            </p>
          )}
          {serviceError && (
            <div className="ai-planner-warning">
              <p>{serviceError}</p>
              {signedIn && (
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void checkService()}
                >
                  重新检查服务
                </button>
              )}
            </div>
          )}
          {service?.enabled === false && (
            <p className="ai-planner-warning" role="status">
              当前账号服务尚未启用 AI 规划。输入会保留，你仍可继续手动管理任务。
            </p>
          )}
          <div className="ai-planner-inputs">
            <label>
              {source
                ? "原文"
                : launch.context.project
                  ? "这次希望推进什么"
                  : "想法或想实现的目标"}
              <textarea
                autoFocus
                rows={4}
                maxLength={8000}
                value={draft.input}
                readOnly={!!source}
                disabled={!loaded || locked}
                placeholder=""
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    input: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              补充条件 <span className="ai-planner-optional">可选</span>
              <textarea
                rows={2}
                maxLength={2000}
                value={draft.constraints}
                disabled={!loaded || locked}
                placeholder=""
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    constraints: event.target.value,
                  }))
                }
              />
            </label>
            <label className="ai-planner-time-budget">
              本次可用时间（分钟，可选）
              <input
                type="number"
                aria-label="本次可用时间"
                min={1}
                max={1440}
                value={draft.availableMinutes ?? ""}
                disabled={!loaded || locked}
                placeholder=""
                onChange={(event) =>
                  update((current) => ({
                    ...current,
                    availableMinutes:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  }))
                }
              />
              <small>
                只按你填写的时间筛选；有时间限制时，不推荐估时未知的已有任务。修改后需重新生成。
              </small>
            </label>
          </div>
          {proposal?.question && (
            <div className="ai-planner-question">
              <strong>还需要确认一件事</strong>
              <p>{proposal.question}</p>
              <small>在“补充条件”中回答，再生成建议。</small>
            </div>
          )}
          <div className="ai-planner-generation">
            {generationUnconfirmed ? (
              <>
                <span role="status">
                  {working ? "正在生成或查询结果…" : "上次生成结果尚未确认"}
                </span>
                {!working && (
                  <button type="button" onClick={() => void queryRun()}>
                    查询上次生成
                  </button>
                )}
                {!working && (
                  <button type="button" onClick={() => void generate()}>
                    重试同一请求
                  </button>
                )}
                <button
                  type="button"
                  disabled={actionBusy.current}
                  onClick={() => void cancel()}
                >
                  停止生成
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ai-planner-primary"
                disabled={
                  !loaded ||
                  !signedIn ||
                  working ||
                  !!draft.pendingApply ||
                  appliedAlready ||
                  staleDetected ||
                  service?.enabled === false ||
                  !draft.input.trim()
                }
                onClick={() => void generate()}
              >
                {proposal ? "根据当前条件重新生成" : "生成建议"}
              </button>
            )}
            {service?.model && <small>模型：{service.model}</small>}
          </div>
          {draft.run?.status === "failed" && (
            <p role="alert" className="ai-planner-warning">
              {draft.run.error?.message ??
                "本次生成未完成，输入已保留，可调整后重试。"}
            </p>
          )}
          {draft.run?.status === "cancelled" && (
            <p role="status">已停止生成，输入已保留。</p>
          )}
          {error && (
            <p role="alert" className="ai-planner-error">
              {error}
            </p>
          )}
          {proposal && (
            <section className="ai-planner-proposal" aria-label="建议草稿">
              <div className="ai-planner-proposal-heading">
                <h3>建议草稿</h3>
                <span>{draft.receipt ? "已处理" : "尚未创建任务"}</span>
              </div>
              <p>{proposal.summary}</p>
              {proposal.nextAction && (
                <p className="ai-planner-next">
                  <strong>最小下一步</strong>
                  {proposal.nextAction}
                </p>
              )}
              {!!proposalSources.length && (
                <section
                  className="ai-proposal-sources"
                  aria-label="建议引用的资料"
                >
                  <h3>建议引用的资料</h3>
                  {proposalSources.map((reference) => (
                    <details key={reference.key}>
                      <summary>
                        {reference.title}
                        {reference.truncated ? " · 摘录" : ""}
                      </summary>
                      <p>{reference.content || "此来源暂无额外说明。"}</p>
                    </details>
                  ))}
                </section>
              )}
              {existing && (
                <p className="ai-planner-existing">
                  已有任务可继续：<strong>{existing.title}</strong>
                  。无需再创建一份。
                </p>
              )}
              {!!proposal.assumptions.length && (
                <details className="ai-planner-assumptions">
                  <summary>
                    本次采用的假设 · {proposal.assumptions.length}
                  </summary>
                  <ul>
                    {proposal.assumptions.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
              {stale && (
                <p className="ai-planner-warning">
                  恢复的草稿基于较早的数据。请关闭后重新打开项目，再生成建议。
                </p>
              )}
              {changedInput && (
                <p className="ai-planner-warning">
                  输入条件已改变，请重新生成后再采用。
                </p>
              )}
              {!!draft.tasks.length && (
                <>
                  {!draft.request?.context.project ? (
                    <fieldset className="ai-planner-project" disabled={locked}>
                      <label className="ai-planner-check">
                        <input
                          type="checkbox"
                          checked={draft.createProject}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              createProject: event.target.checked,
                            }))
                          }
                        />
                        将步骤归入新项目
                      </label>
                      {draft.createProject && (
                        <>
                          <label>
                            项目名称
                            <input
                              value={draft.projectName}
                              maxLength={120}
                              onChange={(event) =>
                                update((current) => ({
                                  ...current,
                                  projectName: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            预期结果
                            <textarea
                              rows={2}
                              maxLength={2000}
                              value={draft.outcome}
                              onChange={(event) =>
                                update((current) => ({
                                  ...current,
                                  outcome: event.target.value,
                                }))
                              }
                            />
                          </label>
                        </>
                      )}
                    </fieldset>
                  ) : (
                    <p className="ai-planner-target">
                      保存到项目：
                      <strong>{draft.request.context.project.name}</strong>
                    </p>
                  )}
                  <p className="ai-planner-help">
                    选择步骤时会包含必要前置；取消前置会同时取消后续步骤。新任务默认不安排日期。
                  </p>
                  <ol className="ai-planner-steps">
                    {draft.tasks.map((task, index) => (
                      <li
                        key={task.key}
                        className={task.selected ? "selected" : ""}
                      >
                        <div className="ai-planner-step-heading">
                          <label className="ai-planner-check">
                            <input
                              type="checkbox"
                              disabled={locked}
                              checked={task.selected}
                              aria-label={"采用步骤 " + (index + 1)}
                              onChange={(event) =>
                                update((current) => ({
                                  ...current,
                                  tasks: selectAiStep(
                                    current.tasks,
                                    task.key,
                                    event.target.checked,
                                  ),
                                }))
                              }
                            />
                            <strong>步骤 {index + 1}</strong>
                          </label>
                          {task.dependsOn.length > 0 && (
                            <small>
                              前置：
                              {task.dependsOn
                                .map(
                                  (key) =>
                                    draft.tasks.findIndex(
                                      (t) => t.key === key,
                                    ) + 1,
                                )
                                .join("、")}
                            </small>
                          )}
                        </div>
                        <fieldset disabled={locked || !task.selected}>
                          <label className="ai-planner-step-title">
                            行动
                            <input
                              aria-label={"步骤 " + (index + 1) + " 标题"}
                              value={task.title}
                              maxLength={300}
                              onChange={(event) =>
                                updateTask(task.key, {
                                  title: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            怎样算完成
                            <textarea
                              aria-label={"步骤 " + (index + 1) + " 完成标准"}
                              rows={2}
                              value={task.criteria}
                              maxLength={1000}
                              onChange={(event) =>
                                updateTask(task.key, {
                                  criteria: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label className="ai-planner-estimate">
                            预计投入{" "}
                            <span className="ai-planner-optional">可留空</span>
                            <span>
                              <input
                                aria-label={"步骤 " + (index + 1) + " 预计分钟"}
                                type="number"
                                min={1}
                                max={480}
                                step={1}
                                placeholder="待估时"
                                value={task.estimatedMinutes ?? ""}
                                onChange={(event) =>
                                  updateTask(task.key, {
                                    estimatedMinutes:
                                      event.target.value === ""
                                        ? null
                                        : Number(event.target.value),
                                  })
                                }
                              />
                              分钟
                            </span>
                          </label>
                        </fieldset>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {proposal.reward && (
                <fieldset className="ai-planner-reward" disabled={locked}>
                  <label className="ai-planner-check">
                    <input
                      type="checkbox"
                      checked={draft.keepReward}
                      onChange={(event) =>
                        update((current) => ({
                          ...current,
                          keepReward: event.target.checked,
                        }))
                      }
                    />
                    保留这个奖励想法
                  </label>
                  {draft.keepReward && (
                    <>
                      <label>
                        想得到的奖励
                        <input
                          value={draft.rewardTitle}
                          maxLength={200}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              rewardTitle: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        约定条件
                        <textarea
                          rows={2}
                          maxLength={1000}
                          value={draft.rewardCondition}
                          onChange={(event) =>
                            update((current) => ({
                              ...current,
                              rewardCondition: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <small>本次保存为关联记录；不会自动购买或解锁。</small>
                    </>
                  )}
                </fieldset>
              )}
            </section>
          )}
          {draft.receipt && (
            <div className="ai-planner-result" role="status">
              <strong>
                {draft.receipt.undone
                  ? "本次采用已撤销"
                  : "已创建 " + draft.receipt.taskIds.length + " 项任务"}
              </strong>
              <p>
                {draft.receipt.undone
                  ? "原文仍保留，已经取得的其他进展不会被删除。"
                  : "原文来源已保留。新任务尚未安排日期，可稍后加入今天。"}
              </p>
              {!draft.receipt.undone && aiStorage.canApply && (
                <button
                  type="button"
                  disabled={working || undoBlocked}
                  onClick={() => void undo()}
                >
                  {draft.undoOperationId ? "重试原撤销" : "撤销本次采用"}
                </button>
              )}
            </div>
          )}
          {!aiStorage.canApply && proposal && (
            <p className="ai-planner-warning">
              请在 Praxis 桌面或 Android 应用中采用这些步骤。
            </p>
          )}
        </div>
        <footer className="ai-planner-footer">
          <small>
            {draft.pendingApply
              ? "采用结果待确认，原批次已保留"
              : signedIn && loaded
                ? storageWarning
                  ? "恢复记录尚未保存"
                  : "输入与草稿保存在当前账号的这台设备"
                : "采用前不会创建任务"}
          </small>
          <div>
            <button type="button" onClick={onClose}>
              {draft.receipt ? "完成" : "稍后继续"}
            </button>
            {draft.receipt ? (
              !launch.context.project &&
              !source && (
                <button
                  type="button"
                  disabled={working || !!draft.undoOperationId}
                  onClick={startAgain}
                >
                  开始新的整理
                </button>
              )
            ) : draft.pendingApply ? (
              <>
                <button
                  type="button"
                  disabled={working}
                  onClick={() => void reconcile()}
                >
                  查询保存结果
                </button>
                <button
                  type="button"
                  className="ai-planner-primary"
                  disabled={working}
                  onClick={() => void applyDraft()}
                >
                  重试同一批采用
                </button>
              </>
            ) : (
              draft.run?.status === "ready" &&
              selected.length > 0 && (
                <button
                  type="button"
                  className="ai-planner-primary"
                  disabled={
                    working || changedInput || stale || !aiStorage.canApply
                  }
                  onClick={() => void applyDraft()}
                >
                  采用选中 {selected.length} 步
                </button>
              )
            )}
          </div>
        </footer>
      </div>
    </dialog>
  );
}
