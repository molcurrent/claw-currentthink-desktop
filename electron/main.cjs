const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const isDev = !app.isPackaged;
const defaultWorkspace = app.getPath("documents");
const cargoBin = path.join(os.homedir(), ".cargo", "bin");
const validPermissionModes = new Set(["read-only", "workspace-write", "danger-full-access"]);
const maxPromptChars = 60_000;
const maxModelChars = 160;
const maxTaskOutputChars = 200_000;
const maxTaskEvents = 200;
const maxEventChunkChars = 10_000;
const maxTaskFiles = 50;
const maxSearchQueryChars = 200;
const maxSearchResults = 80;
const maxSearchLineChars = 500;
const maxCatalogItems = 200;
const maxCatalogDescriptionChars = 260;
const maxSpeechAudioBytes = 15 * 1024 * 1024;
const persistDebounceMs = 500;
const maxConversationTurns = 24;
const maxConversationMessageChars = 24_000;
const stablePromptVersion = 1;
const maxModelProfiles = 50;
const maxWorktreeNameChars = 120;
const attachmentFileFilters = [
  {
    name: "Markdown / Text / Code",
    extensions: [
      "md",
      "markdown",
      "txt",
      "text",
      "json",
      "js",
      "jsx",
      "ts",
      "tsx",
      "mjs",
      "cjs",
      "py",
      "rs",
      "go",
      "java",
      "kt",
      "swift",
      "php",
      "rb",
      "sh",
      "bash",
      "zsh",
      "css",
      "scss",
      "html",
      "xml",
      "yaml",
      "yml",
      "toml",
      "ini",
      "cfg",
      "log",
      "csv",
      "sql",
    ],
  },
  {
    name: "All Files",
    extensions: ["*"],
  },
];
const attachmentImageFilters = [
  {
    name: "Images",
    extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "heif", "avif"],
  },
];

let mainWindow;
let db;
let activeTask = null;
const taskQueue = [];
const persistTimers = new Map();
let activeReplSession = null;

const replStartupTimeoutMs = 20_000;
const replShutdownTimeoutMs = 1_500;
const replPromptTimeoutMs = 10 * 60 * 1000;
const expectBinaryPath = "/usr/bin/expect";
const expectReplScriptPath = isDev
  ? path.join(__dirname, "claw-repl.expect")
  : path.join(process.resourcesPath, "app.asar.unpacked", "electron", "claw-repl.expect");

const defaultData = {
  version: 2,
  preferences: {
    clawPath: "bundled",
    defaultModel: "claude-opus-4-6",
    openaiBaseUrl: "",
    openaiCompatEnabled: false,
    offlineSpeechEnabled: true,
    offlineSpeechModel: "mlx-community/whisper-tiny",
    permissionMode: "danger-full-access",
    workspacePath: defaultWorkspace,
    theme: "light",
    language: "zh-CN",
    fontSize: 13,
    autoSaveLogs: true,
    enableDeepSeek1M: false,
    modelProfiles: [],
    saveSingleTurnInOnePlace: true,
    secrets: {
      anthropicApiKey: null,
      anthropicAuthToken: null,
      openaiApiKey: null,
    },
  },
  tasks: [],
  archivedTasks: [],
  recentFiles: [],
  conversations: {},
};

function runtimePathEnv() {
  const bundled = resolveBundledClawPath();
  const entries = [
    bundled ? path.dirname(bundled) : "",
    cargoBin,
    process.env.PATH || "",
  ].filter(Boolean);
  return entries.join(path.delimiter);
}

function bundledClawRoot() {
  return isDev ? path.join(__dirname, "..", "bin") : path.join(process.resourcesPath, "bin");
}

function executableNameForPlatform(platform = process.platform) {
  return platform === "win32" ? "claw.exe" : "claw";
}

function bundledClawCandidates() {
  const root = bundledClawRoot();
  const exe = executableNameForPlatform();
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const platform = process.platform;
  const fallbackArch = arch === "arm64" ? "x64" : "arm64";
  return [
    path.join(root, platform, exe),
    path.join(root, `${platform}-${arch}`, exe),
    path.join(root, `${platform}-${fallbackArch}`, exe),
    path.join(root, exe),
  ];
}

function resolveBundledClawPath() {
  return bundledClawCandidates().find((candidate) => isExecutableFile(candidate)) || "";
}

function resolveClawPath(preferences = {}) {
  const configured = normalizeString(preferences.clawPath, "", { max: 4096 });
  if (configured && configured !== "claw" && configured !== "bundled") {
    return configured;
  }
  return resolveBundledClawPath() || configured || "claw";
}

function createTaskEvent(taskId, stream, chunk) {
  return {
    id: crypto.randomUUID(),
    taskId,
    stream,
    chunk: String(chunk || "").slice(-maxEventChunkChars),
    createdAt: new Date().toISOString(),
  };
}

function emitTaskEvent(type, payload) {
  mainWindow?.webContents.send("tasks:event", { type, payload });
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function normalizeString(value, fallback = "", options = {}) {
  if (typeof value !== "string") return fallback;
  const trimmed = options.trim === false ? value : value.trim();
  const max = options.max || 10_000;
  if (!trimmed) return fallback;
  return trimmed.slice(0, max);
}

function normalizeOptionalSecret(value) {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, 4096);
}

function normalizePermissionMode(value, fallback) {
  return validPermissionModes.has(value) ? value : fallback;
}

function normalizeModel(value, fallback) {
  const model = normalizeString(value, fallback, { max: maxModelChars });
  if (!/^[a-zA-Z0-9._:/@+-]+$/.test(model)) return fallback;
  return model;
}

function normalizeOpenAiBaseUrl(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) return fallback;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeOfflineSpeechModel(value, fallback = "mlx-community/whisper-tiny") {
  const model = normalizeString(value, fallback, { max: 200 });
  return model || fallback;
}

function normalizeFontSize(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(18, Math.max(11, Math.round(next)));
}

function normalizeNonNegativeNumber(value, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0) return fallback;
  return next;
}

function normalizeOptionalNonNegativeNumber(value) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 0) return undefined;
  return next;
}

