/** Never include raw plugin errors, SQL, paths or task content in diagnostics. */
export function recordStorageError(
  stage: string,
  error: unknown,
  operationId?: string,
) {
  const raw = error instanceof Error ? error.message : String(error);
  const category = /constraint/i.test(raw)
    ? "constraint"
    : /locked|busy/i.test(raw)
      ? "busy"
      : /full|space/i.test(raw)
        ? "capacity"
        : /permission|denied|readonly/i.test(raw)
          ? "permission"
          : "storage";
  const code = /(?:code[:= ]+)([0-9]+)/i.exec(raw)?.[1] ?? null;
  console.error(
    JSON.stringify({
      event: "local_storage_error",
      stage,
      category,
      code,
      operationId: operationId ?? null,
    }),
  );
}
