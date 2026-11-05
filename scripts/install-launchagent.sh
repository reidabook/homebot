#!/bin/zsh
# Installs a LaunchAgent for the CURRENT macOS user (run it while logged in as homebot).
# Starts at login, restarts on crash.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(realpath "$(command -v node)")"
LABEL=com.homebot.agent
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=$DIR/.env</string>
    <string>$DIR/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/logs/agent.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/agent.log</string>
</dict>
</plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrapping too early fails with "Input/output error".
for _ in {1..40}; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL. Node binary needing Full Disk Access: $NODE"
echo "Logs: tail -f $DIR/logs/agent.log"
