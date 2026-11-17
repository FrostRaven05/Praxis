import { feedbackMessage } from "./feedback-message";
import { useLanRefresh } from "./useLanRefresh";
import { useEffect, useState } from "react";
import { Planning, parseMinutes, type DayLoad } from "@praxis/application";
import { planningStorage } from "./storage";
export const planning = new Planning(planningStorage);
export function PlanningPanel({
  date,
  revision,
}: {
  date: string;
  revision: number;
}) {
  const [load, setLoad] = useState<DayLoad | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useLanRefresh(() => planningStorage.dayLoad(date), setLoad, false, date);
  useEffect(() => {
    let active = true;

    void planningStorage
      .dayLoad(date)
      .then((value) => {
        if (active) {
          setLoad(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [date, revision, reload]);
  if (error)
    return (
      <p className="error" role="alert">
        {feedbackMessage(error)}
        <button onClick={() => setReload((x) => x + 1)}>重新读取负载</button>
      </p>
    );
  if (!load) return <p className="loading">正在读取每日负载…</p>;
  const over =
    load.capacityMinutes !== null &&
    load.estimatedMinutes > load.capacityMinutes;
  return (
    <section
      className={"planning-panel" + (over ? " overloaded" : "")}
      aria-label="每日负载"
    >
      <div>
        <strong>已安排预计 {load.estimatedMinutes} 分钟</strong>
        <span> · {load.unknownCount} 项待估时</span>
        {over && (
          <p role="status">
            已超出可用时长 {load.estimatedMinutes - (load.capacityMinutes ?? 0)}{" "}
            分钟，可继续调整安排。
          </p>
        )}
        {load.unknownCount > 0 && (
          <span title="当前估时未包含待估时任务"> · 估时未完整</span>
        )}
      </div>
      <details className="capacity-settings">
        <summary>
          可用时长
          {load.capacityMinutes !== null
            ? " · " + load.capacityMinutes + " 分钟"
            : ""}
        </summary>
        <CapacityForm
          key={date + ":" + load.capacityVersion}
          date={date}
          load={load}
          onSaved={() => setReload((x) => x + 1)}
        />
      </details>
    </section>
  );
}
function CapacityForm({
  date,
  load,
  onSaved,
}: {
  date: string;
  load: DayLoad;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(load.capacityMinutes?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        void Promise.resolve()
          .then(() =>
            planning.capacity(
              date,
              load.capacityVersion,
              parseMinutes(value, true),
            ),
          )
          .then(onSaved)
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
    >
      <label htmlFor="capacity-minutes">可用时长（分钟）</label>
      <input
        id="capacity-minutes"
        type="number"
        min="0"
        max="1440"
        placeholder="未设置"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      <button disabled={busy} type="submit">
        保存容量
      </button>
      {error && (
        <p className="error" role="alert">
          {feedbackMessage(error)}
        </p>
      )}
    </form>
  );
}
