#!/bin/sh
# piext-handoff launcher: a new tab in this Rex session.
#
#   rex.sh active   exit 0 when this pi runs inside Rex
#   rex.sh start    open a tab running $HANDOFF_PI_CMD
#   rex.sh close    close this pi's block
set -eu

case "${1:-}" in
active)
  [ -n "${REX_SESSION:-}" ] || { echo "not in Rex (no REX_SESSION)" >&2; exit 1; }
  command -v rex >/dev/null || { echo "rex isn't on PATH" >&2; exit 1; }
  ;;
start)
  rex run -s "$REX_SESSION" -c "$HANDOFF_CWD" -- sh -c "$HANDOFF_PI_CMD"
  ;;
close)
  rex block close -s "$REX_SESSION" "${REX_BLOCK:?}"
  ;;
*)
  echo "usage: $0 active|start|close" >&2
  exit 2
  ;;
esac