function normalizeWorkspacePath(value, fallback) {
  const candidate = normalizeString(value, fallback, { max: 4096 });
  try {
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function normalizeClawPath(value, fallback = "claw") {
  const candidate = normalizeString(value, fallback, { max: 4096 });
  if (!candidate || candidate === "bundled") return "bundled";
  if (candidate === "claw") return "claw";
  if (path.isAbsolute(candidate) && isExecutableFile(candidate)) return candidate;
  return fallback || "claw";
}

function normalizeLanguage(value, fallback = "zh-CN") {
  return value === "en-US" ? "en-US" : value === "zh-CN" ? "zh-CN" : fallback;
}

function normalizeModelProfiles(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set();
  const next = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const modelId = normalizeModel(entry.modelId, "");
    if (!modelId) continue;
    const key = modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({
      modelId,
      contextLimit: normalizeOptionalNonNegativeNumber(entry.contextLimit),
      inputPricePerMillion: normalizeOptionalNonNegativeNumber(entry.inputPricePerMillion),
      outputPricePerMillion: normalizeOptionalNonNegativeNumber(entry.outputPricePerMillion),
      cachePricePerMillion: normalizeOptionalNonNegativeNumber(entry.cachePricePerMillion),
    });
    if (next.length >= maxModelProfiles) break;
  }
  return next;
}

function normalizeUiModelForStorage(model, fallback = "") {
  const normalizedModel = normalizeModel(model, fallback);
  if (!normalizedModel) return fallback;
  return toCanonicalModelId(normalizedModel);
}

function stripProviderPrefix(model) {
  const normalizedModel = normalizeModel(model, "");
  if (!normalizedModel) return normalizedModel;
  return normalizedModel.replace(/^(anthropic|openai)\//i, "");
}

function toCanonicalModelId(model) {
  const normalizedModel = stripProviderPrefix(model);
  if (!normalizedModel) return normalizedModel;
  if (/^deepseek-ai\/deepseek-v4-(pro|flash)$/i.test(normalizedModel)) {
    const variant = normalizedModel.split("/").pop()?.toLowerCase() || "deepseek-v4-pro";
    return variant;
  }
  return normalizedModel;
}

function normalizeCliExecutionModel(model) {
  const canonicalModel = toCanonicalModelId(normalizeModel(model, ""));
  if (!canonicalModel) return canonicalModel;
  if (canonicalModel.startsWith("claude")) {
    return `anthropic/${canonicalModel}`;
  }
  if (canonicalModel.includes("/")) {
    return canonicalModel;
  }
  return `openai/${canonicalModel}`;
}

function isOpenAiCompatibleModel(model) {
  const normalizedModel = normalizeCliExecutionModel(model || "").toLowerCase();
  if (!normalizedModel) return false;
  const canonicalModel = stripProviderPrefix(normalizedModel);
  if (canonicalModel.startsWith("claude")) return false;
  return (
    normalizedModel.startsWith("openai/")
    || canonicalModel.startsWith("gpt-")
    || canonicalModel.startsWith("qwen/")
    || canonicalModel.startsWith("qwen-")
    || canonicalModel.startsWith("kimi/")
    || canonicalModel.startsWith("kimi-")
    || canonicalModel.startsWith("grok")
  );
}

function resolveModelForExecution(model, preferences) {
  const storedModel = normalizeUiModelForStorage(model, preferences.defaultModel);
  return normalizeCliExecutionModel(storedModel);
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n?/g, "\n");
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function repairUtf8MojibakeSegments(value) {
  return String(value || "").replace(/(?:[\u00c2-\u00f4][\u0080-\u00bf]{1,3})+/g, (segment) => {
    try {
      const repaired = Buffer.from(segment, "latin1").toString("utf8");
      return repaired.includes("\uFFFD") ? segment : repaired;
    } catch {
      return segment;
    }
  });
}

function normalizeTerminalOutput(value) {
  return repairUtf8MojibakeSegments(stripAnsi(String(value || "")))
    .replace(/\r/g, "")
    .replace(/\u0008/g, "")
    .replace(/\u001b7/g, "")
    .replace(/\u001b8/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function createConversationId() {
  return crypto.randomUUID();
}

function normalizeWorkspacePathKey(workspacePath) {
  if (typeof workspacePath !== "string") return "";
  return workspacePath
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function singleTurnConversationIdForWorkspace(workspacePath) {
  const normalized = normalizeWorkspacePathKey(workspacePath);
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

function sanitizeConversationId(value, fallback = null) {
  const next = normalizeString(value, "", { max: 120 });
  if (!next) return fallback;
  return /^[a-zA-Z0-9_-]+$/.test(next) ? next : fallback;
}

function isSingleTurnConversationId(value) {
  return typeof value === "string" && /^single_turn(?:_ws_[a-f0-9]{8,16}|_[a-zA-Z0-9_]+)$/i.test(value);
}

function isLegacySingleTurnConversationId(value) {
  return isSingleTurnConversationId(value) && !/^single_turn_ws_[a-f0-9]{16}$/i.test(value);
}

function normalizeConversationMessage(content) {
  return normalizeString(content, "", { max: maxConversationMessageChars });
}

function stableTaskPrefix(task, context) {
  const fileList = (task.files || []).map((file) => `- ${file.path}`).join("\n");
  const fileSection = fileList ? `\n\n关联文件:\n${fileList}` : "";
  return [
    `Stable-Prefix-Version: ${stablePromptVersion}`,
    `Assistant-Identity: You are Claude, the AI coding assistant inside this desktop app.`,
    `Workspace: ${context.cwd}`,
    `Model: ${context.model}`,
    `Permission: ${context.permissionMode}`,
    fileSection ? `${fileSection}` : "",
  ].filter(Boolean).join("\n");
}

function ensureConversations() {
  if (!db.data.conversations || typeof db.data.conversations !== "object") {
    db.data.conversations = {};
  }
  return db.data.conversations;
}

function getConversationRecord(conversationId) {
  if (!conversationId) return null;
  const conversations = ensureConversations();
  return conversations[conversationId] || null;
}

function listConversationRecords() {
  return Object.values(ensureConversations());
}

function ensureArchivedTasks() {
  if (!Array.isArray(db.data.archivedTasks)) {
    db.data.archivedTasks = [];
  }
  return db.data.archivedTasks;
}

function isArchivedConversation(record) {
  return Boolean(record?.archivedAt);
}

function activeTaskList() {
  const archivedIds = new Set(
    listConversationRecords()
      .filter(isArchivedConversation)
      .map((record) => record.id),
  );
  return (db.data.tasks || [])
    .filter((task) => !task.conversationId || !archivedIds.has(task.conversationId));
}

function archivedConversationSummaries() {
  const archivedTasks = ensureArchivedTasks();
  return listConversationRecords()
    .filter(isArchivedConversation)
    .map((record) => {
      const tasks = archivedTasks
        .filter((task) => task.conversationId === record.id)
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const latestTask = tasks[0] || null;
      const firstTask = tasks[tasks.length - 1] || latestTask;
      return {
        id: record.id,
        cwd: record.cwd || latestTask?.cwd || "",
        model: record.model || latestTask?.model || "",
        title: firstTask?.prompt || record.messages?.find((message) => message.role === "user")?.content || "未命名对话",
        taskCount: tasks.length,
        archivedAt: record.archivedAt,
        archivedReason: record.archivedReason || "",
        createdAt: record.createdAt || firstTask?.createdAt || record.archivedAt,
        updatedAt: record.updatedAt || latestTask?.createdAt || record.archivedAt,
        latestTaskId: latestTask?.id || null,
      };
    })
    .sort((a, b) => new Date(b.archivedAt || 0).getTime() - new Date(a.archivedAt || 0).getTime());
}

function upsertConversationRecord(record) {
  const conversations = ensureConversations();
  conversations[record.id] = record;
  return record;
}

function createConversationRecord(task, context, conversationId) {
  const now = new Date().toISOString();
  return upsertConversationRecord({
    id: conversationId || createConversationId(),
    createdAt: now,
    updatedAt: now,
    cwd: context.cwd,
    model: context.model,
    permissionMode: context.permissionMode,
    openaiBaseUrl: context.openaiBaseUrl,
    provider: "claw",
    stablePrefix: stableTaskPrefix(task, context),
    messages: [],
    taskIds: [],
  });
}

function sameWorkspacePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function getConversationRecordForWorkspace(conversationId, cwd) {
  const record = getConversationRecord(conversationId);
  if (!record) return null;
  return sameWorkspacePath(record.cwd, cwd) ? record : null;
}

function rekeyConversationRecord(previousId, nextId, override = null) {
  if (!previousId || !nextId || previousId === nextId) return getConversationRecord(nextId);
  const conversations = ensureConversations();
  const current = conversations[previousId];
  if (!current) return null;
  const merged = {
    ...current,
    ...(override || {}),
    id: nextId,
    updatedAt: new Date().toISOString(),
  };
  delete conversations[previousId];
  conversations[nextId] = merged;
  return merged;
}

function migrateLegacySingleTurnConversationIds() {
  const conversations = ensureConversations();
  const tasksByConversation = new Map();
  const allTasks = [...(db.data.tasks || []), ...ensureArchivedTasks()];
  for (const task of allTasks) {
    if (!task?.conversationId || !isSingleTurnConversationId(task.conversationId)) continue;
    const tasks = tasksByConversation.get(task.conversationId) || [];
    tasks.push(task);
    tasksByConversation.set(task.conversationId, tasks);
  }

  for (const [legacyId, tasks] of tasksByConversation.entries()) {
    const workspaceKeys = new Set(
      tasks
        .map((task) => normalizeWorkspacePathKey(task.cwd))
        .filter(Boolean),
    );
    const record = conversations[legacyId] || null;
    if (record?.cwd) {
      const normalizedRecordPath = normalizeWorkspacePathKey(record.cwd);
      if (normalizedRecordPath) {
        workspaceKeys.add(normalizedRecordPath);
      }
    }
    if (workspaceKeys.size !== 1) continue;

    const workspacePath = tasks.find((task) => normalizeWorkspacePath(task.cwd, ""))?.cwd || record?.cwd || "";
    const nextId = singleTurnConversationIdForWorkspace(workspacePath);
    if (!nextId || nextId === legacyId) continue;

    for (const task of db.data.tasks || []) {
      if (task.conversationId === legacyId && sameWorkspacePath(task.cwd || "", workspacePath)) {
        task.conversationId = nextId;
      }
    }
    for (const task of ensureArchivedTasks()) {
      if (task.conversationId === legacyId && sameWorkspacePath(task.cwd || "", workspacePath)) {
        task.conversationId = nextId;
      }
    }

    const nextRecord = conversations[nextId];
    if (record && !nextRecord) {
      rekeyConversationRecord(legacyId, nextId, {
        cwd: record.cwd || workspacePath,
        provider: "claw",
      });
    } else if (record && nextRecord) {
      nextRecord.messages = [...(nextRecord.messages || []), ...(record.messages || [])].slice(-maxConversationTurns * 2);
      nextRecord.taskIds = [...new Set([...(nextRecord.taskIds || []), ...(record.taskIds || []), ...tasks.map((task) => task.id)])].slice(-100);
      nextRecord.cwd = nextRecord.cwd || record.cwd || workspacePath;
      nextRecord.provider = "claw";
      nextRecord.updatedAt = new Date().toISOString();
      delete conversations[legacyId];
    }
  }

  for (const [conversationId, record] of Object.entries(conversations)) {
    if (!isSingleTurnConversationId(conversationId)) continue;
    const nextId = singleTurnConversationIdForWorkspace(record?.cwd || "");
    if (!nextId || nextId === conversationId) continue;
    const referenced = allTasks.some((task) => task.conversationId === conversationId);
    if (referenced) continue;
    rekeyConversationRecord(conversationId, nextId, {
      provider: "claw",
    });
  }

  for (const task of allTasks) {
    if (!isSingleTurnConversationId(task?.conversationId) || !task?.cwd) continue;
    const nextId = singleTurnConversationIdForWorkspace(task.cwd);
    if (!nextId || nextId === task.conversationId) continue;
    const currentRecord = conversations[task.conversationId] || null;
    const nextRecord = conversations[nextId] || null;
    task.conversationId = nextId;
    if (currentRecord && !nextRecord) {
      rekeyConversationRecord(currentRecord.id, nextId, {
        cwd: currentRecord.cwd || task.cwd,
        provider: "claw",
      });
      continue;
    }
    if (currentRecord && nextRecord && currentRecord.id !== nextRecord.id) {
      nextRecord.messages = [...(nextRecord.messages || []), ...(currentRecord.messages || [])].slice(-maxConversationTurns * 2);
      nextRecord.taskIds = [...new Set([...(nextRecord.taskIds || []), ...(currentRecord.taskIds || []), task.id])].slice(-100);
      nextRecord.cwd = nextRecord.cwd || currentRecord.cwd || task.cwd;
      nextRecord.provider = "claw";
      nextRecord.updatedAt = new Date().toISOString();
      delete conversations[currentRecord.id];
    }
  }
}

function appendConversationMessage(record, role, content) {
  const next = normalizeConversationMessage(content);
  if (!next) return record;
  record.messages.push({ role, content: next, createdAt: new Date().toISOString() });
  record.messages = record.messages.slice(-maxConversationTurns * 2);
  record.updatedAt = new Date().toISOString();
  return record;
}

function appendAssistantConversationMessage(record, content, reasoningContent = "", reasoningSignature = "") {
  const nextContent = normalizeConversationMessage(content);
  const nextReasoningContent = normalizeConversationMessage(reasoningContent);
  const nextReasoningSignature = normalizeConversationMessage(reasoningSignature);
  if (!nextContent && !nextReasoningContent) return record;
  record.messages.push({
    role: "assistant",
    content: nextContent,
    reasoning_content: nextReasoningContent || undefined,
    reasoning_signature: nextReasoningSignature || undefined,
    createdAt: new Date().toISOString(),
  });
  record.messages = record.messages.slice(-maxConversationTurns * 2);
  record.updatedAt = new Date().toISOString();
  return record;
}

function attachTaskToConversation(record, taskId) {
  if (!taskId) return record;
  record.taskIds = [...new Set([...(record.taskIds || []), taskId])].slice(-100);
  record.updatedAt = new Date().toISOString();
  return record;
}

function sanitizeWorktreeName(value) {
  const name = normalizeString(value, "", { max: maxWorktreeNameChars });
  if (!name) return "";
  if (!/^[\p{L}\p{N}._ -]+$/u.test(name)) return "";
  return name.replace(/\s+/g, " ").trim();
}

function slugifyWorktreeName(value) {
  return sanitizeWorktreeName(value)
    .toLowerCase()
    .replace(/[^a-z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function runGitCommand(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, PATH: runtimePathEnv() },
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args.join(" ")} failed.`);
  }
  return (result.stdout || "").trim();
}

function resolveGitRoot(startPath) {
  return runGitCommand(["rev-parse", "--show-toplevel"], startPath);
}

function ensureWorktreeTargetPath(sourcePath, name) {
  const sourceDir = path.resolve(sourcePath);
  const slug = slugifyWorktreeName(name);
  if (!slug) {
    throw new Error("项目名称无效，请使用字母、数字、空格、点、下划线或短横线。");
  }
  const nextPath = path.join(sourceDir, ".claw", "worktrees", slug);
  if (fs.existsSync(nextPath)) {
    throw new Error("目标工作树目录已存在，请更换项目名称。");
  }
  if (!isPathInside(sourceDir, nextPath)) {
    throw new Error("安全限制：目标工作树路径必须在工作区内部。");
  }
  return nextPath;
}

function cloneAttachedFiles(files, nextCwd) {
  return (files || []).map((file) => {
    if (!file?.path) return file;
    const cloned = { ...file };
    const absolutePath = path.isAbsolute(file.path) ? file.path : path.resolve(nextCwd, file.path);
    if (absolutePath.startsWith(nextCwd)) {
      cloned.path = absolutePath;
    } else {
      const basename = path.basename(file.path);
      cloned.path = path.join(nextCwd, basename);
    }
    return cloned;
  });
}

function cloneConversationRecordForWorktree(record, sourcePath, nextPath, name) {
  const nextId = createConversationId();
  const now = new Date().toISOString();
  const sourceNormalized = path.resolve(sourcePath);
  const nextNormalized = path.resolve(nextPath);
  const cloneContent = (content) => String(content || "").split(sourceNormalized).join(nextNormalized);
  return {
    ...record,
    id: nextId,
    cwd: nextNormalized,
    archivedAt: null,
    archivedReason: null,
    sourceConversationId: record.id,
    clonedFromConversationId: record.id,
    clonedForWorkspaceName: name,
    createdAt: now,
    updatedAt: now,
    messages: (record.messages || []).map((message) => ({
      ...message,
      content: cloneContent(message.content),
    })),
    taskIds: [],
    stablePrefix: cloneContent(record.stablePrefix),
  };
}

function cloneTaskForWorktree(task, nextConversationId, nextCwd) {
  const now = new Date().toISOString();
  return {
    ...task,
    id: crypto.randomUUID(),
    conversationId: nextConversationId,
    cwd: nextCwd,
    files: cloneAttachedFiles(task.files, nextCwd),
    createdAt: now,
    startedAt: task.startedAt || now,
    finishedAt: task.finishedAt || now,
  };
}

function createArchivedConversationForTasks(tasks, cwd, now) {
  const firstTask = [...tasks].sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())[0];
  return upsertConversationRecord({
    id: createConversationId(),
    createdAt: firstTask?.createdAt || now,
    updatedAt: now,
    cwd,
    model: firstTask?.model || db.data.preferences.defaultModel,
    permissionMode: firstTask?.permissionMode || db.data.preferences.permissionMode,
    openaiBaseUrl: db.data.preferences.openaiBaseUrl || "",
    provider: "claw",
    stablePrefix: stableTaskPrefix(firstTask || { files: [] }, {
      cwd,
      model: firstTask?.model || db.data.preferences.defaultModel,
      permissionMode: firstTask?.permissionMode || db.data.preferences.permissionMode,
    }),
    messages: [],
    taskIds: tasks.map((task) => task.id),
    archivedAt: now,
    archivedReason: "workspace-archive",
  });
}

function archiveConversation(conversationId) {
  const id = sanitizeConversationId(conversationId, "");
  if (!id) {
    throw new Error("请选择要归档的对话。");
  }

  const now = new Date().toISOString();
  const activeTasks = (db.data.tasks || []).filter((task) => task.conversationId === id || (!task.conversationId && task.id === id));

  if (activeTasks.some((task) => ["pending", "running"].includes(task.status))) {
    throw new Error("该对话还有正在运行的任务，请完成或取消后再归档。");
  }

  // Ensure a conversation record exists
  const record = getConversationRecord(id) || (() => {
    const firstTask = activeTasks[0];
    return createConversationRecord(firstTask || { files: [] }, {
      cwd: firstTask?.cwd || db.data.preferences.workspacePath,
      model: firstTask?.model || db.data.preferences.defaultModel,
      permissionMode: firstTask?.permissionMode || db.data.preferences.permissionMode,
      openaiBaseUrl: db.data.preferences.openaiBaseUrl || "",
    }, id);
  })();

  record.archivedAt = now;
  record.archivedReason = "conversation-archive";
  activeTasks.forEach((task) => {
    if (!task.conversationId) {
      task.conversationId = record.id;
    }
    attachTaskToConversation(record, task.id);
  });
  upsertConversationRecord(record);

  // Move tasks to archived storage
  const archivedTaskIds = new Set(activeTasks.map((task) => task.id));
  const previousArchived = ensureArchivedTasks().filter((task) => !archivedTaskIds.has(task.id));
  db.data.archivedTasks = [...activeTasks, ...previousArchived].slice(0, 500);
  db.data.tasks = (db.data.tasks || []).filter((task) => !archivedTaskIds.has(task.id));

  return {
    archivedConversations: archivedConversationSummaries(),
    tasks: activeTaskList(),
    archivedCount: 1,
    taskCount: activeTasks.length,
  };
}

function archiveWorkspaceConversations(workspacePath) {
  const cwd = normalizeWorkspacePath(workspacePath, "");
  if (!cwd) {
    throw new Error("请选择要归档的工作区。");
  }

  const now = new Date().toISOString();
  const activeTasks = (db.data.tasks || []).filter((task) => path.resolve(task.cwd || "") === path.resolve(cwd));
  if (!activeTasks.length) {
    return {
      archivedConversations: archivedConversationSummaries(),
      tasks: activeTaskList(),
      archivedCount: 0,
      taskCount: 0,
    };
  }
  if (activeTasks.some((task) => ["pending", "running"].includes(task.status))) {
    throw new Error("该工作区还有正在运行的任务，请完成或取消后再归档。");
  }

  const conversationGroups = new Map();
  const looseTasks = [];
  activeTasks.forEach((task) => {
    if (task.conversationId) {
      const tasks = conversationGroups.get(task.conversationId) || [];
      tasks.push(task);
      conversationGroups.set(task.conversationId, tasks);
    } else {
      looseTasks.push(task);
    }
  });

  const archivedConversationIds = new Set();
  conversationGroups.forEach((tasks, conversationId) => {
    const record = getConversationRecord(conversationId) || createConversationRecord(tasks[0], {
      cwd,
      model: tasks[0]?.model || db.data.preferences.defaultModel,
      permissionMode: tasks[0]?.permissionMode || db.data.preferences.permissionMode,
      openaiBaseUrl: db.data.preferences.openaiBaseUrl || "",
    }, conversationId);
    record.cwd = record.cwd || cwd;
    record.archivedAt = now;
    record.archivedReason = "workspace-archive";
    tasks.forEach((task) => attachTaskToConversation(record, task.id));
    upsertConversationRecord(record);
    archivedConversationIds.add(record.id);
  });

  if (looseTasks.length) {
    const record = createArchivedConversationForTasks(looseTasks, cwd, now);
    looseTasks.forEach((task) => {
      task.conversationId = record.id;
    });
    archivedConversationIds.add(record.id);
  }

  const archivedTaskIds = new Set(activeTasks.map((task) => task.id));
  const previousArchived = ensureArchivedTasks().filter((task) => !archivedTaskIds.has(task.id));
  db.data.archivedTasks = [...activeTasks, ...previousArchived].slice(0, 500);
  db.data.tasks = (db.data.tasks || []).filter((task) => !archivedTaskIds.has(task.id));

  return {
    archivedConversations: archivedConversationSummaries(),
    tasks: activeTaskList(),
    archivedCount: archivedConversationIds.size,
    taskCount: activeTasks.length,
  };
}

function restoreArchivedConversation(conversationId) {
  const id = sanitizeConversationId(conversationId, "");
  if (!id) {
    throw new Error("请选择要恢复的对话。");
  }

  const record = getConversationRecord(id);
  if (!record || !record.archivedAt) {
    throw new Error("未找到已归档对话。");
  }

  const archivedTasks = ensureArchivedTasks();
  const restoringTasks = archivedTasks.filter((task) => task.conversationId === id);
  db.data.archivedTasks = archivedTasks.filter((task) => task.conversationId !== id);
  delete record.archivedAt;
  delete record.archivedReason;
  record.updatedAt = new Date().toISOString();
  upsertConversationRecord(record);

  const existingIds = new Set((db.data.tasks || []).map((task) => task.id));
  db.data.tasks = [
    ...restoringTasks.filter((task) => !existingIds.has(task.id)),
    ...(db.data.tasks || []),
  ]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, 100);

  return {
    archivedConversations: archivedConversationSummaries(),
    tasks: activeTaskList(),
    restoredTaskCount: restoringTasks.length,
    latestTaskId: restoringTasks
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())[0]?.id || null,
  };
}

function createWorktreeProject(sourcePath, name) {
  const normalizedSource = path.resolve(sourcePath);
  if (!fs.existsSync(normalizedSource) || !fs.statSync(normalizedSource).isDirectory()) {
    throw new Error("源工作区不存在。");
  }

  const gitRoot = resolveGitRoot(normalizedSource);
  const nextPath = ensureWorktreeTargetPath(normalizedSource, name);
  runGitCommand(["worktree", "add", nextPath, "HEAD"], gitRoot);

  const sourceTasks = (db.data.tasks || []).filter((task) => path.resolve(task.cwd || "") === normalizedSource);
  const sourceConversationIds = [...new Set(sourceTasks.map((task) => task.conversationId).filter(Boolean))];
  const conversationIdMap = new Map();
  let clonedConversationCount = 0;

  sourceConversationIds.forEach((conversationId) => {
    const record = getConversationRecord(conversationId);
    if (!record) return;
    const clonedRecord = cloneConversationRecordForWorktree(record, normalizedSource, nextPath, name);
    conversationIdMap.set(conversationId, clonedRecord.id);
    upsertConversationRecord(clonedRecord);
    clonedConversationCount += 1;
  });

  const clonedTasks = sourceTasks.map((task) => {
    const nextConversationId = task.conversationId ? conversationIdMap.get(task.conversationId) || null : null;
    const clonedTask = cloneTaskForWorktree(task, nextConversationId, nextPath);
    if (nextConversationId) {
      const record = getConversationRecord(nextConversationId);
      if (record) attachTaskToConversation(record, clonedTask.id);
    }
    return clonedTask;
  });

  db.data.tasks = [...clonedTasks, ...db.data.tasks].slice(0, 100);
  return {
    name,
    path: nextPath,
    sourcePath: normalizedSource,
    clonedTaskCount: clonedTasks.length,
    clonedConversationCount,
    latestTaskId: clonedTasks[0]?.id || null,
  };
}

function hasReplPromptSuffix(value) {
  return /(?:^|\n)> $/.test(String(value || ""));
}

function findPermissionPrompt(text) {
  const trimmed = text.trim();
  
  // Look for standard options at the end
  const suffixMatch = trimmed.match(/(?:\[[yYnN\/ ]+\]|\([yYnN\/ ]+\)|\?|\/approve|\/deny)\s*$/i);
  if (!suffixMatch) return null;
  
  const lower = trimmed.toLowerCase();
  const keywords = ["do you want to", "allow", "would you like to", "run", "execute", "command", "tool", "write", "read", "file", "create", "modify", "approve", "deny"];
  const hasKeyword = keywords.some(kw => lower.includes(kw));
  
  if (hasKeyword) {
    // Return the last 200 chars as the unique question identifier
    return trimmed.slice(-200);
  }
  
  return null;
}

function sanitizeAndOpenUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return;
  
  let cleanUrl = rawUrl.trim();
  
  // Clean trailing punctuation, asterisks, brackets, parentheses
  cleanUrl = cleanUrl.replace(/[\s*#(),.;:"'`<>]+$/, "");
  
  // If there's an active hash fragment containing Chinese characters or space, strip the hash entirely
  if (/#.*[^\x00-\x7F\s]/.test(cleanUrl) || /#\s+/.test(cleanUrl)) {
    cleanUrl = cleanUrl.split("#")[0];
  }
  
  // Strip any trailing non-ASCII characters or spaces just in case
  cleanUrl = cleanUrl.replace(/[^\x21-\x7E]+$/, "");
  
  console.log(`[URL Sanitization] Raw: "${rawUrl}" -> Cleaned: "${cleanUrl}"`);
  
  if (cleanUrl.startsWith("http:") || cleanUrl.startsWith("https:")) {
    shell.openExternal(cleanUrl).catch((err) => {
      console.error(`Failed to open external link: ${cleanUrl}`, err);
    });
  }
}

function getPromptAnswer(question, context) {
  const lowerQuestion = question.toLowerCase();
  const mode = context.permissionMode;
  
  if (mode === "danger-full-access") {
    if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
      return "/approve\r";
    }
    return "y\r";
  }
  
  if (mode === "read-only") {
    if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
      return "/deny\r";
    }
    return "n\r";
  }
  
  if (mode === "workspace-write") {
    if (lowerQuestion.includes("command") || lowerQuestion.includes("execute") || lowerQuestion.includes("terminal") || lowerQuestion.includes("run")) {
      if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
        return "/deny\r";
      }
      return "n\r";
    }
    
    const pathRegex = /(?:\/Users\/[^\s'"`()]+|\b[a-zA-Z0-9._-]+\/[a-zA-Z0-9._\/-]+)/g;
    const matches = question.match(pathRegex) || [];
    
    let pathFound = false;
    let pathInside = false;
    
    for (const match of matches) {
      pathFound = true;
      const absPath = path.isAbsolute(match) ? match : path.resolve(context.cwd, match);
      if (isPathInside(context.cwd, absPath)) {
        pathInside = true;
        break;
      }
    }
    
    if (pathFound) {
      if (pathInside) {
        if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
          return "/approve\r";
        }
        return "y\r";
      } else {
        if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
          return "/deny\r";
        }
        return "n\r";
      }
    }
    
    if (lowerQuestion.includes("write") || lowerQuestion.includes("create") || lowerQuestion.includes("modify") || lowerQuestion.includes("edit")) {
      if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
        return "/approve\r";
      }
      return "y\r";
    }
    
    if (lowerQuestion.includes("/approve") || lowerQuestion.includes("/deny")) {
      return "/deny\r";
    }
    return "n\r";
  }
  
  return "n\r";
}

function trimReplPromptSuffix(value) {
  return String(value || "").replace(/(?:^|\n)> $/, (match) => (match.startsWith("\n") ? "\n" : ""));
}

function stripPromptEcho(value, prompt) {
  let output = String(value || "");
  const normalizedPrompt = normalizeLineEndings(prompt);
  const candidates = [
    `${normalizedPrompt}\n`,
    `${normalizedPrompt}\n^D`,
    `${normalizedPrompt}^D`,
  ];
  for (const candidate of candidates) {
    if (output.startsWith(candidate)) {
      output = output.slice(candidate.length);
      break;
    }
  }
  if (output.startsWith(normalizedPrompt)) {
    output = output.slice(normalizedPrompt.length);
  } else {
    const maxPrefix = Math.min(output.length, normalizedPrompt.length);
    const minPrefix = Math.min(48, maxPrefix);
    for (let length = maxPrefix; length >= minPrefix; length -= 1) {
      if (output.startsWith(normalizedPrompt.slice(0, length))) {
        output = output.slice(length);
        break;
      }
    }
  }
  return output.replace(/^\n+/, "");
}

function stripLeadingSkillToolingNoise(value) {
  let output = String(value || "");

  output = output.replace(/^\s*╭─ Skill ─╮[\s\S]*?╰[^\n]*╯\s*/u, "");

  while (/^\s*✓ Skill\s*\n/u.test(output)) {
    const closingIndex = output.search(/\n\}\s*(?:\n|$)/u);
    if (closingIndex === -1) break;
    output = output.slice(closingIndex).replace(/^\n\}\s*/u, "");
  }

  return output;
}

