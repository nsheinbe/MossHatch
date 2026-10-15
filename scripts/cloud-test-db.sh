#!/bin/sh
# Isolated, synthetic PostgreSQL for a non-root cloud workspace. No production credentials.
# The image is the PostgreSQL 16 image verified for this task; update the digest deliberately.
set -eu
NAME=mosshatch-security-tests
IMAGE=postgres:16@sha256:ca0bd484cb98bf4b24eb1010e73fb3fcbd6714d240fbc1a10eea5b7dbecb641d
case "${1:-status}" in
  start)
    if docker container inspect "$NAME" >/dev/null 2>&1; then
      docker start "$NAME" >/dev/null
    else
      docker run --name "$NAME" --label project=mosshatch-local-tests \
        -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:54329:5432 -d "$IMAGE" \
        -c max_connections=200 -c fsync=off -c synchronous_commit=off >/dev/null
    fi
    attempts=0
    until docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; do
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 30 ]; then echo 'Local test PostgreSQL did not become ready.' >&2; exit 1; fi
      sleep 1
    done
    echo 'Local synthetic test database ready on 127.0.0.1:54329.'
    ;;
  status) docker exec "$NAME" pg_isready -U postgres ;;
  stop) docker stop "$NAME" >/dev/null ;;
  *) echo 'Usage: scripts/cloud-test-db.sh start|status|stop' >&2; exit 2 ;;
esac
# Stop preserves all test databases. This script never removes a container or volume.
