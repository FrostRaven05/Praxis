#!/bin/sh
set -eu

# Certbot deploy hook. The CA account and private keys stay on the ECS.
# This legacy lineage name now contains both todo.frostraven05.com and the IP.
certificate=/etc/letsencrypt/live/praxis-ecs-ip
config=/opt/praxis/deploy/runtime/config

test -r "$certificate/privkey.pem"
test -r "$certificate/fullchain.pem"
umask 077
install -m 600 -o 1000 -g 1000 "$certificate/privkey.pem" "$config/server.key.next"
install -m 600 -o 1000 -g 1000 "$certificate/fullchain.pem" "$config/fullchain.pem.next"
install -m 600 -o 1000 -g 1000 /etc/pki/tls/certs/ca-bundle.crt "$config/health-ca.crt.next"
mv "$config/server.key.next" "$config/server.key"
mv "$config/fullchain.pem.next" "$config/fullchain.pem"
mv "$config/health-ca.crt.next" "$config/health-ca.crt"
cd /opt/praxis
docker compose restart api
