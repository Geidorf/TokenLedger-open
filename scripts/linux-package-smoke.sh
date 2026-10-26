#!/usr/bin/env bash
# Linux 安装包冒烟：在一个全新的 HOME 里启动装好的桌面端，确认它在 Linux 上
# 真的能用，而不只是能编译。逐项检查：
#   1. 主窗口出现（X11 下按窗口标题找）；
#   2. 托盘图标向 StatusNotifierWatcher 注册（由 linux-tray-watcher.py 扮演面板）；
#   3. 开机自启：默认与旧偏好均不创建条目；已有有效条目在启动后刷新 Exec；
#   4. 数据目录落在 $XDG_DATA_HOME/com.jeidorf.tokenledger，冷启动扫描把预置的
#      ~/.claude/projects 会话记进 token_logs；
#   5. 再启动一次会交给已在运行的实例并退出（单实例）；
#   6. 有 tokenledger-cli 时，它能读同一个数据目录。
#
# 用法（需要 X 显示与会话总线，CI 里这样包一层）：
#   xvfb-run -a dbus-run-session -- bash scripts/linux-package-smoke.sh \
#     <启动命令> <自启条目里应出现的 Exec 路径> [tokenledger-cli 路径]
#
# 依赖：xdotool、sqlite3、python3-gi。PYTHON 可指定带 gi 的解释器。

set -euo pipefail

APP="${1:?usage: linux-package-smoke.sh <app> <expected-exec> [cli]}"
EXPECTED_EXEC="${2:?missing expected Exec path}"
CLI="${3:-}"
PYTHON="${PYTHON:-python3}"
TIMEOUT_SECS="${SMOKE_TIMEOUT_SECS:-90}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${DISPLAY:?需要 X 显示（用 xvfb-run 运行）}"
: "${DBUS_SESSION_BUS_ADDRESS:?需要会话总线（用 dbus-run-session 运行）}"

WORK="$(mktemp -d)"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$HOME/.config"
# 故意不用默认的 ~/.local/share，确认数据目录与扫描路径都遵守 XDG_DATA_HOME。
export XDG_DATA_HOME="$HOME/xdg-data"
export XDG_CACHE_HOME="$HOME/.cache"
unset TOKENLEDGER_APPDATA
# WebKitGTK 在没有 GPU 的虚拟显示上用合成会黑屏或崩，冒烟里关掉。
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export NO_AT_BRIDGE=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

DATA_DIR="$XDG_DATA_HOME/com.jeidorf.tokenledger"
AUTOSTART_FILE="$XDG_CONFIG_HOME/autostart/com.jeidorf.tokenledger.desktop"
TRAY_LOG="$WORK/tray-registrations.txt"
APP_LOG="$WORK/app.log"
: > "$TRAY_LOG"

