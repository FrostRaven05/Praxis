import { useEffect, useState } from "react";
import { type ContentSnapshot } from "@praxis/application";
import { readContent, contentError } from "./content-storage";
export function RelatedRecords({
  targetType,
  targetId,
}: {
  targetType: "task" | "project";
  targetId: string;
}) {
  const [data, setData] = useState<ContentSnapshot | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void readContent()
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => active && setError(contentError(e)));
    return () => {
      active = false;
    };
  }, [targetType, targetId]);
  const source = data?.tasks.find((t) => t.id === targetId)?.sourceCaptureId;
  return (
    <div className="related-records">
      {source && (
        <details>
          <summary>来源原文</summary>
          <pre>{data?.captures.find((c) => c.id === source)?.rawText}</pre>
        </details>
      )}
      <details>
        <summary>关联记录</summary>
        {error ? (
          <p role="alert">{error}</p>
        ) : !data ? (
          <p>正在读取…</p>
        ) : (
          <>
            {!data.records.some((r) =>
              r.links.some(
                (l) => l.targetType === targetType && l.targetId === targetId,
              ),
            ) && <p>暂无关联记录。可在“收件箱与记录”中编辑关联。</p>}
            {data.records
              .filter((r) =>
                r.links.some(
                  (l) => l.targetType === targetType && l.targetId === targetId,
                ),
              )
              .map((r) => (
                <article key={r.id}>
                  <strong>{r.title || "无标题记录"}</strong>
                  <pre>{r.body}</pre>
                </article>
              ))}
          </>
        )}
      </details>
    </div>
  );
}
