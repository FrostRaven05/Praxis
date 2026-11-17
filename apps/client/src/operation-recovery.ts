/** Retry only bounded reads or an unchanged, idempotent command. Never rebase drafts. */
export function rejectedOperation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  return (
    /Rejected|Scope|Abort/.test(name) ||
    /STATE_CONFLICT|USER:|AI_STALE|Operation reused|已更新|已变化|发生变化|不存在|已删除|无效|不支持|权限|登录|密码|UNAUTHORIZED|FORBIDDEN|INVALID|NOT_FOUND|401\b|403\b/i.test(
      text,
    )
  );
}

export function transientFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    !rejectedOperation(error) &&
    /failed to fetch|fetch failed|network|timeout|timed out|connection|ECONN|EPIPE|IPC.*(?:closed|unavailable)|SQLITE_BUSY|SQLITE_LOCKED|database is locked|网络|连接|超时|未能确认|暂未确认|保存结果未确认/i.test(
      text,
    )
  );
}

export async function recoverRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (rejectedOperation(error)) throw error;
    return read();
  }
}

export async function replayOperation<T>(
  send: () => Promise<T>,
  sameScope: () => Promise<boolean>,
): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (!transientFailure(error)) throw error;
    let safe = false;
    try {
      safe = await sameScope();
    } catch {
      /* Preserve the original uncertain result. */
    }
    if (!safe) throw error;
    return send();
  }
}

export function operationId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = Reflect.get(value, "operationId");
  return typeof id === "string" && id.length > 0 ? id : null;
}
