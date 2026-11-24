#!/bin/sh
# piext-handoff launcher: a new Loop session (tab) through AppleScript.
#
#   loop.sh active   exit 0 when this pi runs inside Loop
#   loop.sh start    open the new session; print its Loop id
#   loop.sh close    close this Loop session
#
# The handoff's details come in as HANDOFF_* variables (see the README).
# Loop starts its own pi, so this sends /model and the prompt as messages
# instead of running $HANDOFF_PI_CMD.
set -eu

case "${1:-}" in
active)
  [ -n "${LOOP_SESSION_ID:-}" ] || { echo "not in a Loop session (no LOOP_SESSION_ID)" >&2; exit 1; }
  ;;
start)
  osascript - "$HANDOFF_CWD" "/model $HANDOFF_MODEL" "$HANDOFF_PROMPT_FILE" <<'APPLESCRIPT'
on run argv
  set prompt to read POSIX file (item 3 of argv) as «class utf8»
  tell application id "com.github.kennyp.loop"
    set s to open folder (item 1 of argv) with new session
    send message (item 2 of argv) to s
    send message prompt to s
  end tell
  return s
end run
APPLESCRIPT
  ;;
close)
  osascript -e 'on run argv' -e 'tell application id "com.github.kennyp.loop" to close session ((item 1 of argv) as integer)' -e 'end run' "$LOOP_SESSION_ID"
  ;;
*)
  echo "usage: $0 active|start|close" >&2
  exit 2
  ;;
esac
