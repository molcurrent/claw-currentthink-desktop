# Claw Desktop - 派生功能实现指南

## 概述

派生功能（Derived Features）是在对话和任务的基础上提供的一系列增值操作。这些功能让用户能够基于已有的任务输出进行衍生操作，包括导出、总结、快照等。

## 已实现的派生功能

### 1. 导出对话 (Export Conversation)

**功能描述**: 将对话记录导出为多种格式

**支持格式**:
- **Markdown** (.md): 易于阅读和分享的格式
- **JSON** (.json): 结构化数据格式，便于程序处理
- **HTML** (.html): 可在浏览器中直接查看

**实现位置**:
- 后端: `electron/main.cjs` - `derived:export-conversation` IPC 处理程序
- 前端: `src/App.tsx` - `handleExportConversation()` 函数
- API: `src/lib/desktopApi.ts` - `derived.exportConversation()` 方法

**文件保存位置**: `~/.codex/exports/`

**使用场景**:
- 将对话保存为文档
- 分享给团队成员
- 归档重要的工作记录

### 2. 生成摘要 (Generate Summary)

**功能描述**: 使用 AI 自动生成对话的关键摘要

**输出内容**:
- 摘要文本
- 关键点列表
- 建议的后续步骤

**实现位置**:
- 后端: `electron/main.cjs` - `derived:generate-summary` IPC 处理程序
- 前端: `src/App.tsx` - `handleGenerateSummary()` 函数
- API: `src/lib/desktopApi.ts` - `derived.generateSummary()` 方法

**使用场景**:
- 快速了解长对话的核心内容
- 生成会议记录摘要
- 创建知识库条目

### 3. 创建快照 (Create Snapshot)

**功能描述**: 保存当前对话状态和相关文件的快照

**快照包含**:
- 任务元数据 (prompt, status, output)
- 关联文件 (可选)
- 时间戳和描述

**实现位置**:
- 后端: `electron/main.cjs` - `derived:create-snapshot` IPC 处理程序
- 前端: `src/App.tsx` - `handleCreateSnapshot()` 函数
- API: `src/lib/desktopApi.ts` - `derived.createSnapshot()` 方法

**快照存储位置**: `~/.codex/snapshots/{snapshotId}/`

**使用场景**:
- 保存工作进度检查点
- 为追溯性创建历史备份
- 在大型项目中标记关键节点

### 4. 共享上下文 (Share Context)

**功能描述**: 快速分享对话内容给其他工具或人员

**分享方式**:
- **剪贴板** (Clipboard): 复制到系统剪贴板
- **文件** (File): 保存为文本文件，位置 `~/.codex/shares/`

**实现位置**:
- 后端: `electron/main.cjs` - `derived:share-context` IPC 处理程序
- 前端: `src/App.tsx` - `handleShareContext()` 函数
- API: `src/lib/desktopApi.ts` - `derived.shareContext()` 方法

**使用场景**:
- 向团队分享工作成果
- 粘贴到邮件或文档
- 跨应用共享内容

### 5. 分支任务 (Branch Task)

**功能描述**: 从当前对话创建新的独立分支进行并行探索

**分支特性**:
- 保留原对话的所有内容
- 创建独立的会话 ID
- 支持独立的后续对话

**实现位置**:
- 后端: `electron/main.cjs` - `derived:branch-task` IPC 处理程序
- 前端: `src/App.tsx` - `handleBranchTask()` 函数
- API: `src/lib/desktopApi.ts` - `derived.branchTask()` 方法

**使用场景**:
- A/B 测试不同的方案
- 基于相同输入尝试不同策略
- 并行探索多个方向

### 6. 对比输出 (Compare Outputs)

**功能描述**: 比较两个任务的输出差异和相似度

**对比维度**:
- 相似度评分 (0-100%)
- 相同内容高亮
- 差异摘要

**实现位置**:
- 后端: `electron/main.cjs` - `derived:compare-outputs` IPC 处理程序
- 前端: `src/App.tsx` - `handleCompareOutputs()` 函数
- API: `src/lib/desktopApi.ts` - `derived.compareOutputs()` 方法

**使用场景**:
- 验证不同模型的输出一致性
- 评估参数变更的影响
- 质量对比和回归检测

### 7. 提取洞察 (Extract Insights)

**功能描述**: 自动分析对话内容，提取关键信息和模式

**提取内容**:
- 关键发现
- 技术细节
- 错误和警告
- 建议和模式