function extractEmbeddedTaskError(value) {
  const text = String(value || "");
  const match = text.match(/\[error-kind:[^\]]+\][\s\S]*?Run `claw --help` for usage\./u);
  return match?.[0]?.trim() || "";
}

function sanitizeTaskOutput(value, prompt, options = {}) {
  const trimPrompt = options.trimPrompt !== false;
  let output = trimPrompt ? trimReplPromptSuffix(value) : String(value || "");
  output = stripPromptEcho(output, prompt);
  output = output.replace(/^\s*(?:Slash 命令|命令):[\s\S]*?(?=(?:╭─ Skill ─╮|✓ Skill|\[error-kind:))/u, "");
  output = stripLeadingSkillToolingNoise(output);
  output = output
    .replace(/^\s*[\u001b\[\]0-9;?]*[^\S\n]*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]?[^\n]*Thinking\.\.\.[^\n]*\n?/gim, "")
    .replace(/^\s*[▶>]\s*Thinking \(\d+ chars hidden\)\s*\n?/gim, "")
    .replace(/^[^\n]*Thinking \(\d+ chars hidden\)[^\n]*\n?/gim, "")
    .replace(/^\s*7\s*8\s*\n+/gm, "")
    .replace(/^\s*78\s*\n+/gm, "")
    .replace(/^[^\n]*✨ Done[^\n]*\n?/gm, "")
    .replace(/^[^\n]*❌ Request failed[^\n]*\n?/gm, "")
    .replace(/\[error-kind:[^\]]+\][\s\S]*?Run `claw --help` for usage\./gu, "");
  output = output
    ;
  return output.replace(/^\n+/, "");
}

