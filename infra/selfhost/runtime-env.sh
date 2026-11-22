#!/bin/sh
# Builds credential-bearing settings from mounted secret files at process start, so they never sit in
# the Compose file, `docker inspect` output or the instance .env. Passwords are generated as hex by
# setup.sh and therefore need no URL encoding.
set -eu

read_secret() {
  value="$(cat "$1")"
  if [ -z "$value" ]; then
    echo "runtime-env: secret file $1 is empty" >&2
    exit 1
  fi
  printf '%s' "$value"
}

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD_FILE:?DB_PASSWORD_FILE is required}"
DATABASE_URL="postgresql://${DB_USER}:$(read_secret "$DB_PASSWORD_FILE")@${DB_HOST}:5432/${DB_NAME}"
export DATABASE_URL
unset DB_PASSWORD_FILE

# NAME_FILE -> NAME for each optional file-backed setting; a configured but empty file is an error.
for name in SESSION_ENCRYPTION_KEY MEDIA_ASSETS_S3_ACCESS_KEY_ID MEDIA_ASSETS_S3_SECRET_ACCESS_KEY OPENAI_API_KEY; do
  eval "file=\${${name}_FILE:-}"
  if [ -n "$file" ]; then
    value="$(read_secret "$file")"
    export "$name=$value"
    unset "${name}_FILE"
  fi
done
unset file value

exec "$@"
