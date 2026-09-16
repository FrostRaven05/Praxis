import { recordStorageError } from "./diagnostics";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { MobileStorage } from "./index";
import { initialStatements } from "./migration";
const sqlite = new SQLiteConnection(CapacitorSQLite);
let opening: ReturnType<typeof open> | undefined;
async function open() {
  await sqlite.addUpgradeStatement("praxis", [
    {
      toVersion: 1,
      statements: initialStatements,
    },
  ]);
  const db = await sqlite.createConnection(
    "praxis",
    false,
    "no-encryption",
    1,
    false,
  );
  try {
    await db.open();
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
