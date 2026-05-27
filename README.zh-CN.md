# devflow-live2d

**语言:** [English](README.md) | 简体中文 | [日本語](README.ja.md)

![Devflow Live2D desktop overlay demo](docs/demo.png)

`devflow-live2d` 是 Devflow 的 macOS Live2D 桌面悬浮窗客户端。它运行在 Electron 中，负责把 `devflow-protocol` 的运行事件转换成桌宠的状态、动作、表情和气泡文本。

## 功能

- macOS 桌面悬浮窗与托盘菜单
- Live2D 官方运行时适配与兜底渲染路径
- 多模型目录，目前内置 `nito-runtime` 模型组
- 协议事件到模型动作、表情、情绪和气泡样式的映射
- Codex bridge：读取 `~/.codex/sessions/**/rollout-*.jsonl` 并转发到本地协议服务
- Claude 全局 `devflow-protocol` 插件的安装与卸载入口
- 可选 AI 闲聊台词，API key 只保存在主进程侧

## 项目边界

本仓库只负责桌面客户端和 Live2D 展示层，不负责：

- 原始 Claude/Codex 事件解析
- 共享协议的存储、摄取和服务实现
- pixel-office 的角色和世界逻辑

## 环境要求

- macOS
- Node.js 与 npm
- `python3`，用于 Codex bridge
- 打包时需要相邻目录 `../devflow-protocol-go`，且其中已存在 `bin/devflow-protocol` 和 `claude-plugin/`

## 安装与开发

```bash
npm install
npm run dev
```

常用脚本：

```bash
npm run doctor
npm test
npm run dist:mac
```

- `npm run doctor` 检查 Live2D manifest、adapter、默认模型 JSON 和官方运行时资源。
- `npm test` 检查主要 JavaScript 文件语法，并运行 Bun 测试。
- `npm run dist:mac` 先准备内置协议资源，再通过 `electron-builder` 输出 macOS `dmg` 和 `zip`。

## 本地协议服务

协议服务仓库：[weirwei/devflow-protocol-go](https://github.com/weirwei/devflow-protocol-go)

默认协议地址是：

```text
http://127.0.0.1:4317
```

可以通过环境变量覆盖：

```bash
DEVFLOW_PROTOCOL_URL=http://127.0.0.1:4317 npm run dev
```

打包后的应用会从应用资源中启动内置的 `devflow-protocol-go`。托盘菜单可以启动或停止 Codex bridge。bridge 会从已保存的读取位置继续监听新的 Codex rollout 活动，启动时不会回放最近历史。

## 打包

```bash
npm install
npm run dist:mac
```

打包前会运行 `scripts/prepare-bundle-resources.mjs`，把相邻仓库 `../devflow-protocol-go` 的协议二进制和 `claude-plugin` 复制到：

```text
build-resources/bundle/devflow-protocol-go
```

如果协议仓库位置或构建产物不完整，打包步骤会失败。请先在 `devflow-protocol-go` 仓库中构建 `bin/devflow-protocol`。

## AI 闲聊配置

AI 闲聊配置文件位于：

```text
~/.devflow/live2d/config.json
```

示例：

```json
{
  "personaDialogue": {
    "enabled": true,
    "apiKey": "YOUR_API_KEY",
    "model": "gpt-5-mini",
    "apiUrl": "https://api.openai.com/v1/chat/completions",
    "timeoutMs": 8000
  }
}
```

也可以通过环境变量提供默认值：

```bash
DEVFLOW_DIALOGUE_API_KEY=YOUR_API_KEY \
DEVFLOW_DIALOGUE_MODEL=gpt-5-mini \
npm run dev
```

相关环境变量：

- `DEVFLOW_DIALOGUE_API_KEY`
- `DEVFLOW_DIALOGUE_API_URL`
- `DEVFLOW_DIALOGUE_MODEL`
- `DEVFLOW_DIALOGUE_TIMEOUT_MS`

托盘菜单中的 `AI 闲聊` 会读取并更新同一个配置文件。API key 不会暴露给 renderer。

## Live2D 模型

当前模型配置入口在 `src/live2d-model-catalog.js` 的 `LIVE2D_MODEL_CONFIG_PATHS`。内置模型文件位于：

```text
assets/live2d/models/nito-runtime/
```

内置的 `nito-runtime` 模型组来源于 Live2D Creative Studio 官方的 Nito 示例模型：

- 来源：[にと | WORKS | Live2D Creative Studio](https://www.live2dcs.jp/works/nito/)
- 作者：Live2D inc.

每个 `*.live2d.json` 可以配置：

- 默认动作、表情、情绪和保持时间
- 协议事件行为，例如 `request.created`、`assistant.message`、`tool.started`
- 本地运行时状态行为，例如 `connected`、`disconnect`、`error`
- 模型布局、运行时资源路径和交互元数据

修改模型或动作分组后建议运行：

```bash
npm run doctor
npm test
```

## 目录结构

```text
.
  main.js                         Electron 主进程、托盘菜单和服务编排
  preload.js                      renderer 安全桥接
  ui/                             桌面悬浮窗页面
  src/app/                        应用状态与本地服务运行时
  src/dialogue/                   桌宠气泡和 AI 闲聊逻辑
  src/avatar/                     头像状态与打断策略
  src/event-mapping/              协议事件归一化
  assets/live2d/                  Live2D manifest、adapter 和模型资源
  scripts/                        打包准备、资源检查和 SDK 导入脚本
  tests/                          行为映射和对话逻辑测试
```
