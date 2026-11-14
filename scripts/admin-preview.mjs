import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "../apps/api/dist/server.js";

const token = process.env.PRAXIS_ADMIN_TOKEN;
if (!token || token.length < 32) {
  console.error(
    "请先设置 PRAXIS_ADMIN_TOKEN（至少 32 个字符），然后运行 pnpm admin:preview。",
  );
  process.exitCode = 1;
} else {
  mkdirSync(new URL("../.tools/admin-preview/", import.meta.url), {
    recursive: true,
  });
  const app = createServer({
    databasePath: fileURLToPath(
      new URL("../.tools/admin-preview/api.db", import.meta.url),
    ),
    devices: [],
    adminTokenHash: createHash("sha256").update(token).digest("hex"),
  });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await app.listen({ host: "127.0.0.1", port: 4319 });
  console.log("Praxis 管理后台预览：http://127.0.0.1:4319/admin");
  console.log(
    "此预览使用独立的本地数据库；使用你设置的 PRAXIS_ADMIN_TOKEN 登录。",
  );
}
