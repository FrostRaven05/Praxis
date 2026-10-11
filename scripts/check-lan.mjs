import { readFile } from "node:fs/promises";
import https from "node:https";
const directory = new URL("../.tools/lan/", import.meta.url);
const connection = JSON.parse(
  await readFile(new URL("connection.json", directory), "utf8"),
);
const ca = await readFile(new URL("ca.crt", directory));
await new Promise((resolve, reject) => {
  const request = https.get(
    connection.baseUrl + "/health",
    { ca, timeout: 5000 },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const result = JSON.parse(body);
          if (
            response.statusCode !== 200 ||
            result.service !== "praxis-lan" ||
            result.status !== "ok"
          )
            throw new Error("Unexpected health response");
          console.log(
            `HTTPS certificate and API health verified: ${connection.baseUrl}`,
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  request.on("timeout", () =>
    request.destroy(new Error("Health check timed out")),
  );
  request.on("error", reject);
});
