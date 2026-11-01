---
name: harmonyos-dev
description: Build, run, inspect, and lightly automate HarmonyOS apps with the harmonyos-emulator MCP tools (hdc backend, local emulator or USB device).
---

# HarmonyOS Dev

Use this skill when the user wants you to build, run, debug, screenshot, or inspect a HarmonyOS (ArkTS/.ets) app on the local Device Emulator (`127.0.0.1:5555`) or a USB-connected HarmonyOS device.

## Tool Names

MCP server is configured as `harmonyos_emulator`; tools appear as `mcp__harmonyos_emulator__<tool>`.

## Default Workflow

1. Call `mcp__harmonyos_emulator__harmony_preflight` first.
   - Missing toolchain: install commandline-tools to `E:\dev-tools\harmonyos\command-line-tools` (see project `scripts/device/install-commandline-tools.ps1`); do not improvise unrelated installs.
   - Missing emulator target is NOT a blocker for USB device work; missing hdc blocks everything.
2. Build with `mcp__harmonyos_emulator__harmony_build` (debug first). Read the returned output for compile errors; fix code, rebuild.
3. Deploy with `mcp__harmonyos_emulator__harmony_install_launch` (defaults to emulator target). For a USB device pass its serial from `harmony_list_targets`.
   - The emulator accepts unsigned HAPs; real devices require signed HAPs (AGC debug certificate).
4. Verify visually with `mcp__harmonyos_emulator__harmony_screenshot` (writes `exports/lexi-shot-*.jpeg`).
5. Runtime checks: `harmony_logs` (hilog filtered to lexinote/ArkWeb/jscrash), `harmony_terminate_app`.
6. UI automation: `harmony_ui_dump` returns the ArkUI control tree JSON (`exports/lexi-ui.json`); use it to plan taps before sending touch events.

## Notes

- The emulator exposes itself as hdc TCP target `127.0.0.1:5555`; start it from Device Emulator tooling, then `harmony_emulator_connect`.
- Emulator system images and the emulator runtime are installed via `sdkmgr` inside command-line-tools (Huawei account login required once).
- Real devices: developer mode + USB debugging; unsigned HAP install will fail on real devices.
- Keep interactions through MCP tools instead of raw hdc unless a tool does not cover the operation.