function normalizeForDeduplication(value) {
  return String(value || "")
    .replace(/[`*#>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeDuplicateLeadingSection(output) {
  const text = String(output || "").trim();
  if (!text) return "";

  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length < 2) return text;

  const first = blocks[0];
  const second = blocks[1];
  const firstNorm = normalizeForDeduplication(first);
  const secondNorm = normalizeForDeduplication(second);
  const third = blocks[2] || "";
  const thirdNorm = normalizeForDeduplication(third);

  if (!firstNorm || !secondNorm) return text;
  const firstLead = firstNorm.split(/[：:]/)[0]?.trim() || "";
  const secondLead = secondNorm.split(/[：:]/)[0]?.trim() || "";
  const thirdLead = thirdNorm.split(/[：:]/)[0]?.trim() || "";

  if (firstLead && secondLead && firstLead === secondLead && second.includes("- **")) {
    return [second, ...blocks.slice(2)].join("\n\n").trim();
  }

  if (firstLead && secondLead && third && firstLead === secondLead && third.includes("- **")) {
    return [second, third, ...blocks.slice(3)].join("\n\n").trim();
  }

  if (firstLead && thirdLead && third && firstLead === thirdLead && third.includes("- **")) {
    return [third, ...blocks.slice(3)].join("\n\n").trim();
  }

  if (!secondNorm.includes(firstNorm)) return text;

  return [second, ...blocks.slice(2)].join("\n\n").trim();
}

function extractSessionMetadata(value) {
  const text = String(value || "");
  const sessionIdMatch = text.match(/\nSession\s+([^\n]+)/);
  const sessionPathMatch = text.match(/\nAuto-save\s+([^\n]+)/);
  return {
    sessionId: sessionIdMatch?.[1]?.trim() || "",
    sessionPath: sessionPathMatch?.[1]?.trim() || "",
  };
}

function createSessionKey(context) {
  return crypto.createHash("sha256").update(JSON.stringify({
    clawPath: context.clawPath,
    cwd: context.cwd,
    model: context.model,
    permissionMode: context.permissionMode,
    openaiBaseUrl: context.openaiBaseUrl,
    openaiCompatEnabled: context.openaiCompatEnabled,
    openaiApiKeyHash: context.openaiApiKeyHash,
    anthropicBaseUrl: context.anthropicBaseUrl,
    anthropicApiKeyHash: context.anthropicApiKeyHash,
    anthropicAuthTokenHash: context.anthropicAuthTokenHash,
  })).digest("hex");
}

function stripOpenAiModelPrefix(model) {
  if (typeof model !== "string") return model;
  return model.startsWith("openai/") ? model.slice("openai/".length) : model;
}

async function transcribeSpeechOffline(preferences, payload) {
  if (preferences.offlineSpeechEnabled === false) {
    throw new Error("当前已关闭离线语音转写。");
  }
  if (typeof payload?.audioBase64 !== "string" || !payload.audioBase64.trim()) {
    throw new Error("缺少音频数据。");
  }

  const audioBuffer = Buffer.from(payload.audioBase64, "base64");
  if (!audioBuffer.length) {
    throw new Error("音频数据为空。");
  }
  if (audioBuffer.length > maxSpeechAudioBytes) {
    throw new Error("音频片段过大，请缩短单次录音时长后重试。");
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claw-speech-"));
  const extension = String(payload?.mimeType || "").includes("mp4") ? "m4a" : "webm";
  const audioPath = path.join(tempDir, `speech.${extension}`);
  const wavPath = path.join(tempDir, "speech.wav");
  const scriptPath = path.join(__dirname, "offline_transcribe.py");
  await fs.promises.writeFile(audioPath, audioBuffer);

  try {
    const ffmpegResult = await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-i",
        audioPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        wavPath,
      ], {
        env: { ...process.env, PATH: runtimePathEnv() },
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve(true);
          return;
        }
        reject(new Error(stderr || "ffmpeg 转码失败。"));
      });
    });

    if (!ffmpegResult) {
      throw new Error("ffmpeg 转码失败。");
    }

    const output = await new Promise((resolve, reject) => {
      const child = spawn("python3", [
        scriptPath,
        "--input",
        wavPath,
        "--model",
        normalizeOfflineSpeechModel(preferences.offlineSpeechModel, "mlx-community/whisper-tiny"),
        ...(payload?.language ? ["--language", String(payload.language)] : []),
      ], {
        env: { ...process.env, PATH: runtimePathEnv() },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0 || code === 1 || code === 2) {
          resolve({ stdout, stderr, code });
          return;
        }
        reject(new Error(stderr || stdout || "离线转写失败。"));
      });
    });

    const parsed = JSON.parse(String(output.stdout || "{}"));
    if (!parsed.ok) {
      throw new Error(parsed.error || "离线转写失败。");
    }
    const text = normalizeString(parsed.text, "", { max: 20_000, trim: false }).trim();
    if (!text) {
      throw new Error("离线转写返回了空结果。");
    }
    return {
      text,
      model: normalizeOfflineSpeechModel(preferences.offlineSpeechModel, "mlx-community/whisper-tiny"),
      provider: "offline-mlx-whisper",
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function createTaskChunkEmitter(task) {
  return async (stream, chunk, options = {}) => {
    const normalized = sanitizeTaskOutput(chunk, task.prompt, {
      trimPrompt: options.trimPrompt ?? stream === "stdout",
    });
    if (!normalized) return "";

    if (stream === "stdout") {
      task.output = appendCapped(task.output, normalized, maxTaskOutputChars);
    } else {
      task.error = appendCapped(task.error, normalized, maxTaskOutputChars);
    }

    const event = createTaskEvent(task.id, stream, normalized);
    task.events.push(event);
    task.events = task.events.slice(-maxTaskEvents);
    emitTaskEvent("task:chunk", event);
    schedulePersistTask(task);
    appendTaskLog(task, stream, normalized).catch((error) => {
      console.error(`Failed to append ${stream} log:`, safeErrorMessage(error));
    });
    return normalized;
  };
}

function buildOpenAiMessages(record, prompt) {
  const messages = [];
  if (record?.stablePrefix) {
    messages.push({ role: "system", content: record.stablePrefix });
  }
  for (const message of record?.messages || []) {
    if (!message?.role || !message?.content) continue;
    if (message.role === "assistant" && message.reasoning_content) {
      messages.push({
        role: message.role,
        content: message.content,
        reasoning_content: message.reasoning_content,
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  messages.push({ role: "user", content: normalizeConversationMessage(prompt) });
  return messages;
}

function buildConversationReplayPrompt(record, prompt) {
  const messages = buildOpenAiMessages(record, prompt);
  const transcript = messages.map((message) => {
    if (message.role === "system") {
      return `System:\n${message.content}`;
    }
    if (message.role === "assistant") {
      const reasoning = message.reasoning_content ? `\n\nAssistant reasoning:\n${message.reasoning_content}` : "";
      return `Assistant:\n${message.content}${reasoning}`;
    }
    return `User:\n${message.content}`;
  }).join("\n\n");
  return [
    "Continue the conversation below and answer only the final user request.",
    "Preserve continuity with prior turns even though this request is being replayed in one-shot mode.",
    "",
    transcript,
  ].join("\n");
}

function hashSecret(value) {
  if (!value) return "";
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function buildExecutionContext(task, preferences) {
  const anthropicApiKey = decryptSecret(preferences.secrets.anthropicApiKey);
  const anthropicAuthToken = decryptSecret(preferences.secrets.anthropicAuthToken);
  const openaiApiKey = decryptSecret(preferences.secrets.openaiApiKey);
  const model = resolveModelForExecution(task.model || preferences.defaultModel, preferences);
  return {
    cwd: normalizeWorkspacePath(task.cwd, preferences.workspacePath),
    model,
    permissionMode: task.permissionMode || preferences.permissionMode,
    clawPath: resolveClawPath(preferences),
    openaiBaseUrl: preferences.openaiBaseUrl || "",
    openaiCompatEnabled: preferences.openaiCompatEnabled === true,
    openaiApiKey,
    openaiCompatibleModel: isOpenAiCompatibleModel(model),
    anthropicBaseUrl: "",
    anthropicApiKey,
    anthropicAuthToken,
    openaiApiKeyHash: hashSecret(openaiApiKey),
    anthropicApiKeyHash: hashSecret(anthropicApiKey),
    anthropicAuthTokenHash: hashSecret(anthropicAuthToken),
  };
}

async function buildTaskEnvironment(context) {
  const env = {
    ...process.env,
    PATH: runtimePathEnv(),
  };

  if (context.anthropicApiKey) env.ANTHROPIC_API_KEY = context.anthropicApiKey;
  if (context.anthropicAuthToken) env.ANTHROPIC_AUTH_TOKEN = context.anthropicAuthToken;
  if (context.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = context.anthropicBaseUrl;
  if (context.openaiApiKey) env.OPENAI_API_KEY = context.openaiApiKey;
  if (context.openaiBaseUrl) env.OPENAI_BASE_URL = context.openaiBaseUrl;

  return env;
}

function validateExecutionContext(context) {
  if (!context.openaiCompatEnabled || !context.openaiCompatibleModel) return null;
  const missing = [];
  if (!context.openaiApiKey) missing.push("OpenAI API Key");
  if (!context.openaiBaseUrl) missing.push("OpenAI Base URL");
  if (!missing.length) return null;
  return new Error(
    `OpenAI-compatible 模型 ${context.model} 缺少运行配置：${missing.join("、")}。请在设置中补全对应项，或关闭 OpenAI-compatible 开关。`
  );
}

async function closeReplSession(session) {
  if (!session?.child || session.closed) return;
  try {
    session.child.stdin.write("/exit\r");
  } catch {
    // ignore
  }

  const result = await Promise.race([
    new Promise((resolve) => {
      session.closeResolvers.add(resolve);
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), replShutdownTimeoutMs)),
  ]);

  if (!result) {
    try {
      session.child.kill();
    } catch {
      // ignore
    }
  }
}

async function disposeActiveReplSession() {
  const session = activeReplSession;
  activeReplSession = null;
  if (!session) return;
  try {
    await closeReplSession(session);
  } catch {
    // ignore shutdown errors
  }
}

function waitForReplReady(session) {
  return new Promise((resolve, reject) => {
    if (session.ready) {
      resolve(session);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for claw REPL to become ready."));
    }, replStartupTimeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      session.readyResolvers.delete(onReady);
      session.readyRejectors.delete(onError);
    };

    const onReady = () => {
      cleanup();
      resolve(session);
    };

    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || "REPL startup failed.")));
    };

    session.readyResolvers.add(onReady);
    session.readyRejectors.add(onError);
  });
}

function maybeResolveReadyFromBuffer(session) {
  if (session.ready) return;
  const startup = normalizeTerminalOutput(session.startupBuffer);
  if (!hasReplPromptSuffix(startup)) return;
  session.ready = true;
  const meta = extractSessionMetadata(startup);
  session.sessionId = meta.sessionId;
  session.sessionPath = meta.sessionPath;
  session.outputCarry = "";
  for (const resolve of session.readyResolvers) resolve();
  session.readyResolvers.clear();
  session.readyRejectors.clear();
}

function maybeResolvePromptFromBuffer(session) {
  if (!session.promptResolvers.length) return;
  if (!hasReplPromptSuffix(session.outputCarry)) return;
  const current = session.promptResolvers.shift();
  clearTimeout(current.timer);
  const output = session.outputCarry;
  const stderr = session.stderrBuffer;
  session.outputCarry = "";
  session.stderrBuffer = "";
  session.lastRespondedQuestion = null;
  current.resolve({ stdout: output, stderr });
}

async function emitReplDelta(session, stream, fullText) {
  const current = session.promptResolvers[0];
  if (!current?.onChunk) return;

  const key = stream === "stderr" ? "emittedStderrLength" : "emittedStdoutLength";
  const previousLength = current[key] || 0;
  if (fullText.length <= previousLength) return;

  const delta = fullText.slice(previousLength);
  current[key] = fullText.length;
  await current.onChunk(stream, delta);
}

function createPromptResolver(session, onChunk) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = session.promptResolvers.findIndex((entry) => entry.resolve === resolvePrompt);
      if (index !== -1) session.promptResolvers.splice(index, 1);
      reject(new Error("Timed out waiting for claw REPL response."));
    }, replPromptTimeoutMs);

    const resolvePrompt = (value) => resolve(value);
    session.promptResolvers.push({
      resolve: resolvePrompt,
      reject,
      timer,
      onChunk,
      emittedStdoutLength: 0,
      emittedStderrLength: 0,
    });

    if (session.closed) {
      clearTimeout(timer);
      session.promptResolvers = session.promptResolvers.filter((entry) => entry.resolve !== resolvePrompt);
      reject(new Error("claw REPL session is not available."));
    }
  });
}

function createUnexpectedReplExitError(exitCode, signal) {
  const error = new Error(`claw REPL exited unexpectedly (${exitCode ?? "null"}${signal ? `, ${signal}` : ""}).`);
  error.name = "ClawReplUnexpectedExitError";
  error.replExitCode = exitCode ?? null;
  error.replSignal = signal || null;
  return error;
}

function isRecoverableReplExitError(error) {
  if (!error || typeof error !== "object") return false;
  if (error.name !== "ClawReplUnexpectedExitError") return false;
  return error.replExitCode === 0 && !error.replSignal;
}

function createReplSession(context, env) {
  const child = spawn(expectBinaryPath, [
    expectReplScriptPath,
    context.clawPath,
    context.cwd,
    context.model,
    context.permissionMode,
  ], {
    cwd: context.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    key: createSessionKey(context),
    child,
    ready: false,
    closed: false,
    startupBuffer: "",
    outputCarry: "",
    stderrBuffer: "",
    sessionId: "",
    sessionPath: "",
    readyResolvers: new Set(),
    readyRejectors: new Set(),
    closeResolvers: new Set(),
    promptResolvers: [],
    lastRespondedQuestion: null,
  };

  const rejectAll = (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error || "claw session failed."));
    for (const reject of session.readyRejectors) reject(normalized);
    session.readyRejectors.clear();
    session.readyResolvers.clear();
    while (session.promptResolvers.length) {
      const current = session.promptResolvers.shift();
      clearTimeout(current.timer);
      current.reject(normalized);
    }
  };

  child.stdout.on("data", (data) => {
    const chunk = normalizeTerminalOutput(data.toString("utf8"));
    if (!session.ready) {
      session.startupBuffer += chunk;
      maybeResolveReadyFromBuffer(session);
      return;
    }
    session.outputCarry += chunk;

    const question = findPermissionPrompt(session.outputCarry);
    if (question && question !== session.lastRespondedQuestion) {
      session.lastRespondedQuestion = question;
      const answer = getPromptAnswer(question, context);
      try {
        child.stdin.write(answer);
      } catch (error) {
        console.error("Failed to auto-respond to permission prompt:", safeErrorMessage(error));
      }
    }

    // Auto-pull browser if a dev server URL is printed in stdout
    const urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s'"*]*)?/gi;
    let urlMatch;
    while ((urlMatch = urlRegex.exec(chunk)) !== null) {
      const matchedUrl = urlMatch[0];
      if (!session.openedUrls) {
        session.openedUrls = new Set();
      }
      if (!session.openedUrls.has(matchedUrl)) {
        session.openedUrls.add(matchedUrl);
        sanitizeAndOpenUrl(matchedUrl);
      }
    }

    emitReplDelta(session, "stdout", session.outputCarry).catch((error) => {
      console.error("Failed to emit REPL stdout chunk:", safeErrorMessage(error));
    });
    maybeResolvePromptFromBuffer(session);
  });

  child.stderr.on("data", (data) => {
    const chunk = normalizeTerminalOutput(data.toString("utf8"));
    session.stderrBuffer = appendCapped(session.stderrBuffer, chunk, maxTaskOutputChars);
    emitReplDelta(session, "stderr", session.stderrBuffer).catch((error) => {
      console.error("Failed to emit REPL stderr chunk:", safeErrorMessage(error));
    });
  });

  child.on("error", (error) => {
    session.closed = true;
    if (activeReplSession === session) activeReplSession = null;
    rejectAll(error);
  });

  child.on("exit", (exitCode, signal) => {
    session.closed = true;
    if (activeReplSession === session) activeReplSession = null;
    for (const resolve of session.closeResolvers) resolve({ code: exitCode, signal });
    session.closeResolvers.clear();
    if (session.readyResolvers.size || session.promptResolvers.length) {
      rejectAll(createUnexpectedReplExitError(exitCode, signal));
    }
  });

  return session;
}

function findPreviousSessionForConversation(conversationId, cwd) {
  if (!conversationId) return { sessionId: null, sessionPath: null };
  const tasks = db?.data?.tasks || [];
  const matchingTask = [...tasks]
    .filter((t) => {
      if (!t.conversationId || t.conversationId !== conversationId || !t.sessionPath) return false;
      if (!sameWorkspacePath(t.cwd || "", cwd || "")) return false;
      const absPath = path.isAbsolute(t.sessionPath)
        ? t.sessionPath
        : path.resolve(t.cwd || db.data.preferences.workspacePath, t.sessionPath);
      return fs.existsSync(absPath);
    })
    .sort((left, right) => {
      const rightTime = new Date(right.createdAt || 0).getTime();
      const leftTime = new Date(left.createdAt || 0).getTime();
      return rightTime - leftTime;
    })[0];
  if (!matchingTask) return { sessionId: null, sessionPath: null };
  const absPath = path.isAbsolute(matchingTask.sessionPath)
    ? matchingTask.sessionPath
    : path.resolve(matchingTask.cwd || db.data.preferences.workspacePath, matchingTask.sessionPath);
  return {
    sessionId: matchingTask.sessionId || null,
    sessionPath: absPath,
  };
}

function extractReasoningFromSessionJsonl(sessionPath, cwd) {
  if (!sessionPath) return { reasoningContent: "", reasoningSignature: "" };
  let absPath = sessionPath;
  if (!path.isAbsolute(absPath)) {
    absPath = path.resolve(cwd || db.data.preferences.workspacePath, absPath);
  }
  if (!fs.existsSync(absPath)) {
    return { reasoningContent: "", reasoningSignature: "" };
  }
  try {
    const content = fs.readFileSync(absPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const blocks = entry.message.blocks || [];
          let reasoningContent = "";
          let reasoningSignature = "";
          for (const block of blocks) {
            if (block.type === "thinking") {
              reasoningContent = block.thinking || "";
              reasoningSignature = block.signature || "";
              break;
            }
          }
          if (reasoningContent) {
            return { reasoningContent, reasoningSignature };
          }
        }
      } catch (e) {
        // ignore malformed line
      }
    }
  } catch (err) {
    console.error("Failed to read reasoning from session JSONL:", err);
  }
  return { reasoningContent: "", reasoningSignature: "" };
}

async function getOrCreateReplSession(context, env, targetSessionId = null, targetSessionPath = null) {
  const nextKey = createSessionKey(context);
  if (activeReplSession?.key === nextKey && !activeReplSession.closed) {
    if (targetSessionId && activeReplSession.sessionId === targetSessionId) {
      await waitForReplReady(activeReplSession);
      return activeReplSession;
    }
  }

  await disposeActiveReplSession();
  const session = createReplSession(context, env);
  activeReplSession = session;
  await waitForReplReady(session);

  let resolvedSessionPath = targetSessionPath;
  if (targetSessionPath && !path.isAbsolute(targetSessionPath)) {
    resolvedSessionPath = path.resolve(context.cwd, targetSessionPath);
  }

  if (resolvedSessionPath && fs.existsSync(resolvedSessionPath)) {
    try {
      await runPromptInReplSession(session, `/resume ${resolvedSessionPath}`);
      session.sessionId = targetSessionId;
      session.sessionPath = resolvedSessionPath;
    } catch (error) {
      console.error("Failed to resume session:", safeErrorMessage(error));
    }
  }

  return session;
}

function runPromptInReplSession(session, prompt, onChunk) {
  if (!session?.child || session.closed) {
    return Promise.reject(new Error("claw REPL session is not available."));
  }

  const result = createPromptResolver(session, onChunk);

  try {
    session.child.stdin.write(normalizeLineEndings(prompt).replace(/\n/g, "\r"));
    session.child.stdin.write("\r");
  } catch (error) {
    while (session.promptResolvers.length) {
      const current = session.promptResolvers.shift();
      clearTimeout(current.timer);
      current.reject(error);
    }
    return Promise.reject(error);
  }

  return result;
}

function runPromptOnce(context, env, prompt, onChunk) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",
      context.model,
      "--permission-mode",
      context.permissionMode,
    ];
    if (context.permissionMode === "danger-full-access") {
      args.push("--dangerously-skip-permissions");
    }
    args.push("prompt", prompt);

    const child = spawn(context.clawPath, args, {
      cwd: context.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      const chunk = normalizeTerminalOutput(data.toString("utf8"));
      stdout = appendCapped(stdout, chunk, maxTaskOutputChars);

      // Auto-pull browser if a dev server URL is printed in stdout
      const urlRegex = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s'"*]*)?/gi;
      let urlMatch;
      while ((urlMatch = urlRegex.exec(chunk)) !== null) {
        const matchedUrl = urlMatch[0];
        if (!child.openedUrls) {
          child.openedUrls = new Set();
        }
        if (!child.openedUrls.has(matchedUrl)) {
          child.openedUrls.add(matchedUrl);
          sanitizeAndOpenUrl(matchedUrl);
        }
      }

      Promise.resolve(onChunk?.("stdout", chunk)).catch((error) => {
        console.error("Failed to emit stdout chunk:", safeErrorMessage(error));
      });
    });

    child.stderr.on("data", (data) => {
      const chunk = normalizeTerminalOutput(data.toString("utf8"));
      stderr = appendCapped(stderr, chunk, maxTaskOutputChars);
      Promise.resolve(onChunk?.("stderr", chunk)).catch((error) => {
        console.error("Failed to emit stderr chunk:", safeErrorMessage(error));
      });
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr, code, signal, sessionId: null, sessionPath: null });
        return;
      }
      const error = new Error(stderr.trim() || `claw prompt exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function shouldUsePersistentRepl() {
  return fs.existsSync(expectBinaryPath) && fs.existsSync(expectReplScriptPath);
}

function sanitizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .slice(0, maxTaskFiles)
    .flatMap((file) => {
      const filePath = normalizeString(file?.path, "", { max: 4096 });
      if (!filePath) return [];
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return [];
        return [{
          id: typeof file?.id === "string" && file.id ? file.id.slice(0, 120) : crypto.randomUUID(),
          name: path.basename(filePath),
          path: filePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        }];
      } catch {
        return [];
      }
    });
}

function sanitizeTaskPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid task payload.");
  }

  const preferences = db.data.preferences;
  const prompt = normalizeString(payload.prompt, "", { max: maxPromptChars });
  if (!prompt) throw new Error("Task prompt is required.");

  return {
    prompt,
    conversationId: sanitizeConversationId(payload.conversationId, null),
    forceFreshConversation: payload.forceFreshConversation === true,
    cwd: normalizeWorkspacePath(payload.cwd, preferences.workspacePath),
    model: normalizeModel(payload.model, preferences.defaultModel),
    permissionMode: normalizePermissionMode(payload.permissionMode, preferences.permissionMode),
    files: sanitizeFiles(payload.files),
  };
}

