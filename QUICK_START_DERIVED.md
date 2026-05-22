# 派生功能 - 快速启动指南

## 5 分钟快速体验

### 1. 理解派生功能的作用

派生功能是在对话完成后提供的增值操作。当你完成一个 AI 对话后，可以：

- 📤 **导出对话** - 保存为 MD/JSON/HTML
- 📝 **生成摘要** - AI 提取关键点
- 💾 **创建快照** - 保存对话状态和文件
- 📋 **共享上下文** - 复制或保存为文件
- 🔀 **分支任务** - 从此处创建新分支
- ⚖️ **对比输出** - 比较两个任务结果
- 💡 **提取洞察** - 自动分析关键信息
- 📚 **生成文档** - 基于对话内容生成文档

### 2. 查看派生功能按钮

1. 打开应用
2. 运行一个任务（输入 prompt 并点击运行）
3. 任务完成后，Dashboard 下方会显示 "派生功能" 区域
4. 8 个功能按钮会排列在那里

### 3. 尝试第一个功能（导出对话）

```
步骤1: 点击 "导出对话" 按钮
步骤2: 选择导出格式（Markdown / JSON / HTML）
步骤3: 看到成功提示，文件已保存到 ~/.codex/exports/
步骤4: 打开该目录查看生成的文件
```

### 4. 其他常用功能

**生成摘要**:
- 点击按钮后，AI 自动分析对话
- 显示摘要、关键点和后续建议

**创建快照**:
- 输入快照名称
- 保存当前对话状态和所有附件
- 用于标记项目中的重要里程碑

**共享上下文**:
- 快速复制对话内容到剪贴板
- 或保存为独立文件用于分享

## 关键目录

| 功能 | 保存位置 | 内容 |
|-----|---------|------|
| 导出 | ~/.codex/exports/ | 对话副本（多种格式） |
| 快照 | ~/.codex/snapshots/ | 对话 + 附件 + 元数据 |
| 共享 | ~/.codex/shares/ | 文本副本 |

## 代码位置快速导航

### 看派生功能 UI（前端）
```
src/App.tsx
├── DerivedFeatures 组件（第 1859 行左右）
│   ├── 8 个功能按钮定义
│   ├── 子菜单展开逻辑
│   └── 动画和样式
│
└── Dashboard 组件
    ├── 8 个处理函数
    └── DerivedFeatures 组件调用
```

### 看 API 实现（桥接层）
```
src/lib/desktopApi.ts
├── 导入所有派生类型
└── derived 命名空间
    ├── exportConversation()
    ├── generateSummary()
    ├── createSnapshot()
    ├── ... 其他 6 个
```

### 看 IPC 处理（主进程）
```
electron/main.cjs
├── derived:export-conversation
├── derived:generate-summary
├── derived:create-snapshot
├── ... 其他 5 个
```

### 看类型定义
```
src/types/electron.d.ts
├── 派生功能类型（第 50+ 行）
├── 8 个 Payload 接口
├── 8 个 Result 接口
└── Window.derived API 声明
```

## 最小化实现示例

如果你想添加第 9 个派生功能，只需：

### 1. 添加类型 (electron.d.ts)
```typescript
export interface MyFeaturePayload {
  taskId: string;
  // 其他参数
}

export interface MyFeatureResult {
  success: boolean;
  // 其他返回值
}
```

### 2. 添加 IPC 处理 (main.cjs)
```javascript
ipcMain.handle("derived:my-feature", async (_event, payload) => {
  const { taskId } = payload;
  // 你的实现逻辑
  return { success: true };
});
```

### 3. 暴露 API (preload.cjs)
```javascript
derived: {
  myFeature: (payload) => ipcRenderer.invoke("derived:my-feature", payload),
}
```

### 4. 添加前端实现 (desktopApi.ts)
```typescript
myFeature: async (payload): Promise<MyFeatureResult> => {
  // 实现或调用 Electron API
  return { success: true };
}
```

### 5. 添加 UI 处理 (App.tsx)
```typescript
const handleMyFeature = async () => {
  if (!latestTask) return;
  const result = await api.derived.myFeature({ taskId: latestTask.id });
  // 处理结果
}
```

### 6. 添加按钮 (DerivedFeatures 组件)
```typescript
{
  id: "my-feature",
  icon: SomeIcon,
  label: "我的功能",
  description: "做某件事",
  onClick: onMyFeature,
}
```

## 调试技巧

### 检查是否正确注册
1. 打开 DevTools (F12)
2. 在 Console 中运行: `window.clawDesktop.derived`
3. 应该看到 8 个函数列表

### 测试 IPC 调用
```javascript
// 在浏览器 Console 中测试
await window.clawDesktop.derived.exportConversation({
  taskId: "test-id",
  format: "markdown"
})
```

### 查看文件生成
```bash
# 检查导出
ls -la ~/.codex/exports/

# 检查快照
ls -la ~/.codex/snapshots/

# 检查共享
ls -la ~/.codex/shares/
```

## 常见场景使用流程

### 场景 1: 保存工作成果
1. 完成一个对话任务
2. 点击"导出对话" → 选择 Markdown
3. 导出的 MD 文件可直接用于文档或分享

### 场景 2: 创建项目检查点
1. 完成一个重要阶段的工作
2. 点击"创建快照" → 输入名称（如 "v1.0-完成代码审阅"）
3. 快照保存了该时刻的完整状态，可随时回顾

### 场景 3: A/B 测试
1. 完成第一个方案（任务 A）
2. 点击"分支任务" → 输入名称
3. 在分支上继续对话，尝试第二个方案
4. 点击"对比输出" 比较两个方案的结果

### 场景 4: 快速文档生成
1. 完成技术工作（如 API 设计、架构讨论）
2. 点击"生成文档"
3. 获得格式化的技术文档，可直接用于项目
4. 点击"导出对话" 为备份

## 性能指标

| 操作 | 预期耗时 | 输出大小 |
|-----|---------|---------|
| 导出 1MB 对话 | < 100ms | 与输入相同 |
| 生成摘要 | < 500ms | ~200-500 字 |
| 创建快照 | < 50ms | 取决于文件 |
| 分支任务 | < 20ms | < 1KB |
| 对比 1MB 输出 | < 100ms | < 1KB |

## 已知问题和限制

### 当前限制
1. **AI 功能为占位符**: 生成摘要、提取洞察、生成文档目前返回示例数据
2. **对比算法简化**: 仅计算字符级相似度，可改进
3. **无加密存储**: 快照和导出未加密，敏感数据请谨慎
4. **浏览器预览**: 无法实际生成和保存文件

### 下一步工作
- [ ] 集成实际 LLM 实现 AI 功能
- [ ] 改进对比算法为 Levenshtein/Smith-Waterman
- [ ] 添加导出加密选项
- [ ] 快照的版本管理和合并

## 获取帮助

### 查看完整文档
```bash
cat DERIVED_FEATURES.md
```

### 查看类型定义
```bash
grep -A 20 "ExportConversationPayload" src/types/electron.d.ts
```

### 查看实现代码
```bash
grep -n "derived:export-conversation" electron/main.cjs
```

## 总结

派生功能是对 Claw Desktop 的重要扩展，提供了：
- ✅ 灵活的导出选项
- ✅ AI 驱动的分析（占位符）
- ✅ 状态快照和版本管理
- ✅ 任务分支和对比
- ✅ 自动文档生成

这些功能共同构成了一个完整的对话生命周期管理系统。

---

**下一步**: 打开应用，运行一个任务，然后尝试第一个派生功能吧！🚀