**实现位置**:
- 后端: `electron/main.cjs` - `derived:extract-insights` IPC 处理程序
- 前端: `src/App.tsx` - `handleExtractInsights()` 函数
- API: `src/lib/desktopApi.ts` - `derived.extractInsights()` 方法

**使用场景**:
- 快速了解问题根本原因
- 提取可操作的建议
- 生成问题分类

### 8. 生成文档 (Generate Documentation)

**功能描述**: 基于任务输出自动生成格式化文档

**文档样式**:
- **Technical**: 技术文档风格，适合开发者
- **User-friendly**: 用户友好风格，适合非技术人员
- **Minimal**: 极简风格，仅保留要点

**实现位置**:
- 后端: `electron/main.cjs` - `derived:generate-documentation` IPC 处理程序
- 前端: `src/App.tsx` - `handleGenerateDocumentation()` 函数
- API: `src/lib/desktopApi.ts` - `derived.generateDocumentation()` 方法

**支持格式**:
- Markdown (.md)
- HTML (.html)

**使用场景**:
- 为项目生成自动文档
- 创建用户指南
- 生成 API 文档

## 架构设计

### 分层架构

```
┌─────────────────────────────────────────┐
│           React UI 层 (App.tsx)         │
│  ┌─────────────────────────────────┐    │
│  │   DerivedFeatures 组件          │    │
│  │   - 8 个派生操作按钮            │    │
│  │   - 子菜单展开                  │    │
│  │   - 错误处理与反馈              │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
           ↓ Promise 调用
┌─────────────────────────────────────────┐
│       Desktop API 层 (desktopApi.ts)    │
│  ┌─────────────────────────────────┐    │
│  │   derived 命名空间              │    │
│  │   - 8 个 async 方法             │    │
│  │   - 前端/浏览器预览实现         │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
        ↓ IPC 调用 (Electron)
┌─────────────────────────────────────────┐
│       Preload Bridge (preload.cjs)      │
│  ┌─────────────────────────────────┐    │
│  │   derived 命名空间              │    │
│  │   - 8 个 IPC 代理               │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
        ↓ IPC 调用 (Main Process)
┌─────────────────────────────────────────┐
│      Main Process (main.cjs)            │
│  ┌─────────────────────────────────┐    │
│  │   derived IPC 处理程序          │    │
│  │   - 导出到文件系统              │    │
│  │   - 数据处理与转换              │    │
│  │   - 错误处理                    │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
         ↓ 文件操作
┌─────────────────────────────────────────┐
│       文件系统存储                      │
│   ~/.codex/exports/                     │
│   ~/.codex/snapshots/                   │
│   ~/.codex/shares/                      │
└─────────────────────────────────────────┘
```

### 类型安全

所有派生功能都有完整的 TypeScript 类型定义:

```typescript
// electron.d.ts 中定义的接口
- ExportConversationPayload / Result
- GenerateSummaryPayload / Result
- CreateSnapshotPayload / Result
- ShareContextPayload / Result
- BranchTaskPayload / Result
- CompareOutputsPayload / Result
- ExtractInsightsPayload / Result
- GenerateDocumentationPayload / Result
```

## 使用指南

### 用户操作流程

1. **运行任务** - 用户在 Dashboard 中输入 prompt 并运行
2. **派生功能出现** - 任务完成后，DerivedFeatures 组件显示
3. **选择功能** - 点击相应的派生功能按钮
4. **处理交互** - 某些功能可能需要额外输入（如快照名称）
5. **查看结果** - 通过对话框或文件通知反馈结果

### 关键特性

- ✅ 对话选择自动化 - 总是使用最新任务
- ✅ 错误处理 - 友好的错误提示
- ✅ 异步操作 - 不阻塞 UI
- ✅ 文件存储 - 自动创建必要的目录
- ✅ 浏览器预览 - 完整的降级实现
- ✅ Electron 集成 - 完整的主进程支持

## 扩展指南

### 添加新的派生功能

1. **在 types/electron.d.ts 中定义类型**:
   ```typescript
   export interface NewFeaturePayload { /* ... */ }
   export interface NewFeatureResult { /* ... */ }
   ```

2. **在 electron/main.cjs 中添加 IPC 处理程序**:
   ```javascript
   ipcMain.handle("derived:new-feature", async (_event, payload) => {
     // 实现逻辑
     return result;
   });
   ```

