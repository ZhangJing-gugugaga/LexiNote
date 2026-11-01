# 知萤 LexiNote

知萤是一款面向 HarmonyOS 的本地笔记应用，使用 ArkTS 和 ArkUI 构建。它把 Markdown 写作、知识连接与可视化整理放在同一个工作空间中，适配手机、平板和二合一设备。

## 功能

- **记录与写作**：快速记录、Markdown 编辑和预览、代码块、每日笔记与模板。
- **组织知识**：知识库、工作区和文件夹、标签与搜索，支持双向链接、反向链接和关系图谱。
- **可视化整理**：思维导图与基础白板，可引用笔记并导出相关数据。
- **数据管理**：Markdown 导入与导出、JSON 备份和恢复、回收站。
- **系统集成**：桌面服务卡片、系统分享剪藏、单篇编辑状态跨设备接续。
- **本地辅助**：支持设备离线能力时可使用中文语音识别和本地整理；具体能力取决于设备及其离线服务。

笔记和索引保存在本机，无需账号。跨设备接续传递的是单篇编辑状态，不是整个工作区的云同步。建议定期导出备份；使用外部文件夹前请了解系统的文件授权要求。

## 开发环境

- DevEco Studio，以及 HarmonyOS SDK **26.0.0**（工程的 target 和 compatible SDK 版本）。
- 支持 HarmonyOS 的手机、平板或二合一设备，或相应模拟器。
- 安装项目依赖需要 DevEco Studio 自带的 OHPM；运行回归脚本需要 Node.js 和 TypeScript。

## 构建与运行

1. 克隆仓库，复制公开构建配置：

   ```sh
   git clone https://github.com/peryixing-lab/LexiNote.git
   cd LexiNote
   cp build-profile.example.json5 build-profile.json5
   ```

2. 用 DevEco Studio 打开项目，安装或同步 OHPM 依赖，并确保已安装 HarmonyOS SDK 26.0.0。
3. 在 **File → Project Structure → Signing Configs** 中为本机配置签名，再选择设备或模拟器运行。未配置签名时可构建未签名包，但安装到设备需要有效签名。

`build-profile.json5`、`local.properties`、证书和密钥均被忽略。请不要将本机签名信息提交到仓库。仓库中的 `build-profile.example.json5` 不含签名信息，需要变更共享构建选项时也请同步更新模板。

安装了 DevEco CLI 的开发者也可以在项目目录运行 `devecocli build` 或 `devecocli run`。macOS 上的 `scripts/build.sh` 使用默认位置的 DevEco Studio；可通过 `DEVECO_APP_PATH` 指定其他安装路径。

## 回归检查

核心回归脚本会转译并运行非 UI 的 ArkTS 代码，使用模拟的文件系统和数据库，不替代真机或模拟器测试。例如，在 macOS 的默认 DevEco Studio 安装位置：

```sh
/Applications/DevEco-Studio.app/Contents/tools/node/bin/node scripts/tests/core-regression.cjs
/Applications/DevEco-Studio.app/Contents/tools/node/bin/node scripts/tests/markdown-110-regression.cjs
```

多数脚本支持通过 `LEXI_TYPESCRIPT` 指定 TypeScript 模块路径；部分脚本目前仍使用上述默认安装路径。其他回归脚本见 `scripts/tests/`。

## 项目结构

```text
AppScope/                    应用元信息与图标
entry/src/main/ets/          ArkUI 页面、组件与核心逻辑
entry/src/main/resources/    应用资源
entry/src/test/              单元测试
entry/src/ohosTest/          设备测试
scripts/tests/               Node.js 回归脚本
build-profile.example.json5  不含本地签名的构建配置模板
```

## 参与贡献

欢迎通过 Issue 反馈问题或提出建议，也欢迎提交 Pull Request。提交前请说明测试环境和验证方式；界面改动可附截图。请勿提交个人笔记、设备日志、签名材料或其他敏感信息。

## 许可证

本项目采用 [GNU General Public License v3.0](LICENSE)。
