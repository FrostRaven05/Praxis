CREATE TABLE saved_views (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_profile(owner_id),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 entity_type TEXT NOT NULL DEFAULT 'task' CHECK(entity_type='task'),
 filter_ast_version INTEGER NOT NULL DEFAULT 1 CHECK(filter_ast_version=1),
 query_json TEXT NOT NULL CHECK(json_valid(query_json)),
 is_followed INTEGER NOT NULL DEFAULT 0 CHECK(is_followed IN(0,1)),
 version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX saved_views_owner ON saved_views(owner_id,deleted_at);
