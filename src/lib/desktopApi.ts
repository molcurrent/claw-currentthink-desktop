import type {
  AttachmentKind,
  ArchivedConversation,
  AttachedFile,
  ClawTask,
  CreateWorktreePayload,
  CreateWorktreeResult,
  LocalCatalog,
  ModelProfile,
  PreferencesPatch,
  PublicPreferences,
  SystemStatus,
  TaskBusEvent,
  TaskRunPayload,
  WorkspaceSearchResult,
  ExportConversationPayload,
  ExportConversationResult,
  GenerateSummaryPayload,
  GenerateSummaryResult,
  CreateSnapshotPayload,
  CreateSnapshotResult,
  ShareContextPayload,
  ShareContextResult,
  BranchTaskPayload,
  BranchTaskResult,
  CompareOutputsPayload,
  CompareOutputsResult,
  ExtractInsightsPayload,
  ExtractInsightsResult,
  GenerateDocumentationPayload,
  GenerateDocumentationResult,
  SpeechTranscribePayload,
  SpeechTranscribeResult,
} from "../types/electron";

const bundledSkillCatalog = [
  {
    id: "agent-skills-using-agent-skills",
    name: "using-agent-skills",
    description: "选择并调度合适工程技能的元技能，适合作为会话起点。",
    path: "skills/agent-skills/skills/using-agent-skills/SKILL.md",
    source: "workspace bundle",
  },
  {
    id: "agent-skills-frontend-ui-engineering",
    name: "frontend-ui-engineering",
    description: "面向生产质量的前端 UI 工程技能，覆盖布局、状态、可访问性与视觉质量。",
    path: "skills/agent-skills/skills/frontend-ui-engineering/SKILL.md",
    source: "workspace bundle",
  },
  {
    id: "agent-skills-code-review-and-quality",
    name: "code-review-and-quality",
    description: "五维代码审查与质量门禁，适合合并前做系统性检查。",
    path: "skills/agent-skills/skills/code-review-and-quality/SKILL.md",
    source: "workspace bundle",
  },
  {
    id: "agent-skills-test-driven-development",
    name: "test-driven-development",
    description: "测试驱动开发工作流，强调红绿重构与可验证交付。",
    path: "skills/agent-skills/skills/test-driven-development/SKILL.md",
    source: "workspace bundle",
  },
  {
    id: "agent-skills-debugging-and-error-recovery",
    name: "debugging-and-error-recovery",
    description: "从复现、定位到修复和防回归的系统化排障技能。",
    path: "skills/agent-skills/skills/debugging-and-error-recovery/SKILL.md",
    source: "workspace bundle",
  },
  {
    id: "agent-skills-performance-optimization",
    name: "performance-optimization",
    description: "以测量为先的性能优化技能，适合定位与压降性能回退。",
    path: "skills/agent-skills/skills/performance-optimization/SKILL.md",
    source: "workspace bundle",
  },
];

const fallbackPreferences: PublicPreferences = {
  clawPath: "claw",
  defaultModel: "claude-opus-4-6",
  openaiBaseUrl: "",
  openaiCompatEnabled: false,
  offlineSpeechEnabled: true,
  offlineSpeechModel: "mlx-community/whisper-tiny",
  permissionMode: "danger-full-access",
  workspacePath: "/Users/mac/Documents/New project",
  theme: "light",
  fontSize: 13,
  autoSaveLogs: true,
  anthropicApiKeySet: false,
  anthropicAuthTokenSet: false,
  openaiApiKeySet: false,
  anthropicApiKeyHint: "",
  anthropicAuthTokenHint: "",
  openaiApiKeyHint: "",
  enableDeepSeek1M: false,
  modelProfiles: [],
};


