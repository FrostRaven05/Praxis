# Entity sync protocol

POST `/v1/entities/commands`: `{operationId,deviceId,changes:[{id,kind,expectedVersion,data,deleted,createdAt,baseData?}]}`. UUID ids, ISO timestamps, nonempty atomic batch (maximum 10000 changes / 8 MiB). `expectedVersion` is null for creation. Optional `baseData` enables three-way merge against the actual historical version; forged bases are rejected. Same-field conflicts fail the entire batch with 409. Kind and createdAt remain immutable. Deleted entities may be restored with explicit CAS to support recycle-bin restore.

Result: `{entities:[{id,kind,version,data,deleted,createdAt,updatedAt}],cursor}`. One owner-scoped cursor per committed batch. Exact command retries return identical result; reused operation id with different payload yields OPERATION_MISMATCH.

GET `/v1/entities/changes?after=0&limit=25`: `{changes:[{entities,cursor,operationId,deviceId}],cursor,hasMore}`. Never split a batch. All clients apply a batch plus its cursor atomically. Server validates the resulting entity graph. Missing references reject without partial mutation.

Kinds: capture, task, project, section, plan, record, habit, habit_check, recurrence, review, view, settings, strategy, decision, focus, desktop_row. desktop_row preserves desktop auxiliary relational data; mobile retains these losslessly.

Existing captures are seeded once at server startup, preserving id and version, with `{rawText,status:"inbox"}`. The upgraded server immediately rejects every v1 capture write with PROTOCOL_UPGRADED, even before an owner's first entity command; v1 history remains readable. This closes the race between seeding and the first full-sync upload. Clients reconcile their old capture outbox using the old shadow as the three-way merge base when switching to entities, retaining pending payloads until entity acknowledgment. They must never run both writers concurrently. First uploads may include local tombstones with null expectedVersion; the server persists these to prevent stale resurrection. Feed pages are capped below 16 MiB without splitting batches.

## Restart and rollback recovery

Each server process has a fresh random `generation`, returned in health, feed pages, snapshots and command responses. Entity POST requires query `?generation=<current>` outside the frozen logical command body; missing generation returns 428 GENERATION_REQUIRED, mismatch returns 409 GENERATION_CHANGED before mutation.

GET `/v1/entities/snapshot?limit=100` returns `{entities,cursor,generation,hasMore,nextId}`. Subsequent pages use `?at=<first cursor>&afterId=<nextId>&generation=<first generation>&limit=100`. These pages reconstruct a consistent graph as of the fixed cursor despite newer writes. Limit is at most 1000 and pages below 16 MiB. A changed generation aborts paging.

On generation mismatch or invalid cursor, clients stage the entire snapshot, preserve unsent local entities and conflict content, and reconcile against their previous shadows. Snapshot conflict units follow connected components across local, baseline and snapshot references: unrelated projects continue independently, while shared plans, parent relationships and project moves remain together. All component outcomes plus the cursor/generation commit in one local transaction; failure in a later component rolls back earlier component changes and conflict records. Frozen commands are rebased into new operations only after durable reconciliation. Missing remote rows after rollback do not delete local data; they become creations. No client database is cleared.
