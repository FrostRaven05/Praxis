/** Presentation only: keep the original error and pending operation in the caller. */
export function feedbackMessage(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? ""))
    .replace(/^(?:(?:Error|TypeError|USER):\s*)+/, "")
    .trim();
  if (!text) return "暂时无法完成，请重试。";
  if (/^(?:STATE_CONFLICT|AI_STALE_PROJECT)$/.test(text))
    return "内容已更新，请刷新后重试。";
  if (/UNAUTHORIZED|登录已失效|登录已过期|401\b/.test(text))
    return "登录已过期，请重新登录。";
  if (/SQLITE_FULL|ENOSPC|quota exceeded|存储空间不足/i.test(text))
    return "存储空间不足，请清理后重试。";
  if (
    /failed to fetch|fetch failed|network|timeout|timed out|ECONN|EPIPE|IPC.*(?:closed|unavailable)/i.test(
      text,
    )
  )
    return "连接暂时不可用，请重试。";
  if (/未能确认.*(?:结果|保存|更新)|保存结果尚未确认/.test(text))
    return "保存结果未确认，请重试。";
  if (
    /SQLITE_|sqlx::|SELECT\s.+FROM|INSERT INTO|^\s*\{|^\s*<html|stack trace|^Error invoking/i.test(
      text,
    ) ||
    !/[\u3400-\u9fff]/.test(text)
  )
    return "暂时无法完成，请重试。";
  return text;
}
