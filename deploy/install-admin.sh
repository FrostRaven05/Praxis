#!/usr/bin/env bash
# Run over the existing authenticated SSH connection; stdin contains only a SHA-256 hash.
set -Eeuo pipefail
umask 077
root=/opt/praxis
source_archive=${1:?Pass the uploaded source archive}
read -r admin_hash
[[ $admin_hash =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid administrator hash'; exit 1; }
[[ $(id -u) = 0 && -f "$root/compose.yaml" && -f "$root/deploy/runtime/config/server.json" ]] || exit 1
[[ -f "$source_archive" ]] || exit 1
cd "$root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$root/backups/before-admin-$stamp"
release=$(mktemp -d "$root/.admin-release-XXXXXX")
mkdir -p "$backup"
chmod 700 "$root/backups" "$backup" "$release"
old_image=$(docker inspect --format '{{.Image}}' praxis-api-1)
old_tag=$(docker inspect --format '{{.Config.Image}}' praxis-api-1)
printf '%s\n' "$old_image" > "$backup/image-id"
docker tag "$old_image" "praxis-api:before-admin-$stamp"
tar -xzf "$source_archive" -C "$release"
node_image=$(python3 - <<'PY'
from pathlib import Path
value = 'public.ecr.aws/docker/library/node:24-bookworm-slim'
for line in Path('.env').read_text().splitlines() if Path('.env').exists() else []:
    if line.startswith('PRAXIS_NODE_IMAGE='):
        value = line.split('=', 1)[1].strip().strip('"\'')
print(value)
PY
)
echo 'Building updated API and administration console; current service remains running.'
docker build --build-arg "NODE_IMAGE=$node_image" -t "praxis-api:admin-$stamp" "$release"

python3 - "$backup" <<'PY'
import pathlib, sys, tarfile
backup = pathlib.Path(sys.argv[1])
with tarfile.open(backup / 'source.tar.gz', 'w:gz') as archive:
    for name in ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','Dockerfile','.dockerignore','compose.yaml','apps/api']:
        if pathlib.Path(name).exists():
            archive.add(name, arcname=name)
PY

rollback() {
  code=$?
  trap - ERR INT TERM
  set +e
  echo 'Update did not pass startup checks. Restoring the previous service and database.' >&2
  docker compose stop api
  python3 - <<'PY'
import json, pathlib
root = pathlib.Path('/opt/praxis/deploy/runtime/data').resolve()
c = json.loads(pathlib.Path('/opt/praxis/deploy/runtime/config/server.json').read_text())
configured = pathlib.PurePosixPath(c['databasePath'])
relative = configured.relative_to('/data')
database = (root / str(relative)).resolve()
database.relative_to(root)
for name in [database, pathlib.Path(str(database)+'-wal'), pathlib.Path(str(database)+'-shm')]:
    name.unlink(missing_ok=True)
PY
  tar -xzf "$backup/runtime.tar.gz" -C "$root"
  tar -xzf "$backup/source.tar.gz" -C "$root"
  docker tag "$old_image" "$old_tag"
  docker compose up -d --no-build api
  echo "Rollback backup: $backup" >&2
  exit "$code"
}

echo 'Stopping briefly to capture a consistent database and configuration backup.'
docker compose stop api
if ! tar -czf "$backup/runtime.tar.gz" deploy/runtime .env; then
  docker compose start api
  exit 1
fi
trap rollback ERR INT TERM
python3 - "$backup/before.json" <<'PY'
import hashlib, json, pathlib, sqlite3, sys
c = json.loads(pathlib.Path('deploy/runtime/config/server.json').read_text())
database = pathlib.Path('deploy/runtime/data') / str(pathlib.PurePosixPath(c['databasePath']).relative_to('/data'))
with sqlite3.connect(database) as db:
    result = {table: db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['account_users','account_sessions','sync_entities','sync_entity_changes']}
    result['accountIdentities'] = {row[0]: hashlib.sha256(repr(row).encode()).hexdigest() for row in db.execute('SELECT id,email,display_name,salt,password_hash FROM account_users ORDER BY id')}
    result['integrity'] = db.execute('PRAGMA integrity_check').fetchone()[0]
pathlib.Path(sys.argv[1]).write_text(json.dumps(result))
PY
tar -xzf "$source_archive" -C "$root"
# Only the administrator hash enters the server config; the original key stays with the owner.
printf '%s\n' "$admin_hash" | python3 -c 'import json,os,pathlib,sys; p=pathlib.Path("deploy/runtime/config/server.json"); s=p.stat(); c=json.loads(p.read_text()); c["adminTokenHash"]=sys.stdin.readline().strip(); t=p.with_suffix(".admin-tmp"); t.write_text(json.dumps(c,indent=2)+"\n"); os.chown(t,s.st_uid,s.st_gid); os.chmod(t,0o600); os.replace(t,p)'
docker tag "praxis-api:admin-$stamp" "$old_tag"
docker compose up -d --no-build api

ready=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --cacert deploy/runtime/config/health-ca.crt --connect-to 8.152.219.210:443:127.0.0.1:443 https://8.152.219.210/health > "$backup/health.json"; then
    ready=1
    break
  fi
  sleep 2
done
[[ $ready = 1 ]]
curl --fail --silent --cacert deploy/runtime/config/health-ca.crt --connect-to 8.152.219.210:443:127.0.0.1:443 https://8.152.219.210/admin > /dev/null
status=$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert deploy/runtime/config/health-ca.crt --connect-to 8.152.219.210:443:127.0.0.1:443 https://8.152.219.210/admin/api/overview)
[[ $status = 401 ]]
python3 - "$backup/before.json" "$backup/after.json" <<'PY'
import hashlib, json, pathlib, sqlite3, sys
before = json.loads(pathlib.Path(sys.argv[1]).read_text())
c = json.loads(pathlib.Path('deploy/runtime/config/server.json').read_text())
database = pathlib.Path('deploy/runtime/data') / str(pathlib.PurePosixPath(c['databasePath']).relative_to('/data'))
with sqlite3.connect(database) as db:
    after = {table: db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in ['account_users','account_sessions','sync_entities','sync_entity_changes']}
    after['accountIdentities'] = {row[0]: hashlib.sha256(repr(row).encode()).hexdigest() for row in db.execute('SELECT id,email,display_name,salt,password_hash FROM account_users ORDER BY id')}
    after['integrity'] = db.execute('PRAGMA integrity_check').fetchone()[0]
assert after['integrity'] == 'ok'
assert all(after['accountIdentities'].get(user_id) == digest for user_id,digest in before['accountIdentities'].items()), 'Existing account identities changed during deployment'
pathlib.Path(sys.argv[2]).write_text(json.dumps(after))
print(json.dumps({'databaseIntegrity': after['integrity'], 'accountIdentitiesPreserved': True, 'countsBefore': {k:v for k,v in before.items() if isinstance(v,int)}, 'countsAfter': {k:v for k,v in after.items() if isinstance(v,int)}}))
PY
trap - ERR INT TERM
echo "Deployment complete. Backup: $backup"
docker compose ps
