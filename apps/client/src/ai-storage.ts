import { invoke, isTauri } from "./native-recovery";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  calendarDate,
  type Project,
  type ProjectTask,
  type WorkSnapshot,
} from "@praxis/application";
import type { AiRecoveryReadSet } from "@praxis/storage-mobile";
import type {
  AiApplyCommand,
  AiApplyReceipt,
  AiGenerateRequest,
  AiRun,
} from "../../api/src/ai-contract";

interface GatewayRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}
interface GatewayResponse {
  status: number;
  body: unknown;
}
const native = registerPlugin<{
  aiRequest(request: GatewayRequest): Promise<GatewayResponse>;
}>("LanSync");
export class AiGatewayError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(input: GatewayRequest): Promise<T> {
  if (!isTauri() && !Capacitor.isNativePlatform())
    throw new Error("请在 Praxis 桌面或 Android 应用中使用规划助手。");
  const result = isTauri()
    ? await invoke<GatewayResponse>("ai_gateway_request", { request: input })
    : await native.aiRequest(input);
  if (!result || typeof result.status !== "number")
    throw Error("规划服务响应不完整，请重试查询。");
  if (result.status < 200 || result.status >= 300) {
    const body = result.body as {
      error?: string | { code?: string; message?: string };
      code?: string;
      message?: string;
    } | null;
    const detail = body?.error;
    const code =
      typeof detail === "string"
        ? detail
        : (detail?.code ?? body?.code ?? "AI_REQUEST_FAILED");
    const message =
      typeof detail === "object" ? detail?.message : body?.message;
    const fallback: Record<string, string> = {
      UNAUTHORIZED: "登录已失效，请重新登录账号。",
      AI_NOT_CONFIGURED: "当前服务尚未配置 AI。你的输入与草稿会保留。",
      AI_DISABLED: "当前服务尚未启用 AI。你的输入与草稿会保留。",
      AI_RUN_NOT_FOUND: "未找到上次生成，可使用同一请求重试。",
      AI_INPUT_CONFLICT: "此生成请求已有不同内容，请先查看上次结果。",
      RATE_LIMITED: "请求较多，请稍后重试。",
    };
    throw new AiGatewayError(
      code,
      message ?? fallback[code] ?? "规划服务暂时不可用，输入与草稿已保留。",
      result.status,
    );
  }
  return result.body as T;
}
let mobileAdapter: Promise<
  ReturnType<(typeof import("./ai-mobile-adapter"))["createMobileAiAdapter"]>
> | null = null;
function mobileApplication() {
  mobileAdapter ??= Promise.all([
    import("./ai-mobile-adapter"),
    import("./mobile-storage"),
    import("./account-storage"),
  ]).then(([adapter, storage, accounts]) =>
    adapter.createMobileAiAdapter({
      snapshot: () => storage.mobileStorage.workspaceSnapshot(),
      commit: (command) => storage.mobileStorage.workspaceCommand(command),
      cache: localStorage,
      scope: async () => {
        const account = await accounts.accountStorage.status();
        if (!account.user) throw Error("请先登录账号。");
        const database = await storage.mobileDatabaseName();
        const workspace = (await storage.mobileStorage.workspaceList()).find(
          (w) => w.active,
        );
        if (!workspace) throw Error("AI_STALE_PROJECT");
        return {
          key: [account.baseUrl, account.user.id, database, workspace.id].join(
            "|",
          ),
          workspaceId: workspace.id,
        };
      },
    }),
  );
  return mobileAdapter;
}
export const aiStorage = {
  desktop: isTauri(),
  canApply: isTauri() || Capacitor.isNativePlatform(),
  status: () =>
    request<{
      enabled: boolean;
      model: string | null;
      maxInputCharacters: number;
    }>({ method: "GET", path: "/v1/ai/status" }),
  generate: (body: AiGenerateRequest) =>
    request<AiRun>({ method: "POST", path: "/v1/ai/runs", body }),
  run: (id: string) =>
    request<AiRun>({
      method: "GET",
      path: "/v1/ai/runs/" + encodeURIComponent(id),
    }),
  cancel: (id: string) =>
    request<AiRun>({
      method: "POST",
      path: "/v1/ai/runs/" + encodeURIComponent(id) + "/cancel",
      body: {},
    }),
  apply: (command: AiApplyCommand, localRecoveryReadSet?: AiRecoveryReadSet) =>
    isTauri()
      ? invoke<AiApplyReceipt>("ai_apply", { command })
      : mobileApplication().then((adapter) =>
          adapter.apply(command, localRecoveryReadSet),
        ),
  receipt: (operationId: string) =>
    isTauri()
      ? invoke<AiApplyReceipt | null>("ai_receipt", { operationId })
      : mobileApplication().then((adapter) => adapter.receipt(operationId)),
  undoMobileApplication: (applyOperationId: string) =>
    mobileApplication().then((adapter) =>
      adapter.undoSavedApplication(applyOperationId),
    ),
  undo: (operationId: string, applyOperationId: string) =>
    isTauri()
      ? invoke<void>("ai_undo", { operationId, applyOperationId })
      : mobileApplication().then((adapter) =>
          adapter.undo(operationId, applyOperationId),
        ),
};
export async function desktopAiContext(
  project: Project | null,
  tasks: ProjectTask[],
): Promise<AiGenerateRequest["context"]> {
  if (project)
    return invoke<AiGenerateRequest["context"]>("ai_project_snapshot", {
      projectId: project.id,
    });
  const snapshot = await invoke<WorkSnapshot>("productivity_snapshot");
  const freshTasks = tasks;
  const timeZone =
    snapshot.settings[0]?.timeZone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    date: calendarDate(new Date(), timeZone),
    timeZone,
    project: null,
    tasks: freshTasks.map((t) => ({
      id: t.taskId,
      title: t.title,
      status: t.status,
      version: t.version,
      dependencies: t.dependencies ?? [],
      parentId: t.parentTaskId ?? null,
      estimatedMinutes: null,
    })),
    source: null,
  };
}
export { mobileAiContext, mobileAiLaunch } from "./ai-context-mobile";
