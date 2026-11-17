import { Capacitor } from "@capacitor/core";
import { createPersonalProjectSave, type Project } from "@praxis/application";
import {
  WorkspaceRejectedError,
  type WorkspaceEntity,
} from "@praxis/storage-mobile";
import {
  mobileStorage,
  mobileDatabaseName,
} from "./mobile-storage";
import { accountStorage } from "./account-storage";
import { projectStorage } from "./storage";
import { mobileProjectCommand } from "./personal-project-adapters";

async function scope() {
  const account = await accountStorage.status();
  const identity = [account.baseUrl, account.user?.id ?? "local"];
  if (Capacitor.isNativePlatform()) {
    identity.push(await mobileDatabaseName());
    identity.push(
      (await mobileStorage.workspaceList()).find((w) => w.active)?.id ??
        "local",
    );
  }
  return JSON.stringify(identity);
}
export function desktopProjectSave(base: Project | null) {
  return createPersonalProjectSave(base, {
    scope,
    save: (command) => projectStorage.saveProject(command),
    rejected: (error) =>
      /^(?:STATE_CONFLICT|USER:|Operation reused)/.test(
        error instanceof Error ? error.message : String(error),
      ),
  });
}
export function mobileProjectSave(
  entity: WorkspaceEntity,
  workspaceId: string,
) {
  return createPersonalProjectSave(
    entity.version
      ? {
          id: entity.id,
          version: entity.version,
          name: String(entity.data.title ?? ""),
          outcome: String(entity.data.outcome ?? ""),
          targetDate:
            typeof entity.data.dueDate === "string"
              ? entity.data.dueDate
              : null,
          priority: 1,
        }
      : null,
    {
      scope,
      async save(command) {
        await mobileStorage.workspaceCommand(
          mobileProjectCommand(entity, workspaceId, command),
        );
      },
      rejected: (error) => error instanceof WorkspaceRejectedError,
    },
  );
}