function normalizeOpenAiBaseUrlForFallback(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function normalizeUiModelForFallback(model: unknown, fallback: string): string {
  const candidate = typeof model === "string" ? model.trim() : "";
  const next = candidate || fallback;
  if (!next) return fallback;
  const strippedOpenAi = next.startsWith("openai/") ? next.slice("openai/".length) : next;
  if (/^deepseek-ai\/deepseek-v4-(pro|flash)$/i.test(strippedOpenAi)) {
    return strippedOpenAi.split("/").pop() || strippedOpenAi;
  }
  return strippedOpenAi;
}

function normalizeWorkspacePathForFallback(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function singleTurnConversationIdForFallback(workspacePath: unknown): string | null {
  const normalized = normalizeWorkspacePathForFallback(workspacePath);
  if (!normalized) return null;
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= BigInt(normalized.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return `single_turn_ws_${hash.toString(16).padStart(16, "0")}`;
}

function sanitizeModelProfiles(value: unknown): ModelProfile[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<ModelProfile[]>((profiles, entry) => {
    if (!entry || typeof entry !== "object") return profiles;
    const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
    if (!modelId) return profiles;
    const normalizeNumber = (next: unknown) => {
      const parsed = Number(next);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    profiles.push({
      modelId,
      contextLimit: normalizeNumber((entry as ModelProfile).contextLimit),
      inputPricePerMillion: normalizeNumber((entry as ModelProfile).inputPricePerMillion),
      outputPricePerMillion: normalizeNumber((entry as ModelProfile).outputPricePerMillion),
      cachePricePerMillion: normalizeNumber((entry as ModelProfile).cachePricePerMillion),
    });
    return profiles;
  }, []);
}

let fallbackTasks: ClawTask[] = [
  {
    id: "sample-1",
    conversationId: "browser-preview-conversation",
    prompt: "检查当前仓库并总结可改进点",
    cwd: "/Users/mac/Documents/New project/claw-code",
    model: "claude-opus-4-6",
    permissionMode: "danger-full-access",
    files: [],
    status: "completed",
    output: "Status\n  Project root detected\n  Git state clean\n\n已完成示例任务。桌面环境运行时这里会显示真实 claw stdout。",
    error: "",
    events: [],
    sessionId: null,
    sessionPath: null,
    createdAt: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
    startedAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    finishedAt: new Date(Date.now() - 1000 * 60 * 24).toISOString(),
    exitCode: 0,
    signal: null,
  },
];
let fallbackArchivedConversations: ArchivedConversation[] = [];
let fallbackArchivedTasks: ClawTask[] = [];

const listeners = new Set<(event: TaskBusEvent) => void>();

const fallbackCatalog: LocalCatalog = {
  skills: bundledSkillCatalog,
  plugins: [
    {
      id: "browser-preview-build-web-apps",
      name: "Build Web Apps",
      description: "浏览器预览模式下的示例插件。Electron 运行时会扫描本机插件缓存。",
      path: "browser-preview/plugins/build-web-apps",
      provider: "browser preview",
      status: "installed",
      skillCount: 1,
    },
  ],
  automations: [],
  generatedAt: new Date().toISOString(),
};

function notify(event: TaskBusEvent) {
  listeners.forEach((listener) => listener(event));
}

export function getDesktopApi() {
  if (window.clawDesktop) return window.clawDesktop;

  return {
    window: {
      close: async () => true,
      minimize: async () => true,
      toggleFullscreen: async () => true,
    },
    system: {
      status: async (): Promise<SystemStatus> => ({
        clawFound: true,
        clawPath: "claw",
        version: "Claw Code\n  Version          0.1.0\n  Target           browser-preview",
        error: "",
        platform: "browser preview",
        userDataPath: "browser local preview",
      }),
      revealPath: async () => true,
    },
    preferences: {
      get: async () => fallbackPreferences,
      save: async (patch: PreferencesPatch) => {
        const hasOwn = (key: keyof PreferencesPatch) => Object.prototype.hasOwnProperty.call(patch, key);
        const normalizeSecretFlag = (key: "anthropicApiKey" | "anthropicAuthToken" | "openaiApiKey", current: boolean) => {
          if (!hasOwn(key)) return current;
          return Boolean(String(patch[key] ?? "").trim());
        };
        const getMockSecretHint = (key: "anthropicApiKey" | "anthropicAuthToken" | "openaiApiKey", current: string) => {
          if (!hasOwn(key)) return current;
          const val = String(patch[key] ?? "").trim();
          if (!val) return "";
          if (val.length <= 8) return val;
          return `${val.slice(0, 4)}...${val.slice(-4)}`;
        };
        Object.assign(fallbackPreferences, {
          clawPath: hasOwn("clawPath") ? patch.clawPath || fallbackPreferences.clawPath : fallbackPreferences.clawPath,
          openaiBaseUrl: hasOwn("openaiBaseUrl")
            ? patch.openaiBaseUrl ?? fallbackPreferences.openaiBaseUrl
            : fallbackPreferences.openaiBaseUrl,
          openaiCompatEnabled:
            typeof patch.openaiCompatEnabled === "boolean"
              ? patch.openaiCompatEnabled
              : fallbackPreferences.openaiCompatEnabled,
          offlineSpeechEnabled:
            typeof patch.offlineSpeechEnabled === "boolean"
              ? patch.offlineSpeechEnabled
              : fallbackPreferences.offlineSpeechEnabled,
          offlineSpeechModel: hasOwn("offlineSpeechModel")
            ? patch.offlineSpeechModel || fallbackPreferences.offlineSpeechModel
            : fallbackPreferences.offlineSpeechModel,
          permissionMode: hasOwn("permissionMode") ? patch.permissionMode || fallbackPreferences.permissionMode : fallbackPreferences.permissionMode,
          workspacePath: hasOwn("workspacePath") ? patch.workspacePath || fallbackPreferences.workspacePath : fallbackPreferences.workspacePath,
          theme: hasOwn("theme") ? patch.theme || fallbackPreferences.theme : fallbackPreferences.theme,
          fontSize: hasOwn("fontSize") ? patch.fontSize || fallbackPreferences.fontSize : fallbackPreferences.fontSize,
          autoSaveLogs: typeof patch.autoSaveLogs === "boolean" ? patch.autoSaveLogs : fallbackPreferences.autoSaveLogs,
          anthropicApiKeySet: normalizeSecretFlag("anthropicApiKey", fallbackPreferences.anthropicApiKeySet),
          anthropicAuthTokenSet: normalizeSecretFlag("anthropicAuthToken", fallbackPreferences.anthropicAuthTokenSet),
          openaiApiKeySet: normalizeSecretFlag("openaiApiKey", fallbackPreferences.openaiApiKeySet),
          anthropicApiKeyHint: getMockSecretHint("anthropicApiKey", fallbackPreferences.anthropicApiKeyHint || ""),
          anthropicAuthTokenHint: getMockSecretHint("anthropicAuthToken", fallbackPreferences.anthropicAuthTokenHint || ""),
          openaiApiKeyHint: getMockSecretHint("openaiApiKey", fallbackPreferences.openaiApiKeyHint || ""),
          enableDeepSeek1M: typeof patch.enableDeepSeek1M === "boolean" ? patch.enableDeepSeek1M : fallbackPreferences.enableDeepSeek1M,
          modelProfiles: hasOwn("modelProfiles")
            ? sanitizeModelProfiles(patch.modelProfiles)
            : fallbackPreferences.modelProfiles,
        });
        fallbackPreferences.defaultModel = hasOwn("defaultModel")
          ? normalizeUiModelForFallback(patch.defaultModel, fallbackPreferences.defaultModel)
          : normalizeUiModelForFallback(fallbackPreferences.defaultModel, fallbackPreferences.defaultModel);
        return fallbackPreferences;
      },
    },
    files: {
      selectFiles: async (kind: AttachmentKind = "file"): Promise<AttachedFile[]> =>
        kind === "image"
          ? [
              {
                id: crypto.randomUUID(),
                name: "diagram-preview.png",
                path: "/Users/mac/Documents/New project/claw-code/assets/diagram-preview.png",
                size: 248_120,
                modifiedAt: new Date().toISOString(),
              },
            ]
          : [
              {
                id: crypto.randomUUID(),
                name: "README.md",
                path: "/Users/mac/Documents/New project/claw-code/README.md",
                size: 12048,
                modifiedAt: new Date().toISOString(),
              },
            ],
      selectFolder: async () => "/Users/mac/Documents/New project/claw-code",
      fromDroppedFiles: async (files: File[] | FileList): Promise<AttachedFile[]> =>
        Array.from(files).map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          path: `browser-preview/${file.name}`,
          size: file.size,
          modifiedAt: new Date(file.lastModified || Date.now()).toISOString(),
        })),
    },
    workspace: {
      search: async (payload: { query: string }): Promise<WorkspaceSearchResult[]> => {
        if (!payload.query.trim()) return [];
        return [
          {
            path: "/Users/mac/Documents/New project/claw-currentthink-desktop/src/App.tsx",
            name: "App.tsx",
            line: 1,
            preview: `浏览器预览搜索结果: ${payload.query}`,
          },
        ];
      },
      createWorktree: async (payload: CreateWorktreePayload): Promise<CreateWorktreeResult> => {
        const sourcePath = payload.sourcePath.trim();
        const name = payload.name.trim() || "new-worktree";
        const path = `${sourcePath}-${name.toLowerCase().replace(/\s+/g, "-")}`;
        return {
          name,
          path,
          sourcePath,
          clonedTaskCount: fallbackTasks.filter((task) => task.cwd === sourcePath).length,
          clonedConversationCount: 1,
          latestTaskId: fallbackTasks[0]?.id || null,
        };
      },
    },
    catalog: {
      list: async () => fallbackCatalog,
    },
    conversations: {
      listArchived: async (): Promise<ArchivedConversation[]> => fallbackArchivedConversations,
      archive: async (conversationId: string) => {
        const tasksToArchive = fallbackTasks.filter((task) => (task.conversationId || task.id) === conversationId);
        const now = new Date().toISOString();
        const latestTask = tasksToArchive[0];
        const archivedItem: ArchivedConversation = {
          id: conversationId,
          cwd: latestTask?.cwd || fallbackPreferences.workspacePath,
          model: latestTask?.model || fallbackPreferences.defaultModel,
          title: latestTask?.prompt || "浏览器预览归档对话",
          taskCount: tasksToArchive.length,
          archivedAt: now,
          archivedReason: "conversation-archive",
          createdAt: latestTask?.createdAt || now,
          updatedAt: now,
          latestTaskId: latestTask?.id || null,
        };
        fallbackArchivedTasks = [...tasksToArchive, ...fallbackArchivedTasks];
        fallbackArchivedConversations = [archivedItem, ...fallbackArchivedConversations];
        fallbackTasks = fallbackTasks.filter((task) => (task.conversationId || task.id) !== conversationId);
        notify({ type: "task:cleared", payload: fallbackTasks });
        return {
          archivedConversations: fallbackArchivedConversations,
          tasks: fallbackTasks,
          archivedCount: 1,
          taskCount: tasksToArchive.length,
        };
      },
      archiveWorkspace: async (payload: { workspacePath: string }) => {
        const workspacePath = payload.workspacePath.trim();
        const tasksToArchive = fallbackTasks.filter((task) => task.cwd === workspacePath);
        const now = new Date().toISOString();
        const conversationIds = new Set(tasksToArchive.map((task) => task.conversationId || task.id));
        const archivedItems = Array.from(conversationIds).map<ArchivedConversation>((conversationId) => {
          const tasks = tasksToArchive.filter((task) => (task.conversationId || task.id) === conversationId);
          const latestTask = tasks[0] || tasksToArchive[0];
          return {
            id: String(conversationId),
            cwd: workspacePath,
            model: latestTask?.model || fallbackPreferences.defaultModel,
            title: latestTask?.prompt || "浏览器预览归档对话",
            taskCount: tasks.length,
            archivedAt: now,
            archivedReason: "workspace-archive",
            createdAt: latestTask?.createdAt || now,
            updatedAt: now,
            latestTaskId: latestTask?.id || null,
          };
        });
        fallbackArchivedTasks = [...tasksToArchive, ...fallbackArchivedTasks];
        fallbackArchivedConversations = [...archivedItems, ...fallbackArchivedConversations];
        fallbackTasks = fallbackTasks.filter((task) => task.cwd !== workspacePath);
        notify({ type: "task:cleared", payload: fallbackTasks });
        return {
          archivedConversations: fallbackArchivedConversations,
          tasks: fallbackTasks,
          archivedCount: archivedItems.length,
          taskCount: tasksToArchive.length,
        };
      },
      restore: async (conversationId: string) => {
        const restoredTasks = fallbackArchivedTasks.filter((task) => (task.conversationId || task.id) === conversationId);
        fallbackArchivedTasks = fallbackArchivedTasks.filter((task) => (task.conversationId || task.id) !== conversationId);
        fallbackArchivedConversations = fallbackArchivedConversations.filter((item) => item.id !== conversationId);
        fallbackTasks = [...restoredTasks, ...fallbackTasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        notify({ type: "task:cleared", payload: fallbackTasks });
        return {
          archivedConversations: fallbackArchivedConversations,
          tasks: fallbackTasks,
          restoredTaskCount: restoredTasks.length,
          latestTaskId: restoredTasks[0]?.id || null,
        };
      },
    },
    tasks: {
      list: async () => fallbackTasks,
      run: async (payload: TaskRunPayload) => {
        const fallbackConversationId =
          payload.forceFreshConversation
            ? null
            : payload.conversationId || singleTurnConversationIdForFallback(payload.cwd || fallbackPreferences.workspacePath);
        const task: ClawTask = {
          id: crypto.randomUUID(),
          conversationId: fallbackConversationId,
          prompt: payload.prompt,
          cwd: payload.cwd || fallbackPreferences.workspacePath,
          model: normalizeUiModelForFallback(
            payload.model,
            fallbackPreferences.defaultModel,
          ),
          permissionMode: payload.permissionMode || fallbackPreferences.permissionMode,
          files: payload.files || [],
          status: "running",
          output: "",
          error: "",
          events: [],
          sessionId: null,
          sessionPath: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
          signal: null,
        };
        fallbackTasks = [task, ...fallbackTasks];
        notify({ type: "task:updated", payload: task });
        const chunks = [
          `claw prompt "${payload.prompt.slice(0, 72)}"\n\n`,
          "浏览器预览正在模拟流式输出...\n",
          "Electron 桌面运行时，这里会随着真实 claw CLI 的 stdout/stderr 实时追加。\n",
        ];
        chunks.forEach((chunk, index) => {
          window.setTimeout(() => {
            task.output += chunk;
            const event = {
              id: crypto.randomUUID(),
              taskId: task.id,
              stream: "stdout" as const,
              chunk,
              createdAt: new Date().toISOString(),
            };
            task.events = [...task.events, event];
            notify({ type: "task:chunk", payload: event });
            if (index === chunks.length - 1) {
              task.status = "completed";
              task.finishedAt = new Date().toISOString();
              task.exitCode = 0;
              notify({ type: "task:updated", payload: task });
            }
          }, 300 * (index + 1));
        });
        return task;
      },
      cancel: async (taskId: string) => {
        fallbackTasks = fallbackTasks.map((task) =>
          task.id === taskId ? { ...task, status: "canceled", finishedAt: new Date().toISOString() } : task,
        );
        notify({ type: "task:cleared", payload: fallbackTasks });
        return true;
      },
      clear: async () => {
        fallbackTasks = fallbackTasks.filter((task) => task.status === "running" || task.status === "pending");
        notify({ type: "task:cleared", payload: fallbackTasks });
        return fallbackTasks;
      },
      delete: async (taskId: string) => {
        const targetTask = fallbackTasks.find((task) => task.id === taskId);
        if (targetTask?.conversationId) {
          fallbackTasks = fallbackTasks.filter((task) => task.conversationId !== targetTask.conversationId);
        } else {
          fallbackTasks = fallbackTasks.filter((task) => task.id !== taskId);
        }
        notify({ type: "task:cleared", payload: fallbackTasks });
        return fallbackTasks;
      },
      onEvent: (callback: (event: TaskBusEvent) => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    derived: {
      exportConversation: async (payload: ExportConversationPayload): Promise<ExportConversationResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
        return {
          filePath: `/browser-preview/exports/conversation-${timestamp}.${payload.format || "md"}`,
          size: 1024,
          format: payload.format || "markdown",
          taskCount: 1,
        };
      },
      generateSummary: async (payload: GenerateSummaryPayload): Promise<GenerateSummaryResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        return {
          summary: `浏览器预览摘要: ${task.prompt}`,
          keyPoints: [task.prompt.slice(0, 50), "Browser preview mode"],
          suggestedFollowUps: ["What next?", "How to improve?"],
          generatedAt: new Date().toISOString(),
        };
      },
      createSnapshot: async (payload: CreateSnapshotPayload): Promise<CreateSnapshotResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        return {
          snapshotId: crypto.randomUUID(),
          snapshotPath: `/browser-preview/snapshots/${payload.snapshotName}`,
          taskCount: 1,
          fileCount: 0,
          createdAt: new Date().toISOString(),
        };
      },
      shareContext: async (payload: ShareContextPayload): Promise<ShareContextResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        const content = `Prompt: ${task.prompt}\nStatus: ${task.status}`;
        return {
          content,
          size: Buffer.byteLength(content, "utf-8"),
        };
      },
      branchTask: async (payload: BranchTaskPayload): Promise<BranchTaskResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.sourceTaskId);
        if (!task) throw new Error(`Task ${payload.sourceTaskId} not found`);
        const newTaskId = crypto.randomUUID();
        const newConversationId = crypto.randomUUID();
        const branchedTask: ClawTask = {
          ...task,
          id: newTaskId,
          conversationId: newConversationId,
          prompt: `[Branch of ${payload.sourceTaskId}] ${payload.branchName}`,
          createdAt: new Date().toISOString(),
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
        };
        fallbackTasks = [branchedTask, ...fallbackTasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        notify({ type: "task:cleared", payload: fallbackTasks });
        return {
          newTaskId,
          newConversationId,
          taskPath: task.cwd,
          copiedTurns: 1,
        };
      },
      compareOutputs: async (payload: CompareOutputsPayload): Promise<CompareOutputsResult> => {
        return {
          comparison: `浏览器预览对比: ${payload.taskId1} vs ${payload.taskId2}`,
          similarities: ["Both tasks completed"],
          differences: ["Different outputs"],
          commonalityScore: 75,
        };
      },
      extractInsights: async (payload: ExtractInsightsPayload): Promise<ExtractInsightsResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        return {
          insights: {
            key_findings: [task.prompt.slice(0, 50)],
            technical_details: ["Browser preview mode"],
          },
          patterns: ["Task executed successfully"],
          recommendations: ["Review the output", "Consider next steps"],
          extractedAt: new Date().toISOString(),
        };
      },
      generateDocumentation: async (payload: GenerateDocumentationPayload): Promise<GenerateDocumentationResult> => {
        const task = fallbackTasks.find((t) => t.id === payload.taskId);
        if (!task) throw new Error(`Task ${payload.taskId} not found`);
        const documentation = `# Task Documentation\n\n## Overview\n${task.prompt}\n\n## Status\n${task.status}`;
        return {
          documentation,
          sections: ["Overview", "Status"],
          wordCount: documentation.split(/\s+/).length,
          generatedAt: new Date().toISOString(),
        };
      },
    },
    speech: {
      transcribe: async (_payload: SpeechTranscribePayload): Promise<SpeechTranscribeResult> => {
        return {
          text: "浏览器预览模式下暂不支持真实语音转写。",
          model: "browser-preview",
          provider: "offline-preview",
        };
      },
    },
  };
}
