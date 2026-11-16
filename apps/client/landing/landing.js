const tasks = document.querySelector(".demo-content");
function updateProgress() {
  const all = [...tasks.querySelectorAll(".demo-task input")];
  const completed = all.filter((input) => input.checked).length;
  all.forEach((input) =>
    input.closest(".demo-task").classList.toggle("is-complete", input.checked),
  );
  document.querySelector("#progress-label").textContent =
    `${completed} / ${all.length} 已完成`;
  document.querySelector("#progress-fill").style.width =
    `${(completed / all.length) * 100}%`;
  document.querySelector("#remaining-count").textContent =
    all.length - completed;
  document.querySelector("#demo-status").textContent =
    completed === all.length
      ? "今天的小目标，全部完成。给自己一个赞！"
      : "每完成一小步，都在靠近想要的生活。";
}
tasks.addEventListener("change", updateProgress);
document.querySelector(".demo-add-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#new-task");
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  const label = document.createElement("label");
  label.className = "demo-task";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  const check = document.createElement("span");
  check.className = "task-check";
  const text = document.createElement("span");
  text.className = "task-text";
  text.textContent = title;
  const meta = document.createElement("small");
  meta.textContent = "收件箱 · 演示任务";
  text.append(meta);
  label.append(checkbox, check, text);
  document.querySelector(".demo-add-form").before(label);
  input.value = "";
  updateProgress();
  document.querySelector("#demo-status").textContent =
    "已添加演示任务。此处的体验数据不会保存。";
});

let remaining = 25 * 60;
let interval = null;
const timerButton = document.querySelector(".focus-toggle");
function pauseTimer() {
  clearInterval(interval);
  interval = null;
  timerButton.textContent = "▷";
  timerButton.setAttribute("aria-label", "开始演示番茄钟");
  timerButton.setAttribute("aria-pressed", "false");
}
timerButton.addEventListener("click", () => {
  if (interval) {
    pauseTimer();
    return;
  }
  if (!remaining) remaining = 25 * 60;
  timerButton.textContent = "Ⅱ";
  timerButton.setAttribute("aria-label", "暂停演示番茄钟");
  timerButton.setAttribute("aria-pressed", "true");
  const deadline = Date.now() + remaining * 1000;
  interval = setInterval(() => {
    remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    document.querySelector("#hero-timer").textContent =
      `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
    if (!remaining) {
      pauseTimer();
      document.querySelector("#demo-status").textContent =
        "专注完成，休息一下吧。";
    }
  }, 250);
});
window.addEventListener("pagehide", pauseTimer);

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-view]")
      .forEach((tab) =>
        tab.setAttribute("aria-pressed", String(tab === button)),
      );
    document
      .querySelector("#project-preview")
      .classList.toggle("list-view", button.dataset.view === "list");
  });
});
document.querySelector("#copyright-year").textContent = String(
  new Date().getFullYear(),
);
