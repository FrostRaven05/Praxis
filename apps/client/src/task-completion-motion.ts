/** Keep the confirmed row visible briefly before its refreshed view moves it. */
export async function animateTaskCompletion(taskId: string): Promise<() => void> {
  const titles: HTMLElement[] = [];
  const animations: Animation[] = [];
  const clear = () => {
    for (const title of titles) delete title.dataset.completionMotion;
    for (const animation of animations) animation.cancel();
  };
  if (
    typeof window === "undefined" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) return clear;
  try {
    const rows = new Set<HTMLElement>();
    for (const title of document.querySelectorAll<HTMLElement>("[data-completion-title]")) {
      if (title.dataset.completionTitle !== taskId || !title.getClientRects().length) continue;
      titles.push(title);
      title.dataset.completionMotion = "complete";
      const row = title.closest<HTMLElement>("[data-completion-row]");
      if (row) rows.add(row);
    }
    for (const row of rows) {
      animations.push(row.animate(
        [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-1px)" }],
        // Finish the 240 ms stroke, hold it for 300 ms, then fade the row.
        { delay: 540, duration: 240, easing: "ease-in-out", fill: "forwards" },
      ));
    }
    await Promise.all(animations.map((animation) => animation.finished.catch(() => {})));
    return clear;
  } catch {
    clear();
    return () => {};
  }
}
