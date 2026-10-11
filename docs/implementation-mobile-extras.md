# Android non-AI extra screens

Implemented by mobile_extras agent, 2026-10-11.

- Extras.tsx: habits, recurrence, records, strategy/decision templates, manual weekly review, search/saved views, trash, stats, persistent focus sessions, settings and export/import.
- All changes use the transactional mobile workspace API with optimistic versions and fixed operation IDs on uncertain retries. Rejected writes preserve input; pending writes and editor drafts prevent navigation until resolved/discarded.
- Record templates persist editable text and stable project/task references. Weekly reviews are manual and never create tasks automatically.
- Habit and recurrence rules retain effective-date history. Edits preview future-instance effects, preserve manually moved/edited/in-progress/completed occurrences, and update template plus affected tasks in one transaction. Rule changes begin tomorrow or a later chosen date. Existing materialized tasks remain when stopping a template; editing future rules provides the separate impact preview.
- Habit checks preserve original date, time zone and effective rule date. Weekly progress distinguishes incomplete weeks.
- Search combines text/status/project with AND or limited OR, includes an explicit archive toggle and saves stable project references.
- JSON preview calls the same validation as import; restore creates a distinct workspace, and settings allow switching back. Native export invokes the system share chooser through export-file.ts.
- Workspace time zone controls date boundaries and statistics.

Validation: TypeScript passes; schedule-rules.test.ts 3 tests cover historical rules, future exceptions, interval anchors and pause. Parent agent performs installed Android UI checks.

Remaining acceptance limits: no cloud sync service, no system notification delivery, no real-device or two-week usage certification. Search now supports title/updated/deadline/priority sorting; kind/project/status grouping; status/project/priority/deadline AND/OR conditions; and unplanned/focus/small/waiting/seven-day presets. Weekly reviews currently use a structured editable text template rather than individual persisted fields. History of commands is retained by the workspace layer; settings provide a read-only friendly history of the latest 100 operations. Project checks now distinguish missing next action, review due, overdue tasks, waiting evidence and 14-day unrecorded progress; reviews save stable project/task references.

Additional validation: extras-model.test.ts 4 tests passed for archive/trash exclusion, AND/OR priorities/deadlines, presets, project progress evidence and privacy-preserving history labels.
