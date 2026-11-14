import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import fixture from "../../../docs/m0/fixtures.json";
import { createServer } from "./server";
import type { AccountSession } from "./accounts";

it("M0 baseline: three real local accounts keep colliding personal IDs isolated before project sharing exists", async () => {
  const server = createServer({ databasePath: ":memory:", devices: [] });
  try {
    const sessions: AccountSession[] = [];
    for (const account of Object.values(fixture.accounts)) {
      const registration = await server.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: account.email,
          password: "M0 synthetic test password only",
          displayName: account.email.split("@")[0],
          deviceId: randomUUID(),
        },
      });
      expect(registration.statusCode).toBe(201);
      sessions.push(registration.json<AccountSession>());
    }
    const generation = (await server.inject({ url: "/health" })).json()
      .generation;
    const [creator, member, outsider] = sessions;
    if (!creator || !member || !outsider) throw Error("Missing test account");
    const titles = [
      fixture.collision.creatorTitle,
      fixture.collision.memberTitle,
    ];
    const operationId = randomUUID();
    for (const [index, session] of [creator, member].entries()) {
      const payload = {
        operationId,
        deviceId: session.deviceId,
        changes: [
          {
            id: fixture.collision.entityId,
            kind: "task",
            expectedVersion: null,
            data: { title: titles[index], status: "todo" },
            deleted: false,
            createdAt: fixture.clock.now,
          },
        ],
      };
      const request = {
        method: "POST" as const,
        url: `/v1/entities/commands?generation=${generation}`,
        headers: { authorization: `Bearer ${session.token}` },
        payload,
      };
      const result = await server.inject(request);
      expect(result.statusCode).toBe(200);
      expect((await server.inject(request)).json()).toEqual(result.json());
      expect(
        (
          await server.inject({
            ...request,
            payload: { ...payload, ownerId: outsider.user.id },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const [session, title] of [
      [creator, titles[0]],
      [member, titles[1]],
      [outsider, null],
    ] as const) {
      const snapshot = await server.inject({
        url: "/v1/entities/snapshot",
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(snapshot.statusCode).toBe(200);
      expect(
        snapshot
          .json()
          .entities.map(
            (entity: { data: { title: string } }) => entity.data.title,
          ),
      ).toEqual(title ? [title] : []);
    }
    // These assertions protect the existing API. They do not simulate future project ACLs.
  } finally {
    await server.close();
  }
});
