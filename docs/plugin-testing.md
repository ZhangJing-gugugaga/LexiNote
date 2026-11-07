# 插件测试

- **离线门禁**：`scripts/tests/` 全量（`LEXI_TYPESCRIPT=<ts 路径> node scripts/tests/<name>.cjs`）；
  总闸 `tools/plugin-dist/release-gate.cjs --ci`（24 步）。
- **兼容梯队**：真实插件夹具（Calendar/Outliner/Tasks/Minimal）按 C0-C4 等级验收
  （`plugin-tasks-compat --ladder` 等）。
- **分发回归**：`plugin-dist-regression`（安装→升级→回滚→卸载状态机，假/真文件系统双轨）。
- **SDK 冒烟**：`packages/lexinote-plugin-sdk/tests/sdk-smoke.cjs`。
- **设备批次**：真机沙箱 PoC / Tasks L6 / 市场规模 UI 归设备轮（见 known_issues 账本）。