# 预置一条 Claude Code 会话，时间取现在，落在「今日」。
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
mkdir -p "$HOME/.claude/projects/smoke-project"
cat > "$HOME/.claude/projects/smoke-project/session.jsonl" <<EOF
{"type":"assistant","uuid":"smoke-uuid-1","requestId":"smoke-req-1","timestamp":"$NOW","message":{"id":"smoke-msg-1","model":"claude-sonnet-4-5","usage":{"input_tokens":12,"output_tokens":34,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
EOF

WATCHER_PID=""
APP_PID=""
cleanup() {
  local status=$?
  if [ -n "$APP_PID" ]; then
    stop
  fi
  if [ -n "$WATCHER_PID" ]; then
    kill "$WATCHER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "---- app log (last 80 lines) ----" >&2
    tail -n 80 "$APP_LOG" >&2 || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

"$PYTHON" "$SCRIPT_DIR/linux-tray-watcher.py" "$TRAY_LOG" &
WATCHER_PID=$!
for _ in $(seq 1 50); do
  if gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.NameHasOwner org.kde.StatusNotifierWatcher 2>/dev/null \
    | grep -q true; then
    break
  fi
  sleep 0.2
done

# 用独立进程组启动：AppImage 的运行时会再拉起真正的程序，停的时候要整组停，
# 否则旧实例还活着，下一次启动会被单实例交给它。
launch() {
  echo "launching: $APP"
  setsid "$APP" >> "$APP_LOG" 2>&1 &
  APP_PID=$!
}

stop() {
  kill -TERM -- "-$APP_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$APP_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -- "-$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
  APP_PID=""
}

wait_for() {
  local what="$1"
  shift
  local deadline=$((SECONDS + TIMEOUT_SECS))
  until "$@"; do
    kill -0 "$APP_PID" 2>/dev/null || fail "应用在等待「$what」时退出了"
    [ "$SECONDS" -lt "$deadline" ] || fail "等「$what」超时（${TIMEOUT_SECS}s）"
    sleep 1
  done
  echo "ok: $what"
}

window_visible() {
  xdotool search --onlyvisible --name '^TokenLedger$' >/dev/null 2>&1
}
tray_registered() {
  [ -s "$TRAY_LOG" ]
}
autostart_current() {
  [ -f "$AUTOSTART_FILE" ] \
    && grep -qxF "Exec=\"$EXPECTED_EXEC\"" "$AUTOSTART_FILE"
}
scan_recorded() {
  [ -f "$DATA_DIR/tokenboard.db" ] || return 1
  local rows
  rows="$(sqlite3 -readonly "$DATA_DIR/tokenboard.db" 'SELECT COUNT(*) FROM token_logs;' 2>/dev/null || echo 0)"
  [ "${rows:-0}" -ge 1 ]
}

settings_written() {
  [ -s "$DATA_DIR/app_settings.json" ]
}

# 第一次启动：全新 HOME，确认默认设置下能起来，并让它写出完整的设置文件。
launch
wait_for "主窗口显示" window_visible
wait_for "托盘图标注册" tray_registered
wait_for "冷启动扫描记下预置会话" scan_recorded
wait_for "设置文件写入 XDG 数据目录" settings_written
[ ! -e "$AUTOSTART_FILE" ] || fail "默认设置下不应写开机自启条目"
stop

# 第二次启动：模拟保留了旧偏好但系统登记已删除，启动不能重新创建条目。
"$PYTHON" - "$DATA_DIR/app_settings.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    settings = json.load(handle)
settings["autostart_enabled"] = True
with open(path, "w", encoding="utf-8") as handle:
    json.dump(settings, handle)
PY
: > "$TRAY_LOG"
launch
wait_for "主窗口再次显示" window_visible
wait_for "托盘图标再次注册" tray_registered
[ ! -e "$AUTOSTART_FILE" ] || fail "旧自启偏好不应在启动时重新创建条目"
echo "ok: 旧自启偏好不会重新创建条目"
stop

# 第三次启动：预置已有的有效登记，确认仅刷新本应用的旧路径。
mkdir -p "$(dirname "$AUTOSTART_FILE")"
cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=TokenLedger
Exec="$WORK/previous-app"
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
chmod 600 "$AUTOSTART_FILE"
: > "$TRAY_LOG"
launch
wait_for "已有登记时主窗口显示" window_visible
wait_for "已有登记时托盘图标注册" tray_registered
wait_for "已有自启条目路径刷新" autostart_current

grep -qxF "Exec=\"$EXPECTED_EXEC\"" "$AUTOSTART_FILE" \
  || fail "自启条目的 Exec 不是 \"$EXPECTED_EXEC\"：$(grep '^Exec=' "$AUTOSTART_FILE" || true)"
grep -qx 'Type=Application' "$AUTOSTART_FILE" || fail "自启条目缺 Type=Application"
command -v desktop-file-validate >/dev/null 2>&1 \
  && desktop-file-validate "$AUTOSTART_FILE"
echo "ok: 自启条目 Exec 指向 $EXPECTED_EXEC"

[ ! -e "$HOME/.local/share/com.jeidorf.tokenledger" ] \
  || fail "数据目录写到了 ~/.local/share，没有遵守 XDG_DATA_HOME"
echo "ok: 数据目录在 XDG_DATA_HOME 下"

# 单实例：再次启动应把窗口交给已有实例并尽快退出。
SECOND_LOG="$WORK/second.log"
if ! timeout 30 "$APP" > "$SECOND_LOG" 2>&1; then
  cat "$SECOND_LOG" >&2 || true
  fail "第二次启动没有在 30 秒内交给已有实例并退出"
fi
kill -0 "$APP_PID" 2>/dev/null || fail "第二次启动后原实例退出了"
echo "ok: 单实例"

if [ -n "$CLI" ]; then
  "$CLI" version || fail "tokenledger-cli version 失败"
  USAGE_JSON="$("$CLI" usage --json)" || fail "tokenledger-cli usage --json 失败"
  echo "$USAGE_JSON" | grep -q '"command"' || fail "tokenledger-cli usage --json 输出不像 JSON 对象"
  echo "ok: tokenledger-cli 能读同一个数据目录"
fi

if grep -Eiq 'panicked at|segmentation fault' "$APP_LOG"; then
  fail "应用日志里有 panic 或段错误"
fi

echo "Linux smoke passed"
