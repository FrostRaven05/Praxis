import { recordStorageError } from "./diagnostics";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { MobileStorage } from "./index";
import {
  initialStatements,
  captureStatements,
  workspaceStatements,
  lanStatements,
  entitySyncStatements,
} from "./migration";
const sqlite = new SQLiteConnection(CapacitorSQLite);
let opening: ReturnType<typeof open> | undefined;
async function open() {
  // A WebView reload resets JS state but can leave the native connection alive.
  // Reconcile the plugin's connection registry before creating/retrieving it.
  await sqlite.checkConnectionsConsistency();
  await sqlite.addUpgradeStatement("praxis", [
    {
      toVersion: 1,
      statements: initialStatements,
    },
    { toVersion: 2, statements: captureStatements },
    { toVersion: 3, statements: workspaceStatements },
    { toVersion: 4, statements: lanStatements },
    { toVersion: 5, statements: entitySyncStatements },
  ]);
  const db = (await sqlite.isConnection("praxis", false)).result
    ? await sqlite.retrieveConnection("praxis", false)
    : await sqlite.createConnection("praxis", false, "no-encryption", 5, false);
  try {
    if (!(await db.isDBOpen()).result) await db.open();
    await db.execute("PRAGMA foreign_keys=ON;", false);
    await db.query("PRAGMA journal_mode=WAL;");
    await db.execute("PRAGMA synchronous=FULL;", false);
    return db;
  } catch (error) {
    await sqlite.closeConnection("praxis", false).catch(() => undefined);
    throw error;
  }
}
export const mobileStorage = new MobileStorage(() => {
  opening ??= open().catch((error) => {
    opening = undefined;
    recordStorageError("open", error);
    throw new Error("无法打开本机数据库，请检查存储空间后重试。", {
      cause: error,
    });
  });
  return opening;
});
