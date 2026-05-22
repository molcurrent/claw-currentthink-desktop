# Claw Currentthink 中文版

Claw Currentthink 中文版是一款内置 Claw Code 运行时的桌面编程助手。安装后即可发起新对话、续聊已有任务、管理本地工作区记录，并通过可配置的 OpenAI-compatible 路由接入不同模型服务。

它面向中文用户做了默认体验整理：中文界面、中文设置项、内置 `claw` 二进制、任务历史持久化、归档会话、token 统计、文件附件、工作树分支和本地日志都在一个 Electron 桌面应用里完成。

## 安装

### macOS：Homebrew

```bash
brew tap molcurrent/claw-currentthink
brew install --cask claw-currentthink
```

### GitHub Release

从发布页下载对应平台安装包：

<https://github.com/molcurrent/claw-currentthink-desktop/releases>

- macOS：`.dmg` 或 `.zip`
- Linux：`.AppImage` 或 `.deb`
- Windows：`.exe`

## 开箱即用

- Release 包已内置 Claw Code，不需要单独安装 `claw`。
- 默认使用内置运行时；如需使用自己的 CLI，可在设置中覆盖 `claw` 路径。
- API Key 保存在本机安全存储中，任务记录保存在本机应用数据目录。
- macOS 的持久 REPL 模式使用系统自带 `/usr/bin/expect`。

## 开发

```bash
npm install
npm run dev
```

构建前端：

```bash
npm run build
```

打包当前平台：

```bash
npm run dist
```

按平台打包：

```bash
npm run dist:mac
npm run dist:linux
npm run dist:win
```

打包命令会先编译 vendored Rust `claw`，再生成 Electron 安装包。推送 `v0.1.0` 这类 tag 后，GitHub Actions 会自动构建 macOS、Linux 和 Windows 发行产物。

## 代码结构

- `src/App.tsx`：主界面、侧边栏、任务会话、设置与续聊输入框
- `src/lib/desktopApi.ts`：前端 IPC 入口和浏览器预览 fallback
- `src/lib/tokenCounter.ts`：token 统计与成本估算
- `src/types/electron.d.ts`：前后端类型定义
- `electron/main.cjs`：任务数据库、偏好设置、持久化、任务执行和输出清洗
- `electron/claw-repl.expect`：macOS REPL 启动脚本
- `scripts/build-bundled-claw.cjs`：编译内置 Claw Code CLI
- `scripts/after-pack.cjs`：macOS universal 包的内置 CLI 合并处理
- `vendor/claw-code/rust/`：内置 Claw Code Rust 工作区
- `release/`：本地打包产物，默认不提交

## 鸣谢

特别鸣谢 [haocenchen](https://github.com/haocenchen)。

## 许可证

MIT
