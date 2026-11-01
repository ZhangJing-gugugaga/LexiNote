# HarmonyOS Emulator Plugin (local, LexiNote project)

为 ZCode 提供鸿蒙真机/模拟器调试工作流(hdc 后端)。结构仿照官方 `android-emulator` 插件:MCP 工具 + 技能 + 斜杠命令。

## 工具

`harmony_preflight` / `harmony_list_targets` / `harmony_build` / `harmony_install_launch` / `harmony_screenshot` / `harmony_logs` / `harmony_ui_dump` / `harmony_terminate_app` / `harmony_emulator_connect`

## 依赖

- HarmonyOS command-line-tools 安装于 `E:\dev-tools\harmonyos\command-line-tools`(见 `scripts/device/install-commandline-tools.ps1`)
- 模拟器系统镜像经 `sdkmgr` 下载(需华为账号登录一次)
- Node.js(系统 PATH 或 `C:\Program Files\nodejs\node.exe`)

## 安装

见 `docs/lexinote_plugin_base_implementation_notes.md` §五:缓存目录 `~/.zcode/cli/plugins/cache/lexinote-local/harmonyos-emulator/0.1.0`,`installed_plugins.json` 登记 + `config.json` 启用 `harmonyos-emulator@lexinote-local`。