function sanitizePathList(paths) {
  if (!Array.isArray(paths)) return [];
  return paths
    .slice(0, maxTaskFiles)
    .map((filePath) => ({ path: normalizeString(filePath, "", { max: 4096 }) }))
    .filter((file) => file.path);
}

function parseRgJson(output) {
  const results = [];
  for (const line of String(output || "").split("\n")) {
    if (!line.trim() || results.length >= maxSearchResults) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "match") continue;
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      const text = event.data?.lines?.text;
      if (typeof filePath !== "string" || typeof lineNumber !== "number" || typeof text !== "string") continue;
      results.push({
        path: filePath,
        name: path.basename(filePath),
        line: lineNumber,
        preview: text.trim().slice(0, maxSearchLineChars),
      });
    } catch {
      // Ignore malformed rg event lines.
    }
  }
  return results;
}

function searchWorkspace(query, cwd) {
  const result = spawnSync("rg", [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--hidden",
    "--max-count",
    "20",
    "--max-filesize",
    "2M",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!release/**",
    "--glob",
    "!.git/**",
    "--",
    query,
    cwd,
  ], {
    env: { ...process.env, PATH: runtimePathEnv() },
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.trim() || "Search failed.");
  }
  return parseRgJson(result.stdout);
}

function readTextPreview(filePath, maxChars = 12_000) {
  try {
    return fs.readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  return content
    .slice(3, end)
    .split("\n")
    .reduce((meta, line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) return meta;
      meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      return meta;
    }, {});
}

function humanizeSlug(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

function compactDescription(value) {
  return normalizeString(value, "", { max: maxCatalogDescriptionChars }).replace(/\s+/g, " ");
}

function shouldSkipDirectory(name) {
  return new Set([".git", "node_modules", "dist", "release", ".next", "build"]).has(name);
}

function collectFilesNamed(root, fileName, maxDepth, results = []) {
  if (!root || results.length >= maxCatalogItems) return results;
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return results;
  }
  if (!stat.isDirectory() || maxDepth < 0) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= maxCatalogItems) break;
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      results.push(fullPath);
      continue;
    }
    if (entry.isDirectory() && !shouldSkipDirectory(entry.name)) {
      collectFilesNamed(fullPath, fileName, maxDepth - 1, results);
    }
  }
  return results;
}

function skillSourceForPath(skillPath) {
  const codexSkills = path.join(os.homedir(), ".codex", "skills");
  const agentSkills = path.join(os.homedir(), ".agents", "skills");
  const pluginCache = path.join(os.homedir(), ".codex", "plugins", "cache");
  if (skillPath.startsWith(pluginCache)) return "plugin cache";
  if (skillPath.startsWith(codexSkills)) return "codex skills";
  if (skillPath.startsWith(agentSkills)) return "agent skills";
  return "workspace";
}

function listLocalSkills() {
  const workspaceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
  const roots = [
    { path: path.join(os.homedir(), ".codex", "skills"), depth: 6 },
    { path: path.join(os.homedir(), ".agents", "skills"), depth: 5 },
    { path: path.join(os.homedir(), ".codex", "plugins", "cache"), depth: 8 },
    { path: path.join(workspaceRoot, "skills"), depth: 8 },
  ];
  const files = roots.flatMap((root) => collectFilesNamed(root.path, "SKILL.md", root.depth));
  const uniqueFiles = [...new Set(files)].slice(0, maxCatalogItems);
  return uniqueFiles
    .map((skillPath) => {
      const content = readTextPreview(skillPath);
      const meta = parseFrontmatter(content);
      const dirName = path.basename(path.dirname(skillPath));
      const name = normalizeString(meta.name, dirName, { max: 120 });
      return {
        id: skillPath,
        name,
        description: compactDescription(meta.description || content.match(/^#\s+(.+)$/m)?.[1] || "本地技能"),
        path: skillPath,
        source: skillSourceForPath(skillPath),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function countSkills(root) {
  return collectFilesNamed(root, "SKILL.md", 6, []).length;
}

function listLocalPlugins() {
  const cacheRoot = path.join(os.homedir(), ".codex", "plugins", "cache");
  let providers = [];
  try {
    providers = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const plugins = [];
  for (const provider of providers) {
    const providerPath = path.join(cacheRoot, provider.name);
    let entries = [];
    try {
      entries = fs.readdirSync(providerPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (plugins.length >= maxCatalogItems) break;
      const pluginPath = path.join(providerPath, entry.name);
      const skillFiles = collectFilesNamed(pluginPath, "SKILL.md", 6, []);
      const description = skillFiles.length
        ? parseFrontmatter(readTextPreview(skillFiles[0])).description || `${skillFiles.length} 个技能`
        : "本地插件缓存";
      plugins.push({
        id: `${provider.name}/${entry.name}`,
        name: humanizeSlug(entry.name),
        description: compactDescription(description),
        path: pluginPath,
        provider: provider.name,
        status: "installed",
        skillCount: skillFiles.length || countSkills(pluginPath),
      });
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

function parseTomlValue(content, key) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function listLocalAutomations() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const root = path.join(codexHome, "automations");
  const files = collectFilesNamed(root, "automation.toml", 4, []);
  return files.slice(0, maxCatalogItems).map((automationPath) => {
    const content = readTextPreview(automationPath);
    const id = path.basename(path.dirname(automationPath));
    return {
      id,
      name: normalizeString(parseTomlValue(content, "name"), id, { max: 120 }),
      path: automationPath,
      kind: normalizeString(parseTomlValue(content, "kind"), "cron", { max: 40 }),
      status: normalizeString(parseTomlValue(content, "status"), "UNKNOWN", { max: 40 }),
      schedule: normalizeString(parseTomlValue(content, "rrule"), "", { max: 160 }),
      prompt: compactDescription(parseTomlValue(content, "prompt")),
    };
  });
}

function appendCapped(existing, chunk, maxChars) {
  const next = `${existing || ""}${chunk || ""}`;
  if (next.length <= maxChars) return next;
  return next.slice(next.length - maxChars);
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function taskLogPath(taskId, cwd) {
  const workspace = cwd || db.data.preferences.workspacePath;
  return path.join(workspace, ".claw", "logs", `${taskId}.log`);
}

async function appendTaskLog(task, stream, chunk) {
  if (!db.data.preferences.autoSaveLogs) return;
  task.logPath = task.logPath || taskLogPath(task.id, task.cwd);
  if (!isPathInside(task.cwd || db.data.preferences.workspacePath, task.logPath)) {
    throw new Error("Security breach: attempt to write log files outside the workspace.");
  }
  await fs.promises.mkdir(path.dirname(task.logPath), { recursive: true });
  const prefix = `\n[${new Date().toISOString()}] ${stream}\n`;
  await fs.promises.appendFile(task.logPath, `${prefix}${chunk}`, "utf8");
}

function normalizeData(data) {
  const conversations = data?.conversations && typeof data.conversations === "object" ? data.conversations : {};
  return {
    ...defaultData,
    ...data,
    preferences: {
      ...defaultData.preferences,
      ...(data?.preferences || {}),
      secrets: {
        ...defaultData.preferences.secrets,
        ...(data?.preferences?.secrets || {}),
      },
    },
    tasks: data?.tasks || [],
    archivedTasks: data?.archivedTasks || [],
    recentFiles: data?.recentFiles || [],
    conversations,
  };
}

async function initDb() {
  const { Low } = await import("lowdb");
  const { JSONFile } = await import("lowdb/node");
  const storePath = path.join(app.getPath("userData"), "store.json");
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  db = new Low(new JSONFile(storePath), defaultData);
  await db.read();
  db.data = normalizeData(db.data);
  migrateLegacySingleTurnConversationIds();
  await db.write();
}

function encryptSecret(value) {
  if (!value) return null;
  if (safeStorage.isEncryptionAvailable()) {
    return {
      kind: "safeStorage",
      value: safeStorage.encryptString(value).toString("base64"),
    };
  }
  throw new Error("Secure credential storage is unavailable on this system.");
}

function decryptSecret(record) {
  if (!record?.value) return "";
  try {
    if (record.kind === "safeStorage" && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(record.value, "base64"));
    }
    if (record.kind === "plain") {
      return record.value;
    }
  } catch {
    return "";
  }
  return "";
}

function getSecretHint(secret) {
  if (!secret) return "";
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return trimmed;
  }
  return `${trimmed.substring(0, 4)}...${trimmed.substring(trimmed.length - 4)}`;
}

function publicPreferences() {
  const preferences = db.data.preferences;
  const anthropicApiKey = decryptSecret(preferences.secrets.anthropicApiKey) || process.env.ANTHROPIC_API_KEY || "";
  const anthropicAuthToken = decryptSecret(preferences.secrets.anthropicAuthToken) || process.env.ANTHROPIC_AUTH_TOKEN || "";
  const openaiApiKey = decryptSecret(preferences.secrets.openaiApiKey) || process.env.OPENAI_API_KEY || "";

  return {
    ...preferences,
    clawPath: preferences.clawPath || "bundled",
    openaiCompatEnabled: preferences.openaiCompatEnabled === true,
    defaultModel: normalizeUiModelForStorage(preferences.defaultModel, preferences.defaultModel),
    anthropicApiKeySet: Boolean(anthropicApiKey),
    anthropicAuthTokenSet: Boolean(anthropicAuthToken),
    openaiApiKeySet: Boolean(openaiApiKey),
    anthropicApiKeyHint: getSecretHint(anthropicApiKey),
    anthropicAuthTokenHint: getSecretHint(anthropicAuthToken),
    openaiApiKeyHint: getSecretHint(openaiApiKey),
    offlineSpeechEnabled: preferences.offlineSpeechEnabled !== false,
    offlineSpeechModel: normalizeOfflineSpeechModel(preferences.offlineSpeechModel, "mlx-community/whisper-tiny"),
    language: normalizeLanguage(preferences.language, "zh-CN"),
    secrets: undefined,
  };
}

function buildTaskPrompt(payload) {
  const files = payload.files || [];
  if (!files.length) return payload.prompt;
  const fileBlock = files.map((file) => `- ${file.path}`).join("\n");
  return `${payload.prompt}\n\n本次任务关联文件:\n${fileBlock}`;
}

function taskSummary(task) {
  const { child, forceFreshConversation, ...rest } = task;
  return rest;
}

async function persistTask(task, options = {}) {
  const timer = persistTimers.get(task.id);
  if (timer) {
    clearTimeout(timer);
    persistTimers.delete(task.id);
  }
  const index = db.data.tasks.findIndex((item) => item.id === task.id);
  const plain = taskSummary(task);
  if (index === -1) {
    db.data.tasks.unshift(plain);
  } else {
    db.data.tasks[index] = plain;
  }
  db.data.tasks = db.data.tasks.slice(0, 100);
  await db.write();
  if (options.emit !== false) {
    emitTaskEvent("task:updated", plain);
  }
}

function schedulePersistTask(task) {
  emitTaskEvent("task:updated", taskSummary(task));
  if (persistTimers.has(task.id)) return;
  const timer = setTimeout(() => {
    persistTimers.delete(task.id);
    persistTask(task, { emit: false }).catch((error) => {
      console.error("Failed to persist task:", safeErrorMessage(error));
    });
  }, persistDebounceMs);
  persistTimers.set(task.id, timer);
}

async function runNextTask() {
  if (activeTask || taskQueue.length === 0) return;

  const task = taskQueue.shift();
  activeTask = task;
  task.status = "running";
  task.startedAt = new Date().toISOString();
  await persistTask(task);

  let finalized = false;
  const finishTask = async (status, details = {}) => {
    if (finalized) return;
    finalized = true;
    task.exitCode = details.code ?? task.exitCode;
    task.signal = details.signal ?? task.signal;
    task.status = status;
    task.finishedAt = new Date().toISOString();
    activeTask = null;
    await persistTask(task);
    runNextTask();
  };

  try {
    const preferences = db.data.preferences;
    const context = buildExecutionContext(task, preferences);
    const contextError = validateExecutionContext(context);
    if (contextError) {
      throw contextError;
    }
    const env = await buildTaskEnvironment(context);
    const prompt = buildTaskPrompt(task);
    const emitChunk = createTaskChunkEmitter(task);
    const requestedConversationId = sanitizeConversationId(task.conversationId, null);
    const selectedConversationRecord = getConversationRecordForWorkspace(requestedConversationId, context.cwd);
    const incomingConversationId = selectedConversationRecord?.id || null;
    const fallbackSingleTurnConversationId =
      task.forceFreshConversation
        ? null
        : (preferences.saveSingleTurnInOnePlace ?? true) ? singleTurnConversationIdForWorkspace(context.cwd) : null;
    const targetConversationId = requestedConversationId || incomingConversationId || fallbackSingleTurnConversationId;
    const targetConversationRecord = getConversationRecordForWorkspace(targetConversationId, context.cwd)
      || (targetConversationId ? createConversationRecord(task, context, targetConversationId) : null);

    let executionResult;

    if (shouldUsePersistentRepl()) {
      const conversationIdForRepl = targetConversationId;
      const { sessionId: targetSessionId, sessionPath: targetSessionPath } = findPreviousSessionForConversation(conversationIdForRepl, context.cwd);
      try {
        const session = await getOrCreateReplSession(context, env, targetSessionId, targetSessionPath);
        task.child = null;
        task.sessionId = session.sessionId || null;
        task.sessionPath = session.sessionPath || null;
        task.conversationId = conversationIdForRepl || session.sessionId || null;
        schedulePersistTask(task);
        executionResult = await runPromptInReplSession(session, prompt, emitChunk);
      } catch (replError) {
        if (!isRecoverableReplExitError(replError)) {
          throw replError;
        }
        console.warn("Persistent REPL exited with code 0; falling back to one-shot prompt mode.");
        task.child = null;
        task.sessionId = null;
        task.sessionPath = null;
        schedulePersistTask(task);
        const oneShotPrompt = !targetConversationRecord ? prompt : buildConversationReplayPrompt(targetConversationRecord, prompt);
        executionResult = await runPromptOnce(context, env, oneShotPrompt, emitChunk);
      }
    } else {
      task.child = null;
      task.sessionId = null;
      task.sessionPath = null;
      schedulePersistTask(task);
      const oneShotPrompt = !targetConversationRecord ? prompt : buildConversationReplayPrompt(targetConversationRecord, prompt);
      executionResult = await runPromptOnce(context, env, oneShotPrompt, emitChunk);
    }

    let { stdout, stderr, reasoningContent, reasoningSignature } = executionResult;
    if (!reasoningContent && task.sessionPath) {
      const extracted = extractReasoningFromSessionJsonl(task.sessionPath, context.cwd);
      if (extracted.reasoningContent) {
        reasoningContent = extracted.reasoningContent;
      }
      if (extracted.reasoningSignature) {
        reasoningSignature = extracted.reasoningSignature;
      }
    }
    const embeddedStdoutError = extractEmbeddedTaskError(stdout);
    let cleanStdout = mergeDuplicateLeadingSection(sanitizeTaskOutput(stdout, prompt));
    let cleanStderr = sanitizeTaskOutput(stderr, prompt, { trimPrompt: false });
    if (embeddedStdoutError) {
      cleanStderr = [cleanStderr, embeddedStdoutError].filter(Boolean).join(cleanStderr ? "\n" : "");
    }

    const finalConversationId = sanitizeConversationId(task.conversationId, targetConversationId);
    if (finalConversationId) {
      task.conversationId = finalConversationId;
    }
    if (targetConversationRecord && finalConversationId) {
      targetConversationRecord.id = finalConversationId;
      targetConversationRecord.cwd = context.cwd;
      targetConversationRecord.model = task.model || targetConversationRecord.model;
      targetConversationRecord.permissionMode = task.permissionMode || targetConversationRecord.permissionMode;
      targetConversationRecord.provider = "claw";
      attachTaskToConversation(targetConversationRecord, task.id);
      appendConversationMessage(targetConversationRecord, "user", prompt);
      if (cleanStdout || reasoningContent) {
        appendAssistantConversationMessage(targetConversationRecord, cleanStdout, reasoningContent || "", reasoningSignature || "");
      }
      upsertConversationRecord(targetConversationRecord);
      await db.write();
    }

    if (cleanStdout && cleanStdout !== task.output) {
      const remainder = cleanStdout.startsWith(task.output) ? cleanStdout.slice(task.output.length) : cleanStdout;
      if (remainder) {
        await emitChunk("stdout", remainder);
      }
    }
    if (reasoningContent) {
      task.output = `<think>\n${reasoningContent}\n</think>\n` + cleanStdout;
    } else {
      task.output = cleanStdout;
    }

    if (cleanStderr && cleanStderr !== task.error) {
      const remainder = cleanStderr.startsWith(task.error) ? cleanStderr.slice(task.error.length) : cleanStderr;
      if (remainder) {
        await emitChunk("stderr", remainder, { trimPrompt: false });
      }
    }
    task.error = cleanStderr;

    schedulePersistTask(task);
    await finishTask(task.status === "canceled" ? "canceled" : cleanStderr ? "failed" : "completed", { code: cleanStderr ? 1 : 0, signal: null });
  } catch (error) {
    if (task.status === "canceled") {
      await finishTask("canceled", { signal: task.signal || "SIGTERM" });
      return;
    }
    task.status = "failed";
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    if (stdout) {
      task.output = appendCapped(task.output, mergeDuplicateLeadingSection(sanitizeTaskOutput(stdout, task.prompt)), maxTaskOutputChars);
    }
    task.error = appendCapped(
      task.error,
      [stderr ? sanitizeTaskOutput(stderr, task.prompt, { trimPrompt: false }) : "", safeErrorMessage(error)]
        .filter(Boolean)
        .join("\n"),
      maxTaskOutputChars,
    );
    await finishTask("failed");
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    frame: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const session = mainWindow.webContents.session;
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media" || permission === "audioCapture") {
      callback(true);
      return;
    }
    callback(false);
  });
  session.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === "media" || permission === "audioCapture") {
      return true;
    }
    return false;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http:") || url.startsWith("https:")) {
      sanitizeAndOpenUrl(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isDev && (url.startsWith("http://127.0.0.1:5173") || url.startsWith("http://localhost:5173"))) {
      return;
    }
    if (url.startsWith("http:") || url.startsWith("https:")) {
      event.preventDefault();
      sanitizeAndOpenUrl(url);
    }
  });

  if (isDev) {
    mainWindow.loadURL(process.env.ELECTRON_START_URL || "http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("window:close", async () => {
  mainWindow?.close();
  return true;
});

ipcMain.handle("window:minimize", async () => {
  mainWindow?.minimize();
  return true;
});

ipcMain.handle("window:toggle-fullscreen", async () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return mainWindow.isFullScreen();
});

ipcMain.handle("system:status", async () => {
  const preferences = db.data.preferences;
  const resolvedClawPath = resolveClawPath(preferences);
  const bundledClawPath = resolveBundledClawPath();
  const result = spawnSync(resolvedClawPath, ["--version"], {
    env: { ...process.env, PATH: runtimePathEnv() },
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    clawFound: result.status === 0,
    clawPath: resolvedClawPath,
    bundledClawPath,
    usingBundledClaw: Boolean(bundledClawPath && resolvedClawPath === bundledClawPath),
    version: result.stdout.trim() || result.stderr.trim(),
    error: result.status === 0 ? "" : result.stderr.trim() || result.error?.message || "claw unavailable",
    platform: `${process.platform} ${process.arch}`,
    userDataPath: app.getPath("userData"),
  };
});

ipcMain.handle("system:reveal-path", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath) return false;
  await shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle("preferences:get", async () => publicPreferences());

ipcMain.handle("preferences:save", async (_event, incoming) => {
  if (!incoming || typeof incoming !== "object") {
    throw new Error("Invalid preferences payload.");
  }
  const previous = db.data.preferences;
  const next = {
    ...previous,
    clawPath: hasOwn(incoming, "clawPath") ? normalizeClawPath(incoming.clawPath, previous.clawPath) : previous.clawPath,
    openaiBaseUrl: hasOwn(incoming, "openaiBaseUrl") ? normalizeOpenAiBaseUrl(incoming.openaiBaseUrl, previous.openaiBaseUrl) : previous.openaiBaseUrl,
    openaiCompatEnabled: hasOwn(incoming, "openaiCompatEnabled") ? Boolean(incoming.openaiCompatEnabled) : previous.openaiCompatEnabled === true,
    offlineSpeechEnabled: hasOwn(incoming, "offlineSpeechEnabled") ? Boolean(incoming.offlineSpeechEnabled) : previous.offlineSpeechEnabled,
    offlineSpeechModel: hasOwn(incoming, "offlineSpeechModel")
      ? normalizeOfflineSpeechModel(incoming.offlineSpeechModel, previous.offlineSpeechModel)
      : previous.offlineSpeechModel,
    permissionMode: hasOwn(incoming, "permissionMode") ? normalizePermissionMode(incoming.permissionMode, previous.permissionMode) : previous.permissionMode,
    workspacePath: hasOwn(incoming, "workspacePath") ? normalizeWorkspacePath(incoming.workspacePath, previous.workspacePath) : previous.workspacePath,
    theme: incoming.theme === "dark" ? "dark" : incoming.theme === "light" ? "light" : previous.theme,
    language: hasOwn(incoming, "language") ? normalizeLanguage(incoming.language, previous.language) : normalizeLanguage(previous.language),
    fontSize: hasOwn(incoming, "fontSize") ? normalizeFontSize(incoming.fontSize, previous.fontSize) : previous.fontSize,
    autoSaveLogs: hasOwn(incoming, "autoSaveLogs") ? Boolean(incoming.autoSaveLogs) : previous.autoSaveLogs,
    enableDeepSeek1M: hasOwn(incoming, "enableDeepSeek1M") ? Boolean(incoming.enableDeepSeek1M) : previous.enableDeepSeek1M,
    saveSingleTurnInOnePlace: hasOwn(incoming, "saveSingleTurnInOnePlace") ? Boolean(incoming.saveSingleTurnInOnePlace) : previous.saveSingleTurnInOnePlace,
    modelProfiles: hasOwn(incoming, "modelProfiles") ? normalizeModelProfiles(incoming.modelProfiles, previous.modelProfiles) : previous.modelProfiles,
    secrets: { ...previous.secrets },
  };
  next.defaultModel = hasOwn(incoming, "defaultModel")
    ? normalizeUiModelForStorage(incoming.defaultModel, previous.defaultModel)
    : normalizeUiModelForStorage(previous.defaultModel, previous.defaultModel);

  if (hasOwn(incoming, "anthropicApiKey")) {
    const value = normalizeOptionalSecret(incoming.anthropicApiKey);
    next.secrets.anthropicApiKey = value ? encryptSecret(value) : null;
  }
  if (hasOwn(incoming, "anthropicAuthToken")) {
    const value = normalizeOptionalSecret(incoming.anthropicAuthToken);
    next.secrets.anthropicAuthToken = value ? encryptSecret(value) : null;
  }
  if (hasOwn(incoming, "openaiApiKey")) {
    const value = normalizeOptionalSecret(incoming.openaiApiKey);
    next.secrets.openaiApiKey = value ? encryptSecret(value) : null;
  }

  db.data.preferences = next;
  await db.write();
  return publicPreferences();
});

ipcMain.handle("files:select", async (_event, kind) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: kind === "image" ? attachmentImageFilters : attachmentFileFilters,
  });
  if (result.canceled) return [];
  const files = sanitizeFiles(result.filePaths.map((filePath) => ({ path: filePath })));
  db.data.recentFiles = [...files, ...db.data.recentFiles].slice(0, 30);
  await db.write();
  return files;
});

ipcMain.handle("files:from-paths", async (_event, filePaths) => {
  const files = sanitizeFiles(sanitizePathList(filePaths));
  db.data.recentFiles = [...files, ...db.data.recentFiles].slice(0, 30);
  await db.write();
  return files;
});

ipcMain.handle("files:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  const folderPath = result.filePaths[0];
  return folderPath;
});

ipcMain.handle("workspace:search", async (_event, payload) => {
  const preferences = db.data.preferences;
  const query = normalizeString(payload?.query, "", { max: maxSearchQueryChars });
  if (query.length < 2) return [];
  const cwd = normalizeWorkspacePath(payload?.cwd, preferences.workspacePath);
  return searchWorkspace(query, cwd);
});

ipcMain.handle("workspace:create-worktree", async (_event, payload) => {
  const sourcePath = normalizeWorkspacePath(payload?.sourcePath, "");
  const name = sanitizeWorktreeName(payload?.name);
  if (!sourcePath) {
    throw new Error("请选择要创建工作树的源项目。");
  }
  if (!name) {
    throw new Error("请填写有效的项目名称。");
  }

  const result = createWorktreeProject(sourcePath, name);
  await db.write();
  emitTaskEvent("task:cleared", activeTaskList());
  return result;
});

ipcMain.handle("speech:transcribe", async (_event, payload) => {
  try {
    return await transcribeSpeechOffline(db.data.preferences, payload);
  } catch (offlineError) {
    const message = offlineError instanceof Error ? offlineError.message : "离线语音转写失败。";
    throw new Error(`当前版本只支持离线语音转写。\n离线转写失败: ${message}`);
  }
});

ipcMain.handle("conversations:list-archived", async () => archivedConversationSummaries());

ipcMain.handle("conversations:archive", async (_event, conversationId) => {
  const result = archiveConversation(conversationId);
  await db.write();
  emitTaskEvent("task:cleared", result.tasks);
  return result;
});

ipcMain.handle("conversations:archive-workspace", async (_event, payload) => {
  const result = archiveWorkspaceConversations(payload?.workspacePath);
  await db.write();
  emitTaskEvent("task:cleared", result.tasks);
  return result;
});

ipcMain.handle("conversations:restore", async (_event, conversationId) => {
  const result = restoreArchivedConversation(conversationId);
  await db.write();
  emitTaskEvent("task:cleared", result.tasks);
  return result;
});

ipcMain.handle("catalog:list", async () => ({
  skills: listLocalSkills(),
  plugins: listLocalPlugins(),
  automations: listLocalAutomations(),
  generatedAt: new Date().toISOString(),
}));

ipcMain.handle("tasks:list", async () => activeTaskList());

ipcMain.handle("tasks:run", async (_event, payload) => {
  const preferences = db.data.preferences;
  const sanitized = sanitizeTaskPayload(payload);

  let taskCwd = sanitized.cwd || preferences.workspacePath;
  try {
    if (!fs.existsSync(taskCwd) || !fs.statSync(taskCwd).isDirectory()) {
      taskCwd = preferences.workspacePath;
    }
  } catch {
    taskCwd = preferences.workspacePath;
  }

  const task = {
    id: crypto.randomUUID(),
    conversationId: sanitized.conversationId,
    forceFreshConversation: sanitized.forceFreshConversation,
    prompt: sanitized.prompt,
    cwd: taskCwd,
    model: normalizeUiModelForStorage(
      sanitized.model || preferences.defaultModel,
      preferences.defaultModel,
    ),
    permissionMode: sanitized.permissionMode || preferences.permissionMode,
    files: sanitized.files || [],
    status: "pending",
    output: "",
    error: "",
    events: [],
    logPath: null,
    sessionId: null,
    sessionPath: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
  };
  await persistTask(task);
  taskQueue.push(task);
  runNextTask();
  return taskSummary(task);
});

ipcMain.handle("tasks:cancel", async (_event, taskId) => {
  const id = normalizeString(taskId, "", { max: 120 });
  if (!id) return false;
  if (activeTask?.id === id) {
    activeTask.status = "canceled";
    await disposeActiveReplSession();
    await persistTask(activeTask);
    return true;
  }

  const queueIndex = taskQueue.findIndex((task) => task.id === id);
  if (queueIndex !== -1) {
    const [task] = taskQueue.splice(queueIndex, 1);
    task.status = "canceled";
    task.finishedAt = new Date().toISOString();
    await persistTask(task);
    return true;
  }

  return false;
});

ipcMain.handle("tasks:clear", async () => {
  const activeIds = new Set([
    activeTask?.id,
    ...taskQueue.map((task) => task.id),
  ].filter(Boolean));
  db.data.tasks = db.data.tasks.filter((task) => activeIds.has(task.id) || task.status === "running");
  await db.write();
  const tasks = activeTaskList();
  emitTaskEvent("task:cleared", tasks);
  return tasks;
});

ipcMain.handle("tasks:delete", async (_event, taskId) => {
  const targetTask = db.data.tasks.find((task) => task.id === taskId);
  if (targetTask && targetTask.conversationId) {
    db.data.tasks = db.data.tasks.filter((task) => task.conversationId !== targetTask.conversationId);
  } else {
    db.data.tasks = db.data.tasks.filter((task) => task.id !== taskId);
  }
  await db.write();
  const tasks = activeTaskList();
  emitTaskEvent("task:cleared", tasks);
  return tasks;
});

// Derived Functionality IPC Handlers
ipcMain.handle("derived:export-conversation", async (_event, payload) => {
  const { taskId, format = "markdown", fileName } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const conversationTasks = task.conversationId
    ? db.data.tasks.filter((t) => t.conversationId === task.conversationId)
    : [task];

  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const exportName = fileName || `conversation-${timestamp}`;
  const exportDir = path.join(os.homedir(), ".codex", "exports");

  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  let content = "";
  let extension = "md";

  if (format === "markdown") {
    content = conversationTasks
      .map((t) => {
        return `# Task: ${t.prompt}\n\n**Status:** ${t.status}\n\n${t.output || "(No output)"}\n\n---\n`;
      })
      .join("\n");
    extension = "md";
  } else if (format === "json") {
    content = JSON.stringify(conversationTasks, null, 2);
    extension = "json";
  } else if (format === "html") {
    const htmlTasks = conversationTasks
      .map((t) => {
        return `<section><h2>${t.prompt}</h2><p><strong>Status:</strong> ${t.status}</p><pre>${t.output || ""}</pre></section>`;
      })
      .join("\n");
    content = `<!DOCTYPE html><html><body>${htmlTasks}</body></html>`;
    extension = "html";
  }

  const filePath = path.join(exportDir, `${exportName}.${extension}`);
  fs.writeFileSync(filePath, content, "utf-8");

  return {
    filePath,
    size: Buffer.byteLength(content, "utf-8"),
    format,
    taskCount: conversationTasks.length,
  };
});

ipcMain.handle("derived:generate-summary", async (_event, payload) => {
  const { taskId, model = "claude-opus-4-6", maxTokens = 500 } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  // Placeholder implementation - in production would call the LLM
  const output = task.output || "";
  const lines = output.split("\n").filter((l) => l.trim());
  const keyPoints = lines.slice(0, 3).filter((l) => l.length > 10);
  const suggestedFollowUps = [
    "What are the next steps?",
    "How can we improve this?",
    "What challenges remain?",
  ];

  return {
    summary: `Summary of task: ${task.prompt}. Output contained ${lines.length} lines of content.`,
    keyPoints,
    suggestedFollowUps,
    generatedAt: new Date().toISOString(),
  };
});

ipcMain.handle("derived:create-snapshot", async (_event, payload) => {
  const { taskId, snapshotName, description = "", includeFiles = true } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const snapshotId = crypto.randomUUID();
  const snapshotDir = path.join(os.homedir(), ".codex", "snapshots", snapshotId);

  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  // Save task metadata
  const metadata = {
    snapshotId,
    snapshotName,
    description,
    sourceTaskId: taskId,
    createdAt: new Date().toISOString(),
    task: {
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      output: task.output,
      cwd: task.cwd,
      model: task.model,
    },
  };

  fs.writeFileSync(path.join(snapshotDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

  // Copy attached files if requested
  let fileCount = 0;
  if (includeFiles && task.files && task.files.length > 0) {
    const filesDir = path.join(snapshotDir, "files");
    if (!fs.existsSync(filesDir)) {
      fs.mkdirSync(filesDir, { recursive: true });
    }
    for (const file of task.files) {
      try {
        if (fs.existsSync(file.path)) {
          fs.copyFileSync(file.path, path.join(filesDir, file.name));
          fileCount++;
        }
      } catch (e) {
        console.error(`Failed to copy file ${file.path}:`, e);
      }
    }
  }

  return {
    snapshotId,
    snapshotPath: snapshotDir,
    taskCount: 1,
    fileCount,
    createdAt: new Date().toISOString(),
  };
});

ipcMain.handle("derived:share-context", async (_event, payload) => {
  const { taskId, format = "clipboard", includeOutput = true } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  let content = `Prompt: ${task.prompt}\nStatus: ${task.status}\n`;
  if (includeOutput) {
    content += `\nOutput:\n${task.output || "(No output)"}`;
  }

  if (format === "clipboard") {
    return {
      content,
      size: Buffer.byteLength(content, "utf-8"),
    };
  } else if (format === "file") {
    const shareDir = path.join(os.homedir(), ".codex", "shares");
    if (!fs.existsSync(shareDir)) {
      fs.mkdirSync(shareDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const filePath = path.join(shareDir, `share-${timestamp}.txt`);
    fs.writeFileSync(filePath, content, "utf-8");
    return {
      filePath,
      size: Buffer.byteLength(content, "utf-8"),
    };
  }

  return {
    content,
    size: Buffer.byteLength(content, "utf-8"),
  };
});

ipcMain.handle("derived:branch-task", async (_event, payload) => {
  const { sourceTaskId, branchName, startFromTurn = 0 } = payload;
  const sourceTask = db.data.tasks.find((t) => t.id === sourceTaskId);
  if (!sourceTask) throw new Error(`Source task ${sourceTaskId} not found`);

  const newTaskId = crypto.randomUUID();
  const newConversationId = crypto.randomUUID();
  const newTask = {
    ...sourceTask,
    id: newTaskId,
    conversationId: newConversationId,
    prompt: `[Branch of ${sourceTaskId}] ${branchName}`,
    createdAt: new Date().toISOString(),
  };

  db.data.tasks.push(newTask);
  await db.write();

  return {
    newTaskId,
    newConversationId,
    taskPath: newTask.cwd,
    copiedTurns: 1,
  };
});

ipcMain.handle("derived:compare-outputs", async (_event, payload) => {
  const { taskId1, taskId2 } = payload;
  const task1 = db.data.tasks.find((t) => t.id === taskId1);
  const task2 = db.data.tasks.find((t) => t.id === taskId2);

  if (!task1 || !task2) throw new Error("One or both tasks not found");

  const output1 = task1.output || "";
  const output2 = task2.output || "";
  const commonChars = [...new Set(output1)].filter((c) => output2.includes(c)).length;
  const commonalityScore = Math.round((commonChars / Math.max(output1.length, output2.length, 1)) * 100);

  return {
    comparison: `Task 1 (${taskId1}) vs Task 2 (${taskId2})`,
    similarities: ["Both completed successfully"],
    differences: [`Output length: ${output1.length} vs ${output2.length}`],
    commonalityScore,
  };
});

ipcMain.handle("derived:extract-insights", async (_event, payload) => {
  const { taskId } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const output = task.output || "";
  const lines = output.split("\n").filter((l) => l.trim());

  return {
    insights: {
      summary: lines.slice(0, 3),
      errors: output.includes("error") ? ["Errors detected in output"] : [],
      warnings: output.includes("warn") ? ["Warnings detected in output"] : [],
    },
    patterns: ["Completed execution"],
    recommendations: ["Review the output for accuracy", "Consider next steps"],
    extractedAt: new Date().toISOString(),
  };
});

ipcMain.handle("derived:generate-documentation", async (_event, payload) => {
  const { taskId, style = "technical", includeExamples = true } = payload;
  const task = db.data.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const header = style === "technical" 
    ? `# Technical Documentation\n\n**Task ID:** ${taskId}\n**Model:** ${task.model}\n\n`
    : `# Documentation\n\nTask Overview\n\n`;

  const sections = [
    `## Overview\n\n${task.prompt}`,
    `## Status\n\n${task.status}`,
    `## Output\n\n${task.output || "No output"}`,
  ];

  if (includeExamples && task.files && task.files.length > 0) {
    sections.push(`## Files\n\n${task.files.map((f) => `- ${f.name}`).join("\n")}`);
  }

  const documentation = header + sections.join("\n\n");

  return {
    documentation,
    sections,
    wordCount: documentation.split(/\s+/).length,
    generatedAt: new Date().toISOString(),
  };
});

app.whenReady().then(async () => {
  await initDb();
  createWindow();
});

app.on("window-all-closed", () => {
  closeOpenAiCompatProxy();
  void disposeActiveReplSession();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  closeOpenAiCompatProxy();
  void disposeActiveReplSession();
});