3. **在 preload.cjs 中暴露 API**:
   ```javascript
   derived: {
     newFeature: (payload) => ipcRenderer.invoke("derived:new-feature", payload),
   }
   ```

4. **在 desktopApi.ts 中添加前端实现**:
   ```typescript
   derived: {
     newFeature: async (payload): Promise<NewFeatureResult> => {
       // 前端实现或调用 Electron API
     }
   }
   ```

5. **在 App.tsx 中添加处理函数和按钮**:
   ```typescript
   const handleNewFeature = async () => {
     // 实现逻辑
   }
   ```

6. **在 DerivedFeatures 组件中添加按钮**:
   ```typescript
   {
     id: "new-feature",
     icon: IconName,
     label: "特性名称",
     description: "特性描述",
     onClick: onNewFeature,
   }
   ```

## 测试

### 浏览器预览模式

所有派生功能在浏览器预览模式下都有实现，可以直接测试 UI 和交互。

### Electron 测试

在 Electron 环境中运行应用，验证：
- IPC 通信正常
- 文件正确创建
- 错误处理适当

### 集成测试场景

1. **导出工作流**: 运行任务 → 导出对话 → 验证文件内容
2. **快照恢复**: 创建快照 → 验证快照元数据 → 检查文件副本
3. **分支工作流**: 分支任务 → 在分支上继续对话 → 验证独立性
4. **对比分析**: 运行多个任务 → 对比输出 → 验证相似度评分

## 数据存储结构

### 导出目录 (~/.codex/exports/)
```
conversation-2024-12-21T10-30-45.md
conversation-2024-12-21T10-30-45.json
conversation-2024-12-21T10-30-45.html
```

### 快照目录 (~/.codex/snapshots/)
```
{snapshotId}/
  ├── metadata.json          # 快照元数据
  └── files/                 # 附件副本（可选）
      ├── file1.txt
      └── file2.md
```

### 共享目录 (~/.codex/shares/)
```
share-2024-12-21T10-30-45.txt
share-2024-12-21T10-31-20.txt
```

## 性能考虑

- **导出**: 文件大小取决于任务输出大小（通常 <10MB）
- **快照**: 包含文件副本，考虑磁盘空间
- **对比**: O(n) 时间复杂度，n 为输出字符数
- **分析**: 快速操作，主要是字符串处理

## 安全考虑

- 文件保存到用户目录，不涉及敏感权限
- 导出内容可能包含 API key，需用户注意
- 快照文件不加密，敏感项目请谨慎
- 没有上传或网络操作

## 已知限制

1. **AI 功能**: 当前实现为占位符，生产环境需集成真实 LLM
2. **对比**: 当前实现为简单文本相似度，可改进为更复杂的算法
3. **文档生成**: 当前为基础模板，可添加更多样式选项
4. **性能**: 大型对话（>1MB）的导出可能需要优化

## 未来增强

- [ ] 对话搜索和过滤功能
- [ ] 导出模板自定义
- [ ] 快照版本管理和对比
- [ ] 分支合并功能
- [ ] 自动化工作流定义
- [ ] 对话统计和分析仪表板
- [ ] 导出到第三方服务（Google Drive, Notion 等）

## 维护和监控

### 日志位置
- Electron: 主进程日志在 DevTools Console
- React: 前端日志在浏览器 DevTools

### 常见问题排查

**Q: 派生功能按钮不显示**
- A: 检查是否有运行中的任务，或任务列表是否为空

**Q: 导出失败**
- A: 检查 ~/.codex/exports/ 目录是否可写，检查磁盘空间

**Q: 快照创建成功但文件不存在**
- A: 检查 ~/.codex/snapshots/ 目录权限

## 贡献指南

欢迎贡献新的派生功能！请：
1. 遵循现有架构和命名规范
2. 添加完整的 TypeScript 类型
3. 包含浏览器预览实现
4. 添加文档说明
5. 测试错误处理场景

## 相关文件速查表

| 功能 | 前端 | API | IPC | 主进程 |
|-----|------|-----|-----|--------|
| UI 组件 | src/App.tsx | - | - | - |
| 类型定义 | - | src/types/electron.d.ts | - | - |
| API 实现 | - | src/lib/desktopApi.ts | - | - |
| 预加载 | - | - | electron/preload.cjs | - |
| 主程序 | - | - | - | electron/main.cjs |

---

**最后更新**: 2024年12月21日
**版本**: 1.0.0 Alpha
**状态**: ✅ 功能完整，待生产环境测试
