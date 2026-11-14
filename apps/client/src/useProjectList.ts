import { useEffect, useState } from "react";
import type { Project } from "@praxis/application";
import { projectStorage } from "./storage";

export function useProjectList(revision: number) {
  const [items, setItems] = useState<Project[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    let query = 0;
    async function refresh() {
      const token = ++query;
      setLoading(true);
      try {
        const projects = await projectStorage.listProjects();
        if (active && token === query) {
          setItems(projects);
          setError("");
        }
      } catch (error) {
        if (active && token === query)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active && token === query) setLoading(false);
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [revision, retry]);
  return {
    items,
    error,
    loading,
    reload: () => setRetry((value) => value + 1),
  };
}
