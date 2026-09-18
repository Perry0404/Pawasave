#!/usr/bin/env bash
# psql with retries. DNS for the Supabase pooler hosts resolves intermittently from here, and a
# transient failure produced an empty result set that looked like a real schema difference. Any
# comparison between prod and staging has to distinguish "no rows" from "could not ask".
#
# Usage: pq.sh <uri> -Atc "select ..."   or   pq.sh <uri> -At -f file.sql
# Exits non-zero if every attempt failed, so a caller can tell the difference.
set -uo pipefail

URI="$1"; shift
ATTEMPTS="${PQ_ATTEMPTS:-6}"
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-25}"

for i in $(seq 1 "$ATTEMPTS"); do
  OUT=$(psql "$URI" "$@" 2>&1)
  RC=$?
  if [ $RC -eq 0 ]; then
    printf '%s' "$OUT"
    exit 0
  fi
  case "$OUT" in
    *"could not translate host name"*|*"Network is unreachable"*|*"timeout expired"*|*"server closed the connection"*)
      sleep $(( i * 2 ))
      continue ;;
    *)
      # A real SQL or auth error, so retrying will not help.
      printf '%s' "$OUT" >&2
      exit "$RC" ;;
  esac
done

echo "pq.sh: all $ATTEMPTS attempts failed for a transient reason" >&2
exit 99
