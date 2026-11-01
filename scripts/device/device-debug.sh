#!/bin/bash
# LexiNote real-device debug loop (HarmonyOS hdc backend).
# Maps the android-emulator plugin's public operations onto hdc:
#   preflight / list targets / build / install / launch / logs / ui dump / screenshot.
# Usage:
#   bash scripts/device/device-debug.sh preflight
#   bash scripts/device/device-debug.sh build
#   bash scripts/device/device-debug.sh install [deviceSerial]
#   bash scripts/device/device-debug.sh run    [deviceSerial]   # install + launch
#   bash scripts/device/device-debug.sh logs   [deviceSerial]   # follow filtered hilog
#   bash scripts/device/device-debug.sh dump   [deviceSerial]   # uitest uiDump -> stdout
#   bash scripts/device/device-debug.sh shot   [deviceSerial]   # screenshot -> ./exports/
set -uo pipefail
cd "$(dirname "$0")/../.."

BUNDLE="com.lovexjy.lexinote"
ABILITY="EntryAbility"
HAP_DIR="entry/build/default/outputs/default"

# --- locate toolchain -------------------------------------------------------
find_hdc() {
  if [ -n "${HDC_HOME:-}" ] && [ -x "$HDC_HOME/hdc.exe" ]; then echo "$HDC_HOME/hdc.exe"; return; fi
  local candidates=(
    "/e/dev-tools/harmonyos/command-line-tools/sdk/default/openharmony/toolchains/hdc.exe"
    "/e/dev-tools/harmonyos/command-line-tools/bin/hdc.exe"
    "/c/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
    "/d/Program Files/Huawei/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe"
  )
  # command-line-tools and SDK roots may nest toolchains deeper
  local hit
  hit=$(find "/e/dev-tools/harmonyos" "/c/Program Files/Huawei" "/d/Program Files/Huawei" "$LOCALAPPDATA/Huawei" "$HOME/AppData/Local/Huawei" \
    /e/dev-tools /e/tools -maxdepth 7 -name "hdc.exe" 2>/dev/null | head -1)
  if [ -n "$hit" ]; then echo "$hit"; return; fi
  for c in "${candidates[@]}"; do [ -x "$c" ] && { echo "$c"; return; }; done
  command -v hdc 2>/dev/null
}

find_hvigor() {
  # command-line-tools layout first, then DevEco's bundled hvigor + node
  local clt="/e/dev-tools/harmonyos/command-line-tools"
  if [ -f "$clt/bin/hvigorw.bat" ]; then
    echo "cmd:$clt/bin/hvigorw.bat"; return
  fi
  if [ -f "$clt/bin/hvigorw.js" ] && [ -x "$clt/tool/node/node.exe" ]; then
    echo "$clt/tool/node/node.exe $clt/bin/hvigorw.js"; return
  fi
  local deveco="/c/Program Files/Huawei/DevEco Studio"
  [ -d "/d/Program Files/Huawei/DevEco Studio" ] && deveco="/d/Program Files/Huawei/DevEco Studio"
  local node="$deveco/tools/node/node.exe"
  local hvigorw="$deveco/tools/hvigor/bin/hvigorw.js"
  [ -x "$node" ] && [ -f "$hvigorw" ] && { echo "$node $hvigorw"; return; }
  command -v hvigorw >/dev/null 2>&1 && { echo "hvigorw"; return; }
  echo ""
}

HDC="$(find_hdc | head -1)"
SERIAL="${2:-}"

hdc_cmd() {
  if [ -n "$SERIAL" ]; then "$HDC" -t "$SERIAL" "$@"; else "$HDC" "$@"; fi
}

case "${1:-preflight}" in
  preflight)
    echo "hdc: ${HDC:-NOT FOUND}"
    if [ -n "$HDC" ]; then
      "$HDC" list targets
    fi
    echo "hvigor: $(find_hvigor || echo 'NOT FOUND')"
    echo "signed build-profile: $([ -f build-profile.json5 ] && echo present || echo MISSING)"
    echo "built hap: $(ls "$HAP_DIR"/*.hap 2>/dev/null | head -1 || echo none)"
    ;;
  build)
    HV="$(find_hvigor)"
    [ -z "$HV" ] && { echo "hvigor 不可用:需安装 command-line-tools 或 DevEco Studio"; exit 1; }
    if [ -d "/e/dev-tools/harmonyos/command-line-tools/sdk" ]; then
      export DEVECO_SDK_HOME="E:\\dev-tools\\harmonyos\\command-line-tools\\sdk"
    else
      deveco="/c/Program Files/Huawei/DevEco Studio"
      [ -d "/d/Program Files/Huawei/DevEco Studio" ] && deveco="/d/Program Files/Huawei/DevEco Studio"
      export DEVECO_SDK_HOME="$(cygpath -w "$deveco/sdk")"
    fi
    # shellcheck disable=SC2086
    $HV --mode module -p product=default -p module=entry@default -p buildMode=release assembleHap --no-daemon
    ;;
  install)
    [ -z "$HDC" ] && { echo "hdc 不可用"; exit 1; }
    HAP=$(ls "$HAP_DIR"/*.hap 2>/dev/null | head -1)
    [ -z "$HAP" ] && { echo "未找到 HAP,请先 build"; exit 1; }
    hdc_cmd install -r "$HAP"
    ;;
  run)
    [ -z "$HDC" ] && { echo "hdc 不可用"; exit 1; }
    "$0" install "$SERIAL" && hdc_cmd shell aa start -a "$ABILITY" -b "$BUNDLE"
    ;;
  logs)
    [ -z "$HDC" ] && { echo "hdc 不可用"; exit 1; }
    hdc_cmd shell "hilog | grep -iE 'lexinote|ArkWeb|JsVm|jscrash|cppcrash'"
    ;;
  dump)
    [ -z "$HDC" ] && { echo "hdc 不可用"; exit 1; }
    hdc_cmd shell uitest uiDump /data/local/tmp/lexi-ui.json >/dev/null 2>&1
    hdc_cmd file recv /data/local/tmp/lexi-ui.json ./exports/lexi-ui.json
    cat ./exports/lexi-ui.json
    ;;
  shot)
    [ -z "$HDC" ] && { echo "hdc 不可用"; exit 1; }
    mkdir -p exports
    hdc_cmd shell snapshot_display -f /data/local/tmp/lexi-shot.jpeg >/dev/null 2>&1
    hdc_cmd file recv /data/local/tmp/lexi-shot.jpeg ./exports/lexi-shot-$(date +%H%M%S).jpeg
    ls exports/lexi-shot-*.jpeg | tail -1
    ;;
  *) echo "unknown op: $1"; exit 2 ;;
esac
