#!/bin/zsh
set -euo pipefail
cd "${0:A:h:h}"
DEVECO_APP_PATH="${DEVECO_APP_PATH:-/Applications/DevEco-Studio.app}"
export JAVA_HOME="$DEVECO_APP_PATH/Contents/jbr/Contents/Home"
export DEVECO_SDK_HOME="$DEVECO_APP_PATH/Contents/sdk"
"$DEVECO_APP_PATH/Contents/tools/node/bin/node" "$DEVECO_APP_PATH/Contents/tools/hvigor/bin/hvigorw.js" --mode module -p product=default -p module=entry@default -p buildMode=debug assembleHap --no-daemon
