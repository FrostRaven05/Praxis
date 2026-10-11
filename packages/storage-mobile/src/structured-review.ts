export interface StructuredReview {
  periodStart: string;
  periodEnd: string;
  achievements: string;
  blockers: string;
  stopPause: string;
  nextFocus: string;
}
export function structuredReview(
  data: Record<string, unknown>,
): StructuredReview | null {
  return [
    "periodStart",
    "periodEnd",
    "achievements",
    "blockers",
    "stopPause",
    "nextFocus",
  ].every((k) => typeof data[k] === "string")
    ? (data as unknown as StructuredReview)
    : null;
}
export function reviewBody(review: StructuredReview): string {
  return `期间：${review.periodStart} — ${review.periodEnd}\n\n推进成果\n${review.achievements}\n\n阻塞\n${review.blockers}\n\n停止 / 暂停\n${review.stopPause}\n\n下周重点\n${review.nextFocus}`;
}
export function blankReview(today: string): StructuredReview {
  const start = new Date(today + "T12:00:00Z");
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
    achievements: "",
    blockers: "",
    stopPause: "",
    nextFocus: "",
  };
}
