import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Brain,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Cpu,
  Database,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  History,
  Key,
  Layers,
  Loader2,
  Mic,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  SlidersHorizontal,
  PanelLeft,
  PenSquare,
  Pin,
  ArrowDown,
  GitBranch,
  Plus,
  Puzzle,
  RefreshCw,
  Boxes,
  Save,
  Search,
  SendHorizontal,
  Settings,
  Share2,
  Shield,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Users,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getDesktopApi } from "./lib/desktopApi";
import { formatBytes, formatTime, statusClass, statusLabel, taskDuration } from "./lib/format";
import { countTurnTokens, computeTokenBreakdown, waitForTokenizer } from "./lib/tokenCounter";
import type { TokenBreakdown, TurnTokens } from "./lib/tokenCounter";
import type {
  AttachmentKind,
  ArchivedConversation,
  AttachedFile,
  ClawPermissionMode,
  ClawTask,
  LocalCatalog,
  ModelProfile,
  PreferencesPatch,
  PublicPreferences,
  SystemStatus,
  TaskBusEvent,
  TaskEvent,
  WorkspaceSearchResult,
} from "./types/electron";

const api = getDesktopApi();

type ViewKey = "dashboard" | "search" | "agents" | "skills" | "plugins" | "automation" | "files" | "tasks" | "settings";
type FeatureViewKey = Exclude<ViewKey, "dashboard" | "files" | "tasks" | "settings">;
type SecretDraftKey = "anthropicApiKey" | "anthropicAuthToken" | "openaiApiKey";
type AttachmentMenuOption = {
  kind: AttachmentKind;
  label: string;
  description: string;
  icon: LucideIcon;
};

type SpeechRecognitionErrorCode =
  | "aborted"
  | "audio-capture"
  | "bad-grammar"
  | "language-not-supported"
  | "network"
  | "no-speech"
  | "not-allowed"
  | "phrases-not-supported"
  | "service-not-allowed";

type SpeechRecognitionAlternativeLike = {
  transcript: string;
};

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionErrorEventLike = {
  error: SpeechRecognitionErrorCode;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: null | (() => void);
  onresult: null | ((event: SpeechRecognitionEventLike) => void);
  onerror: null | ((event: SpeechRecognitionErrorEventLike) => void);
  onend: null | (() => void);
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

export interface WorkspaceItem {
  id: string;
  name: string;
  path: string;
  isPinned: boolean;
}

function deriveWorkspaceNameFromPath(pathValue: string): string {
  const normalized = normalizeWorkspacePathValue(pathValue);
  return normalized.split("/").pop() || "未命名工作区";
}

function normalizeWorkspacePathValue(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/");
}

function singleTurnConversationIdForWorkspace(workspacePath: string): string | null {
  const normalized = normalizeWorkspacePathValue(workspacePath).toLowerCase();
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

function workspacePathKey(value: string): string {
  return normalizeWorkspacePathValue(value).toLowerCase();
}

function sanitizeWorkspaceItems(items: WorkspaceItem[]): WorkspaceItem[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  return items.reduce<WorkspaceItem[]>((result, item, index) => {
    if (!item || typeof item !== "object") return result;
    const path = normalizeWorkspacePathValue(item.path);
    const pathKey = workspacePathKey(path);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : path.split("/").pop() || `工作区 ${index + 1}`;
    if (!path || seen.has(pathKey)) return result;
    seen.add(pathKey);
    result.push({
      id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `ws-${index + 1}`,
      name,
      path,
      isPinned: Boolean(item.isPinned),
    });
    return result;
  }, []);
}

function sanitizeExpandedWorkspaceState(state: Record<string, boolean>, items: WorkspaceItem[]): Record<string, boolean> {
  if (!state || typeof state !== "object") return {};
  const validIds = new Set(items.map((item) => item.id));
  return Object.entries(state).reduce<Record<string, boolean>>((result, [id, expanded]) => {
    if (validIds.has(id)) {
      result[id] = Boolean(expanded);
    }
    return result;
  }, {});
}

function mergeTranscript(base: string, addition: string) {
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) return base;
  if (!base.trim()) return trimmedAddition;
  return /\s$/.test(base) ? `${base}${trimmedAddition}` : `${base} ${trimmedAddition}`;
}

function mapSpeechRecognitionError(error: SpeechRecognitionErrorCode) {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限被拒绝，请在系统设置中允许此应用访问麦克风。";
    case "audio-capture":
      return "没有检测到可用麦克风，请检查输入设备。";
    case "no-speech":
      return "没有识别到语音，可以再试一次。";
    case "network":
      return "语音识别网络请求失败，请检查网络后重试。";
    case "language-not-supported":
      return "当前系统语音识别暂不支持所选语言。";
    default:
      return "语音输入未能完成，请重试。";
  }
}

function normalizeSpeechErrorMessage(message: string) {
  if (message.includes("离线转写失败: 本地离线语音引擎未安装")) {
    return "离线语音未安装。先运行 `python3 -m pip install mlx-whisper`，然后重试。";
  }
  return message;
}

function useSpeechDictation({
  value,
  onChange,
  onError,
}: {
  value: string;
  onChange: (value: string) => void;
  onError?: (message: string) => void;
}) {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const fallbackActiveRef = useRef(false);
  const fallbackChunkTimerRef = useRef<number | null>(null);
  const fallbackTranscribingRef = useRef(false);
  const baseValueRef = useRef("");
  const interimRef = useRef("");
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [provider, setProvider] = useState<"system" | "fallback" | null>(null);

  useEffect(() => {
    const speechWindow = window as SpeechRecognitionWindow;
    const SpeechRecognitionCtor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    setSupported(Boolean(SpeechRecognitionCtor));
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      if (fallbackChunkTimerRef.current !== null) {
        window.clearInterval(fallbackChunkTimerRef.current);
      }
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const stopFallbackRecording = useCallback(() => {
    fallbackActiveRef.current = false;
    if (fallbackChunkTimerRef.current !== null) {
      window.clearInterval(fallbackChunkTimerRef.current);
      fallbackChunkTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    stopFallbackRecording();
  }, [stopFallbackRecording]);

  const transcribeFallbackChunk = useCallback(async (blob: Blob) => {
    if (!blob.size || fallbackTranscribingRef.current) return;
    fallbackTranscribingRef.current = true;
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      const audioBase64 = btoa(binary);
      const result = await api.speech.transcribe({
        audioBase64,
        mimeType: blob.type || "audio/webm",
        fileName: blob.type.includes("mp4") ? "speech.m4a" : "speech.webm",
        language: (navigator.language || "zh-CN").split("-")[0],
      });
      if (result.text.trim()) {
        baseValueRef.current = mergeTranscript(baseValueRef.current, result.text);
        setInterimTranscript(result.text.trim());
        onChange(baseValueRef.current);
      }
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "录音转写失败，请稍后重试。");
      stopFallbackRecording();
      setListening(false);
    } finally {
      fallbackTranscribingRef.current = false;
    }
  }, [onChange, onError, stopFallbackRecording]);

  const startFallbackRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStreamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    fallbackActiveRef.current = true;
    setProvider("fallback");
    setListening(true);
    setInterimTranscript("");

    recorder.ondataavailable = (event) => {
      if (!fallbackActiveRef.current || !event.data || !event.data.size) return;
      void transcribeFallbackChunk(event.data);
    };

    recorder.onstop = () => {
      if (!fallbackActiveRef.current) {
        setListening(false);
        setProvider(null);
      }
    };

    recorder.start();
    fallbackChunkTimerRef.current = window.setInterval(() => {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
    }, 2200);
  }, [transcribeFallbackChunk]);

  const start = useCallback(() => {
    const speechWindow = window as SpeechRecognitionWindow;
    const SpeechRecognitionCtor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      void startFallbackRecording().catch((error) => {
        onError?.(error instanceof Error ? error.message : "当前环境不支持语音输入。");
      });
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "zh-CN";
    recognition.maxAlternatives = 1;

    baseValueRef.current = value;
    interimRef.current = "";

    recognition.onstart = () => {
      setListening(true);
      setInterimTranscript("");
      setProvider("system");
    };

    recognition.onresult = (event) => {
      let finalTranscript = "";
      let interimTranscriptValue = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript || "";
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscriptValue += transcript;
        }
      }

      if (finalTranscript.trim()) {
        baseValueRef.current = mergeTranscript(baseValueRef.current, finalTranscript);
      }

      interimRef.current = interimTranscriptValue;
      setInterimTranscript(interimTranscriptValue);
      onChange(mergeTranscript(baseValueRef.current, interimTranscriptValue));
    };

    recognition.onerror = (event) => {
      if (event.error === "network") {
        recognitionRef.current = null;
        setListening(false);
        setInterimTranscript("");
        void startFallbackRecording().catch((error) => {
          onError?.(error instanceof Error ? error.message : "语音输入降级失败，请稍后重试。");
        });
        return;
      }
      if (event.error !== "aborted") {
        onError?.(mapSpeechRecognitionError(event.error));
      }
    };

    recognition.onend = () => {
      if (fallbackActiveRef.current) return;
      setListening(false);
      setInterimTranscript("");
      interimRef.current = "";
      recognitionRef.current = null;
      setProvider(null);
      onChange(baseValueRef.current);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [onChange, onError, value]);

  const toggle = useCallback(() => {
    if (listening) {
      stop();
      return;
    }
    start();
  }, [listening, start, stop]);

  return {
    supported,
    listening,
    interimTranscript,
    provider,
    toggle,
    stop,
  };
}

function SpeechStreamingStatus({
  listening,
  interimTranscript,
  provider,
  className = "",
}: {
  listening: boolean;
  interimTranscript: string;
  provider?: "system" | "fallback" | null;
  className?: string;
}) {
  const trimmedInterim = interimTranscript.trim();
  if (!listening && !trimmedInterim) return null;

  return (
    <div className={cx("rounded-xl border border-amber-100 bg-amber-50/80 px-3 py-2 text-[11px] leading-5 text-amber-900", className)}>
      <div className="flex items-center gap-2">
        <span className={cx("h-2 w-2 rounded-full", listening ? "animate-pulse bg-red-500" : "bg-neutral-300")} />
        <span className="font-medium">
          {listening
            ? provider === "fallback"
              ? "语音流式输入中 · 录音转写"
              : "语音流式输入中 · 系统识别"
            : "语音转写已暂停"}
        </span>
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-amber-800/90">
        {trimmedInterim || "正在监听你的语音，识别到的文本会实时出现在这里。"}
      </div>
    </div>
  );
}

interface ProviderPresetModel {
  id: string;
  label: string;
  description: string;
  contextLimit?: number;
  contextNote?: string;
}

interface ProviderPresetVariant {
  label: string;
  baseUrl: string;
  helper: string;
  models: ProviderPresetModel[];
  unavailableReason?: string;
}

interface ProviderPresetCard {
  providerId: string;
  providerLabel: string;
  accent: string;
  chip: string;
  category: string;
  filterCategories?: string[];
  baseUrl: string;
  helper: string;
  models: ProviderPresetModel[];
  nvidiaPreset?: ProviderPresetVariant;
}

const navItems: Array<{ id: ViewKey; icon: LucideIcon; label: string }> = [
  { id: "dashboard", icon: PenSquare, label: "新对话" },
  { id: "search", icon: Search, label: "搜索" },
  { id: "agents", icon: Users, label: "智能体协作" },
  { id: "skills", icon: Layers, label: "技能" },
  { id: "plugins", icon: Puzzle, label: "插件" },
  { id: "automation", icon: Clock, label: "自动化" },
];

const quickActions = [
  { icon: Search, label: "搜索仓库", prompt: "搜索当前仓库中和任务队列、Electron、React UI 相关的实现，并总结结构。" },
  { icon: Users, label: "代码审阅", prompt: "审阅当前工作区的改动，优先指出风险、缺失测试和行为回归。" },
  { icon: Layers, label: "生成计划", prompt: "基于当前仓库，生成下一阶段桌面应用开发计划，包含模块边界和验收标准。" },
  { icon: Puzzle, label: "检查插件", prompt: "检查当前项目可以接入哪些 MCP 或插件能力，并输出配置建议。" },
  { icon: Clock, label: "状态快照", prompt: "运行本地状态检查，整理仓库、配置、任务和环境健康情况。" },
];

const defaultPreferences: PublicPreferences = {
  clawPath: "claw",
  defaultModel: "claude-opus-4-6",
  openaiBaseUrl: "",
  openaiCompatEnabled: false,
  permissionMode: "danger-full-access",
  workspacePath: "/Users/mac/Documents/New project",
  theme: "light",
  fontSize: 13,
  autoSaveLogs: true,
  anthropicApiKeySet: false,
  anthropicAuthTokenSet: false,
  openaiApiKeySet: false,
  enableDeepSeek1M: false,
  modelProfiles: [],
  saveSingleTurnInOnePlace: true,
};

const emptyCatalog: LocalCatalog = {
  skills: [],
  plugins: [],
  automations: [],
  generatedAt: "",
};

const featurePages: Record<
  FeatureViewKey,
  {
    icon: LucideIcon;
    title: string;
    subtitle: string;
    inputPlaceholder: string;
    primaryLabel: string;
    promptPrefix: string;
    actions: Array<{ icon: LucideIcon; title: string; description: string; prompt: string }>;
  }
> = {
  search: {
    icon: Search,
    title: "搜索",
    subtitle: "围绕当前工作区做代码、文件和历史任务检索。",
    inputPlaceholder: "输入要搜索的文件、函数、错误或需求",
    primaryLabel: "搜索工作区",
    promptPrefix: "在当前工作区搜索并总结",
    actions: [
      { icon: Search, title: "搜索仓库结构", description: "定位目录、入口文件和关键模块。", prompt: "搜索当前工作区的项目结构，列出主要目录、入口文件和关键模块职责。" },
      { icon: Terminal, title: "查找错误线索", description: "围绕构建、运行、白屏和 IPC 查找原因。", prompt: "搜索当前工作区中可能导致构建失败、Electron 白屏、IPC 异常的代码路径，并给出风险列表。" },
      { icon: FileText, title: "提取最近改动", description: "整理当前 UI 和桌面壳相关变化。", prompt: "整理当前工作区最近与 UI、Electron 打包、任务队列相关的改动，并总结影响范围。" },
    ],
  },
  agents: {
    icon: Users,
    title: "智能体协作",
    subtitle: "把复杂工作拆成审阅、实现、验证等并行角色。",
    inputPlaceholder: "输入要拆分协作的目标",
    primaryLabel: "生成协作计划",
    promptPrefix: "把下面目标拆成智能体协作计划",
    actions: [
      { icon: Users, title: "拆分实现任务", description: "按 UI、桥接层、存储和打包划分职责。", prompt: "把当前桌面应用后续开发拆分为 UI、Electron 桥接层、数据层、打包验证四个协作任务，并给出验收标准。" },
      { icon: CheckCircle2, title: "审阅与验证", description: "生成审查和 QA 分工。", prompt: "为当前桌面应用生成一套代码审查和 UI 回归验证分工，覆盖白屏、窗口按钮、任务队列和设置保存。" },
      { icon: Layers, title: "模块边界", description: "梳理前端、主进程、preload 的接口边界。", prompt: "分析当前 Electron + React 项目的模块边界，指出主进程、preload、renderer 各自职责和需要保持的约束。" },
    ],
  },
  skills: {
    icon: Layers,
    title: "技能",
    subtitle: "把常用开发动作沉淀成可重复调用的任务模板。",
    inputPlaceholder: "输入要沉淀成技能的工作流",
    primaryLabel: "生成技能模板",
    promptPrefix: "把下面工作流整理成可复用技能",
    actions: [
      { icon: PenSquare, title: "桌面 UI 调整", description: "窗口按钮、侧栏、页面布局的固定检查流程。", prompt: "为这个桌面应用整理一份 UI 调整技能：包含截图对照、构建、dev 验证、打包版验证和回归清单。" },
      { icon: Shield, title: "Electron 安全检查", description: "检查 preload、IPC、凭据和本地命令执行。", prompt: "生成 Electron 安全检查技能，覆盖 IPC 参数校验、safeStorage、nodeIntegration、contextIsolation、child_process 输入约束。" },
      { icon: Archive, title: "发布打包流程", description: "把构建、打包、验证步骤固化。", prompt: "把当前项目的 macOS 打包发布流程整理成可执行清单，包括 build、dist、打开 release app、截图验证和已知签名限制。" },
    ],
  },
  plugins: {
    icon: Puzzle,
    title: "插件",
    subtitle: "管理本地能力、MCP 入口和未来扩展点。",
    inputPlaceholder: "输入要接入的插件或能力",
    primaryLabel: "生成接入方案",
    promptPrefix: "为当前应用设计插件接入方案",
    actions: [
      { icon: Puzzle, title: "MCP 接入清单", description: "整理文件、GitHub、浏览器和自动化能力。", prompt: "检查当前桌面应用适合接入哪些 MCP 或插件能力，并按优先级输出接入清单。" },
      { icon: Database, title: "插件配置存储", description: "设计本地配置、启停状态和安全字段。", prompt: "设计插件配置的数据结构，包含启用状态、命令、环境变量、安全字段和历史缓存。" },
      { icon: Terminal, title: "CLI 能力包装", description: "把本地命令封装成可队列化任务。", prompt: "设计一个插件式 CLI wrapper，让当前应用可以安全执行多个本地工具，并复用任务队列和日志输出。" },
    ],
  },
  automation: {
    icon: Clock,
    title: "自动化",
    subtitle: "规划定时检查、任务回放和本地监控工作流。",
    inputPlaceholder: "输入要自动化的重复工作",
    primaryLabel: "生成自动化任务",
    promptPrefix: "为当前应用设计自动化工作流",
    actions: [
      { icon: Clock, title: "每日状态快照", description: "检查构建、任务、工作区和依赖状态。", prompt: "设计一个每日状态快照自动化，检查当前桌面应用构建状态、任务历史、工作区路径和本地 claw 可用性。" },
      { icon: Activity, title: "任务健康监控", description: "跟踪失败任务、长输出和日志异常。", prompt: "为任务队列设计健康监控方案，覆盖失败率、长时间运行、输出过大、日志写入异常和 UI 提示。" },
      { icon: RefreshCw, title: "发布前回归", description: "自动跑构建、打包、截图和关键交互验证。", prompt: "设计发布前回归自动化：运行 build、dist，打开打包版，验证不白屏、窗口按钮、侧栏导航、任务日志和设置弹窗。" },
    ],
  },
};

const featureViewKeys: FeatureViewKey[] = ["search", "agents", "skills", "plugins", "automation"];
const largeConversationCharThreshold = 500_000;
const largeConversationDebounceMs = 600;
const builtInSkillNames = [
  "api-and-interface-design",
  "browser-testing-with-devtools",
  "ci-cd-and-automation",
  "code-review-and-quality",
  "code-simplification",
  "context-engineering",
  "debugging-and-error-recovery",
  "deprecation-and-migration",
  "documentation-and-adrs",
  "doubt-driven-development",
  "frontend-ui-engineering",
  "git-workflow-and-versioning",
  "idea-refine",
  "incremental-implementation",
  "interview-me",
  "performance-optimization",
  "planning-and-task-breakdown",
  "security-and-hardening",
  "shipping-and-launch",
  "source-driven-development",
  "spec-driven-development",
  "test-driven-development",
  "using-agent-skills",
] as const;
const slashCommandPresets = [
  { command: "spec", skillName: "spec-driven-development", aliases: [] as string[] },
  { command: "plan", skillName: "planning-and-task-breakdown", aliases: [] as string[] },
  { command: "build", skillName: "incremental-implementation", aliases: [] as string[] },
  { command: "test", skillName: "test-driven-development", aliases: [] as string[] },
  { command: "review", skillName: "code-review-and-quality", aliases: ["code-review"] },
  { command: "code-simplify", skillName: "code-simplification", aliases: ["simplify"] },
  { command: "ship", skillName: "shipping-and-launch", aliases: [] as string[] },
] as const;
const visibleSlashCommands = ["/spec", "/plan", "/build", "/test", "/review", "/code-simplify", "/ship", "/skill"];

type SkillCatalogItem = LocalCatalog["skills"][number];

interface SlashCommandResolution {
  prompt: string;
  matchedCommand?: string;
  matchedSkillName?: string;
  error?: string;
}

interface SlashMenuOption {
  id: string;
  kind: "command" | "skill";
  label: string;
  title: string;
  description: string;
  insertValue: string;
  meta: string;
}

interface SlashMenuState {
  visible: boolean;
  dismissKey: string;
  options: SlashMenuOption[];
  mode: "command" | "skill";
  query: string;
}

interface SlashMenuGroup {
  id: SlashMenuOption["kind"];
  label: string;
  items: Array<{ option: SlashMenuOption; index: number }>;
}

interface SlashMenuPosition {
  left: number;
  top: number;
  arrowLeft: number;
  placement: "above" | "below";
}

interface WorktreeModalState {
  workspaceId: string;
  sourcePath: string;
  sourceName: string;
}

function getTextareaCaretPosition(textarea: HTMLTextAreaElement, caretIndex: number) {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const safeCaretIndex = Math.max(0, Math.min(caretIndex, textarea.value.length));
  const styles = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  const mirroredProperties = [
    "box-sizing",
    "width",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "font-kerning",
    "font-stretch",
    "font-variant",
    "letter-spacing",
    "line-height",
    "text-align",
    "text-indent",
    "text-transform",
    "white-space",
    "word-break",
    "word-spacing",
    "overflow-wrap",
    "tab-size",
  ];

  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.zIndex = "-1";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";
  mirror.style.overflowWrap = "anywhere";

  mirroredProperties.forEach((property) => {
    mirror.style.setProperty(property, styles.getPropertyValue(property));
  });

  const beforeCaret = textarea.value.slice(0, safeCaretIndex);
  mirror.textContent = beforeCaret.endsWith("\n") ? `${beforeCaret}\u200b` : beforeCaret;
  marker.textContent = textarea.value.slice(safeCaretIndex) || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const lineHeight = Number.parseFloat(styles.lineHeight) || Number.parseFloat(styles.fontSize) * 1.5 || 24;
  const position = {
    left: marker.offsetLeft - textarea.scrollLeft,
    top: marker.offsetTop - textarea.scrollTop,
    lineHeight,
  };

  document.body.removeChild(mirror);
  return position;
}

function getBundledSkillPath(skillName: string): string {
  return `skills/agent-skills/skills/${skillName}/SKILL.md`;
}

function findSkillForCommand(catalogSkills: SkillCatalogItem[], requestedName: string): Pick<SkillCatalogItem, "name" | "path"> | null {
  const normalized = requestedName.trim().toLowerCase();
  if (!normalized) return null;

  const catalogMatch = catalogSkills.find((skill) => skill.name.trim().toLowerCase() === normalized);
  if (catalogMatch) {
    return {
      name: catalogMatch.name,
      path: catalogMatch.path,
    };
  }

  const bundledMatch = builtInSkillNames.find((skillName) => skillName.toLowerCase() === normalized);
  if (!bundledMatch) return null;
  return {
    name: bundledMatch,
    path: getBundledSkillPath(bundledMatch),
  };
}

function buildSkillCommandPrompt(rawCommand: string, skill: Pick<SkillCatalogItem, "name" | "path">, userTask: string): string {
  const normalizedTask =
    userTask.trim() || "请先结合当前工作区判断最合适的切入步骤；如果缺少关键信息，先明确列出需要我补充的问题。";

  return [
    `Slash 命令: ${rawCommand}`,
    "",
    `请使用技能 ${skill.name} 处理下面任务，并优先遵循该技能的工作流。`,
    `技能路径: ${skill.path}`,
    "",
    "执行补充要求:",
    "如果任务需要参考官网、联网搜索或抓取页面，而目标站点返回 Access Denied、403、机器人验证、超时，或当前环境暂时无法联网：先用一句话说明限制，再继续使用可访问的替代可信来源完成任务。",
    "替代来源优先级：同品牌其他官方页面、官方新闻稿、官方投资者页面、官方文档；如仍不足，再使用高可信公共资料交叉验证。",
    "不要仅因单个站点无法访问就中止整个任务，也不要把原始抓取日志、工具返回 JSON 或整段错误回显给用户。",
    "如果仍有关键事实无法核实，要明确标注哪些内容来自替代来源，哪些属于合理假设。",
    "",
    "用户任务:",
    normalizedTask,
  ].join("\n");
}

function dedupeSkills(skills: SkillCatalogItem[]): SkillCatalogItem[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSlashMenuState(input: string, catalogSkills: SkillCatalogItem[]): SlashMenuState {
  const normalizedInput = input.replace(/\r\n?/g, "\n");
  const [firstLine = ""] = normalizedInput.split("\n");
  const trimmedFirstLine = firstLine.trim();

  if (!trimmedFirstLine.startsWith("/")) {
    return {
      visible: false,
      dismissKey: "",
      options: [],
      mode: "command",
      query: "",
    };
  }

  const uniqueSkills = dedupeSkills(catalogSkills);
  const topSkills = uniqueSkills.slice(0, 8);
  const skillModeMatch = trimmedFirstLine.match(/^\/skill(?:\s+([^\s]*))?$/i);
  if (skillModeMatch) {
    const rawQuery = skillModeMatch[1]?.trim().toLowerCase() || "";
    const matchingSkills = (rawQuery ? uniqueSkills : topSkills)
      .filter((skill) => {
        if (!rawQuery) return true;
        const name = skill.name.trim().toLowerCase();
        return name.startsWith(rawQuery) || name.includes(rawQuery);
      })
      .slice(0, 10)
      .map<SlashMenuOption>((skill) => ({
        id: `skill:${skill.name}`,
        kind: "skill",
        label: `/skill ${skill.name}`,
        title: skill.name,
        description: skill.description,
        insertValue: `/skill ${skill.name}\n\n`,
        meta: skill.source,
      }));

    return {
      visible: true,
      dismissKey: trimmedFirstLine,
      options: matchingSkills,
      mode: "skill",
      query: rawQuery,
    };
  }

  const commandModeMatch = trimmedFirstLine.match(/^\/([^\s]*)$/);
  if (!commandModeMatch) {
    return {
      visible: false,
      dismissKey: "",
      options: [],
      mode: "command",
      query: "",
    };
  }

  const rawQuery = commandModeMatch[1]?.trim().toLowerCase() || "";
  const commandOptions: SlashMenuOption[] = [
    {
      id: "command:spec",
      kind: "command" as const,
      label: "/spec",
      title: "spec",
      description: "先写规格、边界和验收标准，再进入实现。",
      insertValue: "/spec ",
      meta: "spec-driven-development",
    },
    {
      id: "command:plan",
      kind: "command" as const,
      label: "/plan",
      title: "plan",
      description: "把目标拆成小步可验证任务，适合开工前梳理。",
      insertValue: "/plan ",
      meta: "planning-and-task-breakdown",
    },
    {
      id: "command:build",
      kind: "command" as const,
      label: "/build",
      title: "build",
      description: "按薄切片实现功能，强调逐步交付与验证。",
      insertValue: "/build ",
      meta: "incremental-implementation",
    },
    {
      id: "command:test",
      kind: "command" as const,
      label: "/test",
      title: "test",
      description: "用测试驱动验证行为，适合修 bug 或补回归。",
      insertValue: "/test ",
      meta: "test-driven-development",
    },
    {
      id: "command:review",
      kind: "command" as const,
      label: "/review",
      title: "review",
      description: "按代码审查视角检查风险、回归和缺失测试。",
      insertValue: "/review ",
      meta: "code-review-and-quality",
    },
    {
      id: "command:code-simplify",
      kind: "command" as const,
      label: "/code-simplify",
      title: "code-simplify",
      description: "在不改行为的前提下压低复杂度、简化结构。",
      insertValue: "/code-simplify ",
      meta: "code-simplification",
    },
    {
      id: "command:ship",
      kind: "command" as const,
      label: "/ship",
      title: "ship",
      description: "用发布前检查与上线清单收尾，适合准备交付。",
      insertValue: "/ship ",
      meta: "shipping-and-launch",
    },
    {
      id: "command:skill",
      kind: "command" as const,
      label: "/skill",
      title: "skill",
      description: "按技能名调用任意 skill，例如 frontend-ui-engineering。",
      insertValue: "/skill ",
      meta: "any installed skill",
    },
  ]
    .filter((item) => {
      if (!rawQuery) return true;
      return item.title.includes(rawQuery) || item.meta.toLowerCase().includes(rawQuery);
    })
    .slice(0, 8);

  const candidateSkills = rawQuery ? uniqueSkills : topSkills.slice(0, 4);
  const skillOptions = candidateSkills
    .filter((skill) => {
      if (!rawQuery) return true;
      const name = skill.name.trim().toLowerCase();
      return name.startsWith(rawQuery) || name.includes(rawQuery);
    })
    .slice(0, rawQuery ? 6 : 4)
    .map<SlashMenuOption>((skill) => ({
      id: `skill-shortcut:${skill.name}`,
      kind: "skill",
      label: `/${skill.name}`,
      title: skill.name,
      description: skill.description,
      insertValue: `/skill ${skill.name}\n\n`,
      meta: skill.source,
    }));

  return {
    visible: true,
    dismissKey: trimmedFirstLine,
    options: [...commandOptions, ...skillOptions],
    mode: "command",
    query: rawQuery,
  };
}

function resolveSlashCommandPrompt(input: string, catalogSkills: SkillCatalogItem[]): SlashCommandResolution {
  const normalizedInput = input.replace(/\r\n?/g, "\n").trim();
  if (!normalizedInput.startsWith("/")) {
    return { prompt: normalizedInput };
  }

  const [firstLine = "", ...restLines] = normalizedInput.split("\n");
  const firstLineMatch = firstLine.trim().match(/^\/([^\s]+)(?:\s+(.*))?$/);
  if (!firstLineMatch) {
    return { prompt: normalizedInput };
  }

  const commandName = firstLineMatch[1].toLowerCase();
  const inlineArgs = firstLineMatch[2]?.trim() || "";
  const trailingBody = restLines.join("\n").trim();
  const combinedBody = [inlineArgs, trailingBody].filter(Boolean).join("\n").trim();

  if (commandName === "skill") {
    if (!combinedBody) {
      return {
        prompt: normalizedInput,
        error: "请在 /skill 后填写技能名，例如 /skill frontend-ui-engineering。",
      };
    }

    const [skillLine = "", ...taskLines] = combinedBody.split("\n");
    const [skillNameToken = "", ...inlineTaskTokens] = skillLine.trim().split(/\s+/);
    const resolvedSkill = findSkillForCommand(catalogSkills, skillNameToken);
    if (!resolvedSkill) {
      return {
        prompt: normalizedInput,
        error: `未找到技能 ${skillNameToken}。可用方式：/skill frontend-ui-engineering 或直接输入 /spec /plan /review。`,
      };
    }

    const taskBody = [inlineTaskTokens.join(" "), taskLines.join("\n").trim()].filter(Boolean).join("\n").trim();
    return {
      prompt: buildSkillCommandPrompt(`/skill ${resolvedSkill.name}`, resolvedSkill, taskBody),
      matchedCommand: "/skill",
      matchedSkillName: resolvedSkill.name,
    };
  }

  const preset = slashCommandPresets.find(
    (item) => item.command === commandName || item.aliases.some((alias) => alias === commandName),
  );
  if (preset) {
    const resolvedSkill =
      findSkillForCommand(catalogSkills, preset.skillName) || {
        name: preset.skillName,
        path: getBundledSkillPath(preset.skillName),
      };
    return {
      prompt: buildSkillCommandPrompt(`/${commandName}`, resolvedSkill, combinedBody),
      matchedCommand: `/${commandName}`,
      matchedSkillName: resolvedSkill.name,
    };
  }

  const directSkill = findSkillForCommand(catalogSkills, commandName);
  if (directSkill) {
    return {
      prompt: buildSkillCommandPrompt(`/${commandName}`, directSkill, combinedBody),
      matchedCommand: `/${commandName}`,
      matchedSkillName: directSkill.name,
    };
  }

  return {
    prompt: normalizedInput,
    error: `未识别的 /命令：/${commandName}。支持 ${visibleSlashCommands.join("、")} 以及 /<skill-name>。`,
  };
}
const nvidiaNimBaseUrl = "https://integrate.api.nvidia.com/v1";
const nvidiaNimExampleModel = "nvidia/llama-3.3-nemotron-super-49b-v1.5";
const xiaomiMimoBaseUrl = "https://api.xiaomimimo.com/v1";
const providerPresetCards: ProviderPresetCard[] = [
  {
    providerId: "nvidia-nim",
    providerLabel: "NVIDIA NIM",
    accent: "from-[#101828] via-[#1d2939] to-[#76b900]",
    chip: "高性能",
    category: "高性能推理",
    baseUrl: nvidiaNimBaseUrl,
    helper: "官方模型目录与接入地址，适合 Nemotron / Llama 系列测试。",
    models: [
  {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    label: "Llama 3.3 Nemotron Super 49B v1.5",
    description: "官方目录中的高质量通用聊天 / 推理模型。",
    contextLimit: 128_000,
    contextNote: "官方上下文 128K",
  },
  {
    id: "nvidia/llama-3.3-nemotron-super-49b-v1",
    label: "Llama 3.3 Nemotron Super 49B v1",
    description: "较早版本，适合与 v1.5 做兼容性对比。",
    contextLimit: 128_000,
    contextNote: "官方上下文 128K",
  },
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super 120B A12B",
    description: "大参数通用模型，适合复杂推理与规划任务。",
    contextLimit: 1_000_000,
    contextNote: "官方上下文最高 1M",
  },
  {
    id: "nvidia/nemotron-3-nano-30b-a3b",
    label: "Nemotron 3 Nano 30B A3B",
    description: "1M 上下文 MoE 模型，偏效率与长上下文。",
    contextLimit: 1_000_000,
    contextNote: "官方可提升至 1M，示例部署默认 256K",
  },
  {
    id: "nvidia/nvidia-nemotron-nano-9b-v2",
    label: "NVIDIA Nemotron Nano 9B v2",
    description: "更轻量，适合快速测试或低成本试跑。",
    contextLimit: 128_000,
    contextNote: "官方上下文 128K",
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    label: "Nemotron 3 Nano Omni 30B Reasoning",
    description: "官方近期推理模型，偏多模态 / reasoning 场景。",
    contextLimit: 256_000,
    contextNote: "官方上下文 256K",
  },
    ],
  },
  {
    providerId: "z-ai",
    providerLabel: "Z.AI",
    accent: "from-[#0d1b2a] via-[#1b263b] to-[#415a77]",
    chip: "GLM",
    category: "国内模型",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    helper: "智谱 GLM 官方兼容地址，适合国内直连与 GLM 族模型。",
    models: [
      {
        id: "glm-5.1",
        label: "GLM 5.1",
        description: "通用旗舰模型，适合日常编码、分析与代理任务。",
        contextLimit: 200_000,
        contextNote: "官方上下文 200K",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate 当前提供 Z.AI 的 GLM 4.7 与 GLM 5.1，可直接切换到统一 NVIDIA 接入地址。",
      models: [
        {
          id: "z-ai/glm5.1",
          label: "GLM 5.1",
          description: "NVIDIA integrate 上的 Z.AI GLM 5.1，适合通用代理与复杂任务。",
        },
        {
          id: "z-ai/glm4.7",
          label: "GLM 4.7",
          description: "NVIDIA integrate 上的 GLM 4.7，偏编码与工具调用场景。",
        },
      ],
    },
  },
  {
    providerId: "moonshot",
    providerLabel: "Moonshot AI",
    accent: "from-[#111827] via-[#1f2937] to-[#f59e0b]",
    chip: "Kimi",
    category: "国内模型",
    baseUrl: "https://api.moonshot.cn/v1",
    helper: "Kimi 官方接入地址，适合长上下文与中文写作场景。",
    models: [
      {
        id: "kimi-k2.6",
        label: "Kimi K2.6",
        description: "官方最新 K2.6，多模态输入，适合长上下文编码与 Agent 任务。",
        contextLimit: 256_000,
        contextNote: "官方上下文 256K",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate 当前列出 Moonshot 的 Kimi K2 Instruct / Thinking，可直接改走统一 NVIDIA API。",
      models: [
        {
          id: "moonshotai/kimi-k2-instruct",
          label: "Kimi K2 Instruct",
          description: "面向通用编码、推理和 agent 工作流的 NVIDIA 兼容 Kimi 预设。",
        },
        {
          id: "moonshotai/kimi-k2-thinking",
          label: "Kimi K2 Thinking",
          description: "更偏开放推理链路的 NVIDIA 兼容 Kimi 预设。",
        },
      ],
    },
  },
  {
    providerId: "deepseek",
    providerLabel: "DeepSeek",
    accent: "from-[#0f172a] via-[#1d4ed8] to-[#38bdf8]",
    chip: "高性价比",
    category: "高性能推理",
    filterCategories: ["高性能推理", "国内模型"],
    baseUrl: "https://api.deepseek.com/v1",
    helper: "DeepSeek 官方接入地址，支持 Pro / Flash 双档位切换。",
    models: [
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        description: "高质量推理与编码，适合复杂任务。",
        contextLimit: 1_000_000,
        contextNote: "官方上下文 1M",
      },
      {
        id: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        description: "更偏速度与成本，适合高频试跑。",
        contextLimit: 1_000_000,
        contextNote: "官方上下文 1M",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate 当前直接支持 DeepSeek V4 Pro / Flash，可用统一 Base URL 接入。",
      models: [
        {
          id: "deepseek-ai/deepseek-v4-pro",
          label: "DeepSeek V4 Pro",
          description: "NVIDIA integrate 上的 DeepSeek V4 Pro，适合高质量推理与编码。",
          contextNote: "NVIDIA 文档列出该模型可用",
        },
        {
          id: "deepseek-ai/deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          description: "NVIDIA integrate 上的 DeepSeek V4 Flash，适合更高频的快速试跑。",
          contextNote: "NVIDIA 文档列出该模型可用",
        },
      ],
    },
  },
  {
    providerId: "openrouter",
    providerLabel: "OpenRouter",
    accent: "from-[#111111] via-[#27272a] to-[#60a5fa]",
    chip: "路由聚合",
    category: "路由聚合",
    baseUrl: "https://openrouter.ai/api/v1",
    helper: "适合统一接入多家模型供应商，也方便测试 OSS 模型。",
    models: [
      {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B",
        description: "通过 OpenRouter 使用的大型开源 OpenAI 系列模型。",
        contextLimit: 131_072,
        contextNote: "OpenRouter 页面标注 131,072",
      },
    ],
  },
  {
    providerId: "minimax",
    providerLabel: "MiniMax",
    accent: "from-[#1f2937] via-[#374151] to-[#ef4444]",
    chip: "多模态",
    category: "国内模型",
    baseUrl: "https://api.minimax.io/v1",
    helper: "MiniMax 官方接入地址，适合 M2.7 系列与多模态路线。",
    models: [
      {
        id: "MiniMax-M2.7",
        label: "MiniMax M2.7",
        description: "按你要求加入的 M2.7 预设，适合通用代理任务。",
        contextLimit: 204_800,
        contextNote: "官方上下文 204,800",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate 当前列出 MiniMax M2.7 与 M2.5，可直接切到统一 NVIDIA 接入地址。",
      models: [
        {
          id: "minimaxai/minimax-m2.7",
          label: "MiniMax M2.7",
          description: "NVIDIA integrate 上的 MiniMax M2.7，适合编码、推理与办公类任务。",
        },
        {
          id: "minimaxai/minimax-m2.5",
          label: "MiniMax M2.5",
          description: "NVIDIA integrate 上的 MiniMax M2.5，适合作为更稳妥的兼容备选。",
        },
      ],
    },
  },
  {
    providerId: "dashscope",
    providerLabel: "DashScope",
    accent: "from-[#172554] via-[#1e3a8a] to-[#22c55e]",
    chip: "Qwen",
    category: "国内模型",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    helper: "阿里云百炼兼容地址，适合 Qwen 系列官方接入。",
    models: [
      {
        id: "qwen3.5-397b-a17b",
        label: "Qwen 3.5 397B A17B",
        description: "超大参数旗舰，适合追求上限的复杂中文与推理场景。",
        contextLimit: 256_000,
        contextNote: "官方上下文 256K",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate 当前提供多组 Qwen LLM 模型，可直接复用统一 NVIDIA Base URL。",
      models: [
        {
          id: "qwen/qwen3-5-122b-a10b",
          label: "Qwen 3.5 122B A10B",
          description: "更贴近通用推理 / 代理工作流的 NVIDIA 兼容 Qwen 预设。",
        },
        {
          id: "qwen/qwen3-coder-480b-a35b-instruct",
          label: "Qwen 3 Coder 480B",
          description: "偏编码与 agentic coding 的 NVIDIA 兼容 Qwen 预设。",
        },
        {
          id: "qwen/qwen3-next-80b-a3b-instruct",
          label: "Qwen 3 Next 80B Instruct",
          description: "更轻量的 NVIDIA 兼容 Qwen 备选，适合先做链路验证。",
        },
      ],
    },
  },
  {
    providerId: "xiaomi-mimo",
    providerLabel: "Xiaomi MiMo",
    accent: "from-[#151515] via-[#ff6a00] to-[#ff9f43]",
    chip: "MiMo",
    category: "国内模型",
    baseUrl: xiaomiMimoBaseUrl,
    helper: "小米 MiMo 官方接入地址，适合验证 1M 上下文与官方模型能力。",
    models: [
      {
        id: "mimo-v2.5",
        label: "MiMo V2.5",
        description: "官网系列页明确标注 1M 上下文，适合优先验证长上下文能力。",
        contextLimit: 1_000_000,
        contextNote: "官网明确 1M 上下文",
      },
      {
        id: "mimo-v2.5-pro",
        label: "MiMo V2.5 Pro",
        description: "官方 OpenAI API 文档示例模型，适合直接测试接入链路。",
        contextNote: "官方当前未单列上下文上限",
      },
    ],
    nvidiaPreset: {
      label: "NVIDIA 兼容预设",
      baseUrl: nvidiaNimBaseUrl,
      helper: "NVIDIA integrate Base URL 固定为统一入口，但当前官方模型列表里还没有 Xiaomi MiMo 家族。",
      models: [],
      unavailableReason: "截至 NVIDIA LLM API 文档最近一次更新，`integrate.api.nvidia.com/v1` 尚未列出 Xiaomi MiMo 兼容模型。",
    },
  },
];
function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function normalizeModelProfilesForUi(modelProfiles: ModelProfile[]): ModelProfile[] {
  return (modelProfiles || []).map((profile) => ({
    modelId: profile.modelId || "",
    contextLimit: profile.contextLimit,
    inputPricePerMillion: profile.inputPricePerMillion,
    outputPricePerMillion: profile.outputPricePerMillion,
    cachePricePerMillion: profile.cachePricePerMillion,
  }));
}

function sanitizeModelProfilesForSave(modelProfiles: ModelProfile[]): ModelProfile[] {
  const seen = new Set<string>();
  return modelProfiles.reduce<ModelProfile[]>((profiles, profile) => {
      const modelId = stripOpenAiModelPrefixForUi(profile.modelId.trim());
      if (!modelId) return profiles;
      const key = modelId.toLowerCase();
      if (seen.has(key)) return profiles;
      seen.add(key);
      const normalizeNumber = (value: number | undefined) => {
        if (value === undefined || value === null) return undefined;
        return Number.isFinite(value) && value >= 0 ? value : undefined;
      };
      profiles.push({
        modelId,
        contextLimit: normalizeNumber(profile.contextLimit),
        inputPricePerMillion: normalizeNumber(profile.inputPricePerMillion),
        outputPricePerMillion: normalizeNumber(profile.outputPricePerMillion),
        cachePricePerMillion: normalizeNumber(profile.cachePricePerMillion),
      });
      return profiles;
    }, []);
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: value >= 1 ? 2 : 4,
  }).format(value);
}

function stripOpenAiModelPrefixForUi(modelId: string): string {
  if (typeof modelId !== "string") return modelId;
  if (modelId.startsWith("openai/")) return modelId.slice("openai/".length);
  if (/^deepseek-ai\/deepseek-v4-(pro|flash)$/i.test(modelId)) {
    return modelId.split("/").pop() || modelId;
  }
  return modelId;
}

function modelIdsEqualForUi(left: string, right: string): boolean {
  return stripOpenAiModelPrefixForUi(left || "") === stripOpenAiModelPrefixForUi(right || "");
}

function findPresetModelMeta(modelId: string) {
  const normalizedModelId = stripOpenAiModelPrefixForUi(modelId || "");
  for (const provider of providerPresetCards) {
    const match = provider.models.find((model) => modelIdsEqualForUi(model.id, normalizedModelId));
    if (match) {
      return {
        ...match,
        providerId: provider.providerId,
        providerLabel: provider.providerLabel,
        baseUrl: provider.baseUrl,
      };
    }
  }
  return null;
}

function upsertModelProfile(profiles: ModelProfile[], profile: ModelProfile): ModelProfile[] {
  const key = stripOpenAiModelPrefixForUi(profile.modelId.trim()).toLowerCase();
  if (!key) return profiles;
  let found = false;
  const next = profiles.map((item) => {
    if (stripOpenAiModelPrefixForUi(item.modelId.trim()).toLowerCase() !== key) return item;
    found = true;
    return {
      ...item,
      ...profile,
    };
  });
  if (!found) {
    next.push({
      ...profile,
      modelId: stripOpenAiModelPrefixForUi(profile.modelId),
    });
  }
  return next;
}

function applyPresetModelProfiles(profiles: ModelProfile[], models: ProviderPresetModel[]): ModelProfile[] {
  return models.reduce<ModelProfile[]>((nextProfiles, model) => {
    if (!model.contextLimit) return nextProfiles;
    return upsertModelProfile(nextProfiles, {
      modelId: model.id,
      contextLimit: model.contextLimit,
    });
  }, profiles);
}

function MacTrafficLights() {
  return (
    <div className="no-drag flex items-center gap-1.5">
      <button
        type="button"
        aria-label="关闭窗口"
        title="关闭"
        onClick={() => api.window.close()}
        className="h-3 w-3 rounded-full bg-[#ff5f57] transition brightness-100 hover:brightness-95"
      />
      <button
        type="button"
        aria-label="最小化窗口"
        title="最小化"
        onClick={() => api.window.minimize()}
        className="h-3 w-3 rounded-full bg-[#febc2e] transition brightness-100 hover:brightness-95"
      />
      <button
        type="button"
        aria-label="切换全屏"
        title="全屏"
        onClick={() => api.window.toggleFullscreen()}
        className="h-3 w-3 rounded-full bg-[#28c840] transition brightness-100 hover:brightness-95"
      />
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
  active,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors theme-border-soft",
        active ? "bg-neutral-900 text-white" : "theme-text-muted hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

const attachmentMenuOptions: AttachmentMenuOption[] = [
  {
    kind: "file",
    label: "添加文件",
    description: "Markdown、文本和常见代码文件",
    icon: FilePlus,
  },
  {
    kind: "image",
    label: "添加图片",
    description: "PNG、JPG、GIF、WebP 等图片",
    icon: Camera,
  },
];

function AttachmentMenuButton({
  onSelect,
  disabled,
  compact = false,
  align = "left",
  buttonClassName,
  title = "添加附件",
}: {
  onSelect: (kind: AttachmentKind) => void;
  disabled?: boolean;
  compact?: boolean;
  align?: "left" | "right";
  buttonClassName?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((value) => !value)}
        className={cx(buttonClassName, "group relative overflow-hidden")}
        title={title}
      >
        <span className="absolute inset-0 bg-gradient-to-br from-black/[0.03] to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        <Plus className="relative h-4 w-4" />
        {!compact && <span className="relative">添加附件</span>}
      </button>

      {open && !disabled && (
        <>
          <button
            type="button"
            aria-label="关闭附件菜单"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => setOpen(false)}
          />
          <div
            className={cx(
              "absolute bottom-full z-50 mb-2 w-56 rounded-2xl border theme-border-soft theme-card p-2 theme-shadow-card",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] theme-text-faint">添加内容</div>
            <div className="grid gap-1">
              {attachmentMenuOptions.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  onClick={() => {
                    onSelect(option.kind);
                    setOpen(false);
                  }}
                  className="flex items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-card-muted)] theme-text-secondary">
                    <option.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12px] font-semibold theme-text-primary">{option.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-5 theme-text-muted">{option.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function WorktreeModal({
  state,
  creating,
  error,
  onClose,
  onConfirm,
}: {
  state: WorktreeModalState | null;
  creating: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (!state) return;
    setName(`${state.sourceName} Worktree`);
  }, [state]);

  if (!state) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        className="w-[520px] rounded-[28px] border theme-border-soft theme-card p-8 theme-shadow-card"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[18px] font-bold theme-text-primary">创建工作树并保存为项目</h3>
            <p className="mt-2 text-[13px] leading-6 theme-text-muted">
              从 HEAD 创建新的 Git 工作树，将其添加为项目，并保留到你将其移除为止
            </p>
          </div>
          <IconButton label="关闭弹窗" onClick={onClose} disabled={creating}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="mt-6 space-y-4">
          <div className="rounded-2xl border theme-border-soft bg-[var(--surface-card-muted)] px-4 py-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] theme-text-faint">源项目</div>
            <div className="mt-1 text-[13px] font-semibold theme-text-secondary">{state.sourceName}</div>
            <div className="mt-1 truncate text-[11px] theme-text-faint">{state.sourcePath}</div>
          </div>

          <label className="block">
            <span className="mb-2 block text-[12px] font-medium theme-text-muted">项目名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !creating && name.trim()) {
                  onConfirm(name);
                }
              }}
              placeholder="输入新工作树名称"
              className="theme-input h-12 w-full rounded-2xl border px-4 text-[15px] outline-none transition-colors focus:border-black/20"
              autoFocus
            />
          </label>

          {error ? (
            <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-[12px] leading-5 text-red-700">{error}</div>
          ) : (
            <div className="rounded-2xl border theme-border-soft bg-[var(--surface-card-muted)] px-4 py-3 text-[12px] leading-5 theme-text-muted">
              会复制该项目已有对话到新的工作树项目，并从当前仓库 HEAD 创建新的 Git worktree。
            </div>
          )}
        </div>

        <div className="mt-8 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="h-11 rounded-2xl px-5 text-[13px] font-medium theme-text-muted transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(name)}
            disabled={creating || !name.trim()}
            className="flex h-11 items-center gap-2 rounded-2xl bg-neutral-900 px-6 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
            创建
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function StatusPill({ task }: { task?: ClawTask }) {
  if (!task) {
    return <span className="rounded-md border theme-border-soft bg-[var(--surface-card-muted)] px-2 py-1 text-[12px] theme-text-muted">空闲</span>;
  }
  return (
    <span className={cx("rounded-md border px-2 py-1 text-[12px] font-semibold", statusClass(task.status))}>
      {statusLabel(task.status)}
    </span>
  );
}

function Sidebar({
  preferences,
  activeView,
  selectedTaskId,
  highlightedConversationId,
  highlightedStandaloneTaskId,
  suppressConversationHighlight,
  onChangeView,
  onToggleSidebar,
  tasks,
  onOpenSettings,
  onDeleteTask,
  onSelectTask,
  workspaces,
  expandedWorkspaces,
  onToggleWorkspace,
  onPinWorkspace,
  onRenameWorkspace,
  onRemoveWorkspace,
  onNewConversation,
  onAddWorkspace,
  onCreateWorktree,
  onArchiveWorkspace,
  onArchiveConversation,
  onShowToast,
}: {
  preferences: PublicPreferences;
  activeView: ViewKey;
  selectedTaskId: string | null;
  highlightedConversationId: string | null;
  highlightedStandaloneTaskId: string | null;
  suppressConversationHighlight: boolean;
  onChangeView: (view: ViewKey) => void;
  onToggleSidebar: () => void;
  tasks: ClawTask[];
  onOpenSettings: () => void;
  onDeleteTask: (taskId: string) => void;
  onSelectTask: (taskId: string) => void;
  workspaces: WorkspaceItem[];
  expandedWorkspaces: Record<string, boolean>;
  onToggleWorkspace: (id: string) => void;
  onPinWorkspace: (id: string) => void;
  onRenameWorkspace: (id: string, newName: string) => void;
  onRemoveWorkspace: (id: string) => void;
  onNewConversation: (path: string) => void;
  onAddWorkspace: () => void;
  onCreateWorktree: (state: WorktreeModalState) => void;
  onArchiveWorkspace: (path: string, name: string) => void;
  onArchiveConversation: (conversationId: string) => void;
  onShowToast: (msg: string) => void;
}) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [unfiledExpanded, setUnfiledExpanded] = useState(true);
  const [popoverWorkspaceId, setPopoverWorkspaceId] = useState<string | null>(null);
  const [popoverCoords, setPopoverCoords] = useState<{ top: number; left: number } | null>(null);
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  const currentWorkspaceKey = workspacePathKey(preferences.workspacePath);

  const sortedWorkspaces = useMemo(() => {
    return [...workspaces].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }, [workspaces]);

  const groupedTasks = useMemo(() => {
    const groups: Record<string, ClawTask[]> = {};
    workspaces.forEach((ws) => {
      groups[workspacePathKey(ws.path)] = [];
    });
    const unfiled: ClawTask[] = [];
    tasks.forEach((task) => {
      const taskPathKey = workspacePathKey(task.cwd || "");
      if (taskPathKey && groups[taskPathKey] !== undefined) {
        groups[taskPathKey].push(task);
      } else {
        unfiled.push(task);
      }
    });
    return { groups, unfiled };
  }, [tasks, workspaces]);

  const isConversationRowHighlighted = useCallback((task: ClawTask) => {
    if (suppressConversationHighlight) return false;
    if (workspacePathKey(task.cwd || "") !== currentWorkspaceKey) return false;
    if (highlightedConversationId && task.conversationId) {
      return task.conversationId === highlightedConversationId;
    }
    return highlightedStandaloneTaskId === task.id || selectedTaskId === task.id;
  }, [
    currentWorkspaceKey,
    highlightedConversationId,
    highlightedStandaloneTaskId,
    selectedTaskId,
    suppressConversationHighlight,
  ]);

  return (
    <aside className="theme-panel theme-text-secondary flex h-full w-64 flex-col border-r border-black/5 text-[13px]">
      <div className="drag-region flex h-12 flex-shrink-0 items-center gap-2 px-3">
        <MacTrafficLights />
        <IconButton label="收起侧边栏" onClick={onToggleSidebar}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>
      </div>



      <nav className="no-drag flex flex-col gap-0.5 px-2 pt-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChangeView(item.id)}
            className={cx(
              "flex items-center gap-2 rounded-md px-3 py-1.5 text-left transition-colors",
              activeView === item.id ? "bg-[var(--surface-hover-strong)] text-[var(--text-primary)]" : "theme-button-ghost",
            )}
          >
            <item.icon className="h-4 w-4 theme-text-muted" strokeWidth={1.75} />
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="mt-5 flex items-center px-5 theme-text-faint">
        <button
          type="button"
          onClick={() => setProjectsOpen((value) => !value)}
          className="flex items-center gap-1.5 transition-colors hover:text-[var(--text-primary)]"
        >
          <ChevronDown className={cx("h-3 w-3 transition-transform", !projectsOpen && "-rotate-90")} />
          <span className="text-[11px] font-bold uppercase tracking-wider">工作区</span>
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton label="添加工作区" onClick={onAddWorkspace}>
            <FolderPlus className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2">
        <AnimatePresence initial={false}>
          {projectsOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="flex flex-col gap-0.5 overflow-hidden animate-presence-container"
            >
              {sortedWorkspaces.map((ws) => {
                const wsTasks = groupedTasks.groups[workspacePathKey(ws.path)] || [];
                const isExpanded = expandedWorkspaces[ws.id];
                const isRenaming = renamingWorkspaceId === ws.id;

                return (
                  <div key={ws.id} className="relative">
                    <div
                      className="theme-list-hover group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-left transition-colors"
                      onClick={() => onToggleWorkspace(ws.id)}
                    >
                      <ChevronDown
                        className={cx(
                          "h-3.5 w-3.5 theme-text-faint transition-transform",
                          !isExpanded && "-rotate-90"
                        )}
                      />

                      <div className="relative">
                        <Folder className="h-3.5 w-3.5 theme-text-muted" strokeWidth={1.75} />
                        {ws.isPinned && (
                        <div className="absolute -right-1 -top-1 rounded-full bg-neutral-900 p-0.5 text-[8px] text-white">
                          <Pin className="h-2 w-2" />
                        </div>
                      )}
                      </div>

                      <div className="min-w-0 flex-1">
                        {isRenaming ? (
                          <input
                            type="text"
                            value={renamingName}
                            onChange={(e) => setRenamingName(e.target.value)}
                            onBlur={() => {
                              onRenameWorkspace(ws.id, renamingName);
                              setRenamingWorkspaceId(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                onRenameWorkspace(ws.id, renamingName);
                                setRenamingWorkspaceId(null);
                              } else if (e.key === "Escape") {
                                setRenamingWorkspaceId(null);
                              }
                            }}
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                            className="theme-input h-5 w-full rounded border px-1 text-[12px] outline-none focus:border-neutral-500"
                          />
                        ) : (
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate text-[12px] font-medium theme-text-primary">
                              {ws.name}
                            </span>
                          </div>
                        )}
                      </div>

                      {!isRenaming && (
                        <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            title="在此工作区发起对话"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNewConversation(ws.path);
                            }}
                            className="theme-button-ghost flex h-5 w-5 items-center justify-center rounded transition-colors"
                          >
                            <PenSquare className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            title="更多操作"
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const popoverHeight = 220; // approximate height of the menu with borders
                              const spaceBelow = window.innerHeight - rect.bottom;
                              let top = rect.bottom + 4;
                              if (spaceBelow < popoverHeight && rect.top > popoverHeight) {
                                top = rect.top - popoverHeight - 4;
                              }
                              setPopoverCoords({
                                top,
                                left: Math.max(10, rect.right - 192),
                              });
                              setPopoverWorkspaceId(ws.id);
                            }}
                            className="theme-button-ghost flex h-5 w-5 items-center justify-center rounded transition-colors"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {popoverWorkspaceId === ws.id && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPopoverWorkspaceId(null);
                          }}
                        />
                        <div
                          className="theme-menu fixed z-50 flex w-48 flex-col rounded-xl border py-1 text-[12px]"
                          style={{
                            top: `${popoverCoords?.top ?? 0}px`,
                            left: `${popoverCoords?.left ?? 0}px`,
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="theme-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                            onClick={() => {
                              onPinWorkspace(ws.id);
                              setPopoverWorkspaceId(null);
                            }}
                          >
                            <Pin className="h-3.5 w-3.5" />
                            <span>{ws.isPinned ? "取消置顶项目" : "置顶项目"}</span>
                          </button>
                          <button
                            type="button"
                            className="theme-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                            onClick={() => {
                              api.system.revealPath(ws.path);
                              setPopoverWorkspaceId(null);
                              onShowToast("已在访达中打开项目路径");
                            }}
                          >
                            <FolderOpen className="h-3.5 w-3.5" />
                            <span>在“访达”中打开</span>
                          </button>
                          <button
                            type="button"
                            className="theme-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                            onClick={() => {
                              setPopoverWorkspaceId(null);
                              onCreateWorktree({
                                workspaceId: ws.id,
                                sourcePath: ws.path,
                                sourceName: ws.name,
                              });
                            }}
                          >
                            <GitBranch className="h-3.5 w-3.5" />
                            <span>创建永久工作树</span>
                          </button>
                          <button
                            type="button"
                            className="theme-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                            onClick={() => {
                              setRenamingWorkspaceId(ws.id);
                              setRenamingName(ws.name);
                              setPopoverWorkspaceId(null);
                            }}
                          >
                            <PenSquare className="h-3.5 w-3.5" />
                            <span>重命名项目</span>
                          </button>
                          <button
                            type="button"
                            className="theme-menu-item flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors"
                            onClick={() => {
                              setPopoverWorkspaceId(null);
                              onArchiveWorkspace(ws.path, ws.name);
                            }}
                          >
                            <Archive className="h-3.5 w-3.5" />
                            <span>归档对话</span>
                          </button>
                          <div className="theme-border-soft my-1 border-t" />
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-500 hover:text-white transition-colors"
                            onClick={() => {
                              onRemoveWorkspace(ws.id);
                              setPopoverWorkspaceId(null);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>移除</span>
                          </button>
                        </div>
                      </>
                    )}

                    <AnimatePresence initial={false}>
                      {isExpanded && wsTasks.length > 0 && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="theme-border-soft mt-0.5 ml-4 flex flex-col gap-0.5 overflow-hidden border-l pl-3"
                        >
                          {(() => {
                            const groups: Record<string, ClawTask[]> = {};
                            const standalone: ClawTask[] = [];

                            wsTasks.forEach((task) => {
                              const cid = task.conversationId;
                              if (cid) {
                                if (!groups[cid]) {
                                  groups[cid] = [];
                                }
                                groups[cid].push(task);
                              } else {
                                standalone.push(task);
                              }
                            });

                            const processedTasks: ClawTask[] = [];

                            Object.entries(groups).forEach(([cid, groupTasks]) => {
                              if (groupTasks.length === 0) return;

                              const sortedGroup = [...groupTasks].sort(
                                (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                              );
                              const earliestTask = sortedGroup[0];
                              const latestTask = sortedGroup[sortedGroup.length - 1];

                              processedTasks.push({
                                ...latestTask,
                                prompt: earliestTask.prompt || "未命名任务",
                              });
                            });

                            standalone.forEach((task) => {
                              processedTasks.push(task);
                            });

                            processedTasks.sort(
                              (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                            );

                            return processedTasks.map((task) => (
                              <div
                                key={task.id}
                                className={cx(
                                  "group flex w-full cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1 text-left transition-colors",
                                  isConversationRowHighlighted(task)
                                    ? "border-neutral-200 bg-neutral-100/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.03)]"
                                    : "border-transparent theme-list-hover"
                                )}
                                onClick={() => {
                                  onSelectTask(task.id);
                                  onChangeView("tasks");
                                }}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <div className={cx(
                                      "truncate text-[12px] font-normal",
                                      isConversationRowHighlighted(task)
                                        ? "text-neutral-700"
                                        : "theme-text-secondary group-hover:text-[var(--text-primary)]"
                                    )}>
                                      {task.prompt || "未命名任务"}
                                    </div>
                                    {isConversationRowHighlighted(task) && task.conversationId && (
                                      <span className="shrink-0 rounded-full border border-neutral-200 bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.01em] text-neutral-600">
                                        当前对话
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] theme-text-faint">
                                    <span>{formatTime(task.createdAt)}</span>
                                    {task.status === "running" ? (
                                      <span className="flex items-center gap-1 text-[#007aff]">
                                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                        {statusLabel(task.status)}
                                      </span>
                                    ) : (
                                      <span>{statusLabel(task.status)}</span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const cid = task.conversationId || task.id;
                                      onArchiveConversation(cid);
                                    }}
                                    className="flex h-4 w-4 items-center justify-center rounded theme-text-faint transition-all hover:bg-amber-50 hover:text-amber-600"
                                    title={task.conversationId ? "归档此对话" : "归档此任务"}
                                  >
                                    <Archive className="h-3 w-3" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onDeleteTask(task.id);
                                    }}
                                    className="flex h-4 w-4 items-center justify-center rounded theme-text-faint transition-all hover:bg-red-50 hover:text-red-500"
                                    title={task.conversationId ? "删除此对话" : "删除此任务"}
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                            ));
                          })()}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}

              {groupedTasks.unfiled.length > 0 && (
                <div className="relative">
                  <div
                    className="theme-list-hover group flex w-full cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-left transition-colors"
                    onClick={() => setUnfiledExpanded(prev => !prev)}
                  >
                    <ChevronDown
                      className={cx(
                        "h-3.5 w-3.5 theme-text-faint transition-transform",
                        !unfiledExpanded && "-rotate-90"
                      )}
                    />
                    <Folder className="h-3.5 w-3.5 theme-text-faint" strokeWidth={1.75} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="truncate text-[12px] font-medium theme-text-muted">
                          未归档
                        </span>
                      </div>
                    </div>
                  </div>

                  <AnimatePresence initial={false}>
                    {unfiledExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="theme-border-soft mt-0.5 ml-4 flex flex-col gap-0.5 overflow-hidden border-l pl-3"
                      >
                        {(() => {
                          const groups: Record<string, ClawTask[]> = {};
                          const standalone: ClawTask[] = [];

                          groupedTasks.unfiled.forEach((task) => {
                            const cid = task.conversationId;
                            if (cid) {
                              if (!groups[cid]) {
                                groups[cid] = [];
                              }
                              groups[cid].push(task);
                            } else {
                              standalone.push(task);
                            }
                          });

                          const processedUnfiled: ClawTask[] = [];

                          Object.entries(groups).forEach(([cid, groupTasks]) => {
                            if (groupTasks.length === 0) return;

                            const sortedGroup = [...groupTasks].sort(
                              (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                            );
                            const earliestTask = sortedGroup[0];
                            const latestTask = sortedGroup[sortedGroup.length - 1];

                            processedUnfiled.push({
                              ...latestTask,
                              prompt: earliestTask.prompt || "未命名任务",
                            });
                          });

                          standalone.forEach((task) => {
                            processedUnfiled.push(task);
                          });

                          processedUnfiled.sort(
                            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                          );

                          return processedUnfiled.map((task) => (
                            <div
                              key={task.id}
                              className={cx(
                                "group flex w-full cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1 text-left transition-colors",
                                isConversationRowHighlighted(task)
                                  ? "border-neutral-200 bg-neutral-100/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.03)]"
                                  : "border-transparent theme-list-hover"
                              )}
                              onClick={() => {
                                onSelectTask(task.id);
                                onChangeView("tasks");
                              }}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <div className={cx(
                                    "truncate text-[12px] font-normal",
                                    isConversationRowHighlighted(task)
                                      ? "text-neutral-700"
                                      : "theme-text-secondary group-hover:text-[var(--text-primary)]"
                                  )}>
                                    {task.prompt || "未命名任务"}
                                  </div>
                                  {isConversationRowHighlighted(task) && task.conversationId && (
                                    <span className="shrink-0 rounded-full border border-neutral-200 bg-white/90 px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.01em] text-neutral-600">
                                      当前对话
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] theme-text-faint">
                                  <span>{formatTime(task.createdAt)}</span>
                                  {task.status === "running" ? (
                                    <span className="flex items-center gap-1 text-[#007aff]">
                                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                                      {statusLabel(task.status)}
                                    </span>
                                  ) : (
                                    <span>{statusLabel(task.status)}</span>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const cid = task.conversationId || task.id;
                                    onArchiveConversation(cid);
                                  }}
                                  className="flex h-4 w-4 items-center justify-center rounded text-neutral-300 hover:bg-amber-50 hover:text-amber-600 transition-all"
                                  title={task.conversationId ? "归档此对话" : "归档此任务"}
                                >
                                  <Archive className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteTask(task.id);
                                  }}
                                  className="flex h-4 w-4 items-center justify-center rounded text-neutral-300 hover:bg-red-50 hover:text-red-500 transition-all"
                                  title={task.conversationId ? "删除此对话" : "删除此任务"}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          ));
                        })()}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex-shrink-0 border-t border-black/5 p-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 theme-text-secondary transition-colors hover:bg-[var(--surface-hover)]"
        >
          <Settings className="h-4 w-4 theme-text-faint" strokeWidth={1.75} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}

interface DerivedFeaturesProps {
  taskId?: string;
  isRunning?: boolean;
  compact?: boolean;
  theme?: "light" | "dark";
  onExport?: (format: "markdown" | "json" | "html") => void;
  onGenerateSummary?: () => void;
  onCreateSnapshot?: () => void;
  onShareContext?: (format: "clipboard" | "file") => void;
  onBranchTask?: () => void;
  onCompareOutputs?: () => void;
  onExtractInsights?: () => void;
  onGenerateDocumentation?: () => void;
}

function DerivedFeatures({
  taskId,
  isRunning = false,
  compact = false,
  theme = "light",
  onExport,
  onGenerateSummary,
  onCreateSnapshot,
  onShareContext,
  onBranchTask,
  onCompareOutputs,
  onExtractInsights,
  onGenerateDocumentation,
}: DerivedFeaturesProps) {
  const [expandedMenu, setExpandedMenu] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const isDark = theme === "dark";

  if (!taskId || isRunning) {
    return null;
  }

  const derivedActions = [
    {
      id: "export",
      icon: Archive,
      label: "导出对话",
      description: "导出为 Markdown、JSON 或 HTML 格式",
      subActions: [
        { label: "Markdown", onClick: () => onExport?.("markdown") },
        { label: "JSON", onClick: () => onExport?.("json") },
        { label: "HTML", onClick: () => onExport?.("html") },
      ],
    },
    {
      id: "summary",
      icon: Brain,
      label: "生成摘要",
      description: "AI 生成对话关键点摘要",
      onClick: onGenerateSummary,
    },
    {
      id: "snapshot",
      icon: Camera,
      label: "创建快照",
      description: "保存对话和文件为快照",
      onClick: onCreateSnapshot,
    },
    {
      id: "share",
      icon: Share2,
      label: "共享上下文",
      description: "复制或导出对话内容",
      subActions: [
        { label: "复制到剪贴板", onClick: () => onShareContext?.("clipboard") },
        { label: "保存为文件", onClick: () => onShareContext?.("file") },
      ],
    },
    {
      id: "branch",
      icon: GitBranch,
      label: "分支任务",
      description: "从此处创建新的对话分支",
      onClick: onBranchTask,
    },
    {
      id: "compare",
      icon: Zap,
      label: "对比输出",
      description: "与其他任务的输出对比",
      onClick: onCompareOutputs,
    },
    {
      id: "insights",
      icon: Brain,
      label: "提取洞察",
      description: "自动分析关键信息和模式",
      onClick: onExtractInsights,
    },
    {
      id: "docs",
      icon: FileText,
      label: "生成文档",
      description: "基于对话内容生成文档",
      onClick: onGenerateDocumentation,
    },
  ];

  if (compact) {
    return (
      <div className="theme-scope relative">
        <button
          type="button"
          onClick={() => setPanelOpen((value) => !value)}
          className={cx(
            "group relative flex h-8 items-center gap-2 overflow-hidden rounded-[14px] border px-2.5 text-[12px] font-medium transition-all",
            panelOpen
              ? isDark
                ? "border-slate-200/30 bg-[var(--surface-panel-strong)] text-[var(--text-primary)] shadow-[2px_3px_0_rgba(15,23,42,0.35)]"
                : "border-neutral-900 bg-[#fcfcf8] text-neutral-900 shadow-[2px_3px_0_rgba(23,23,23,0.18)]"
              : isDark
                ? "border-white/15 bg-[var(--surface-card)] text-[var(--text-secondary)] shadow-[1px_2px_0_rgba(15,23,42,0.28)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                : "border-black/15 bg-white text-neutral-700 shadow-[1px_2px_0_rgba(23,23,23,0.12)] hover:bg-[#f8f8f4] hover:text-neutral-900"
          )}
          title="查看派生功能"
        >
          <span className={cx(
            "absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100",
            isDark
              ? "bg-[repeating-linear-gradient(-45deg,rgba(226,232,240,0.06)_0,rgba(226,232,240,0.06)_2px,transparent_2px,transparent_8px)]"
              : "bg-[repeating-linear-gradient(-45deg,rgba(23,23,23,0.03)_0,rgba(23,23,23,0.03)_2px,transparent_2px,transparent_8px)]"
          )} />
          <span className={cx(
            "relative flex h-5 w-5 rotate-[-4deg] items-center justify-center rounded-[7px] border shadow-[1px_1px_0_rgba(23,23,23,0.12)]",
            isDark ? "border-white/20 bg-[var(--surface-main)] text-[var(--text-primary)]" : "border-black/20 bg-white text-neutral-800"
          )}>
            <Boxes className="h-3 w-3" strokeWidth={2.1} />
          </span>
          <span className="relative">派生</span>
          <ChevronDown className={cx("h-3.5 w-3.5 transition-transform opacity-70", panelOpen && "rotate-180")} strokeWidth={2.2} />
        </button>

        {panelOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-transparent" onClick={() => setPanelOpen(false)} />
            <div className={cx(
              "absolute right-0 top-10 z-50 w-[360px] rounded-[20px] border p-3 animate-fade-in",
              isDark
                ? "border-white/10 bg-[var(--surface-elevated)] shadow-[0_18px_40px_rgba(2,6,23,0.4)]"
                : "border-black/10 bg-white shadow-[0_18px_40px_rgba(15,23,42,0.12)]"
            )}>
              <div className="mb-3 flex items-center gap-2 px-1">
                <div className={cx(
                  "flex h-7 w-7 items-center justify-center rounded-lg",
                  isDark ? "bg-[var(--surface-card-muted)] text-[var(--text-secondary)]" : "bg-neutral-100 text-neutral-600"
                )}>
                  <Boxes className="h-4 w-4" />
                </div>
                <div>
                  <div className={cx("text-[13px] font-semibold", isDark ? "text-[var(--text-primary)]" : "text-neutral-900")}>派生功能</div>
                  <div className={cx("text-[11px]", isDark ? "text-[var(--text-muted)]" : "text-neutral-500")}>对当前对话进行衍生操作</div>
                </div>
              </div>
              <div className="grid gap-2">
                {derivedActions.map((action) => (
                  <div key={action.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (action.subActions) {
                          setExpandedMenu(expandedMenu === action.id ? null : action.id);
                        } else {
                          action.onClick?.();
                          setPanelOpen(false);
                        }
                      }}
                      className={cx(
                        "flex w-full items-center justify-between rounded-xl border px-3 py-2.5 transition-colors",
                        isDark
                          ? "border-white/10 bg-[var(--surface-card-muted)] hover:border-white/20 hover:bg-[var(--surface-card)]"
                          : action.subActions
                            ? "border-[#e5e7eb] bg-[#fafafa] hover:border-neutral-300 hover:bg-white"
                            : "border-[#edf2f7] bg-white hover:border-neutral-300 hover:bg-neutral-50",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cx(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                          isDark ? "bg-[var(--surface-panel-strong)] text-[var(--text-secondary)]" : "bg-neutral-100 text-neutral-600"
                        )}>
                          <action.icon className="h-4 w-4" />
                        </div>
                        <div className="text-left">
                          <div className={cx("text-[12px] font-semibold", isDark ? "text-[var(--text-primary)]" : "text-neutral-900")}>{action.label}</div>
                          <div className={cx("text-[11px]", isDark ? "text-[var(--text-muted)]" : "text-neutral-500")}>{action.description}</div>
                        </div>
                      </div>
                      {action.subActions && (
                        <ChevronDown
                          className={cx(
                            "h-4 w-4 transition-transform",
                            isDark ? "text-[var(--text-faint)]" : "text-neutral-400",
                            expandedMenu === action.id ? "rotate-180" : "",
                          )}
                        />
                      )}
                    </button>

                    {action.subActions && expandedMenu === action.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mt-2 grid gap-2 overflow-hidden"
                      >
                        {action.subActions.map((subAction, index) => (
                          <button
                            key={index}
                            type="button"
                            onClick={() => {
                              subAction.onClick?.();
                              setExpandedMenu(null);
                              setPanelOpen(false);
                            }}
                            className={cx(
                              "ml-4 rounded-lg border px-3 py-2 text-[11px] font-medium transition-colors",
                              isDark
                                ? "border-white/10 bg-[var(--surface-card)] text-[var(--text-secondary)] hover:border-white/20 hover:bg-[var(--surface-card-muted)] hover:text-[var(--text-primary)]"
                                : "border-black/5 bg-white text-neutral-600 hover:border-black/10 hover:bg-neutral-50 hover:text-neutral-900"
                            )}
                          >
                            {subAction.label}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={cx(
      "theme-scope mt-6 w-full max-w-3xl rounded-xl border p-4 shadow-sm",
      isDark ? "border-white/10 bg-[var(--surface-card)] text-[var(--text-primary)]" : "border-black/5 bg-white"
    )}>
      <div className="mb-4 flex items-center gap-2">
        <Boxes className={cx("h-4 w-4", isDark ? "text-[var(--text-muted)]" : "text-neutral-500")} />
        <span className={cx("text-[13px] font-semibold", isDark ? "text-[var(--text-primary)]" : "text-neutral-900")}>派生功能</span>
        <span className={cx("text-[11px]", isDark ? "text-[var(--text-faint)]" : "text-neutral-400")}>在对话基础上的衍生操作</span>
      </div>

      <div className="grid gap-2">
        {derivedActions.map((action) => (
          <div key={action.id}>
            <button
              type="button"
              onClick={() => {
                if (action.subActions) {
                  setExpandedMenu(expandedMenu === action.id ? null : action.id);
                } else {
                  action.onClick?.();
                }
              }}
              className={cx(
                "flex w-full items-center justify-between rounded-lg border px-4 py-3 transition-colors",
                isDark
                  ? "border-white/10 bg-[linear-gradient(90deg,var(--surface-card-muted),var(--surface-card))] hover:border-white/20"
                  : "border-black/5 bg-gradient-to-r from-neutral-50 to-white hover:border-black/10 hover:from-white hover:to-neutral-50"
              )}
            >
              <div className="flex items-center gap-3">
                <action.icon className={cx("h-4 w-4", isDark ? "text-[var(--text-muted)]" : "text-neutral-500")} />
                <div className="text-left">
                  <div className={cx("text-[12px] font-semibold", isDark ? "text-[var(--text-primary)]" : "text-neutral-900")}>{action.label}</div>
                  <div className={cx("text-[11px]", isDark ? "text-[var(--text-muted)]" : "text-neutral-500")}>{action.description}</div>
                </div>
              </div>
              {action.subActions && (
                <ChevronDown
                  className={cx(
                    "h-4 w-4 transition-transform",
                    isDark ? "text-[var(--text-faint)]" : "text-neutral-400",
                    expandedMenu === action.id ? "rotate-180" : "",
                  )}
                />
              )}
            </button>

            {action.subActions && expandedMenu === action.id && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 grid gap-2 overflow-hidden"
              >
                {action.subActions.map((subAction, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      subAction.onClick?.();
                      setExpandedMenu(null);
                    }}
                    className={cx(
                      "ml-4 rounded-lg border px-3 py-2 text-[11px] font-medium transition-colors",
                      isDark
                        ? "border-white/10 bg-[var(--surface-card-muted)] text-[var(--text-secondary)] hover:border-white/20 hover:bg-[var(--surface-panel-strong)] hover:text-[var(--text-primary)]"
                        : "border-black/5 bg-neutral-50/50 text-neutral-600 hover:border-black/10 hover:bg-neutral-50 hover:text-neutral-900"
                    )}
                  >
                    {subAction.label}
                  </button>
                ))}
              </motion.div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Composer({
  prompt,
  setPrompt,
  preferences,
  files,
  catalogSkills,
  running,
  onRun,
  onAttachFiles,
  onAttachDroppedFiles,
  onSelectQuickPrompt,
  onShowToast,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  preferences: PublicPreferences;
  files: AttachedFile[];
  catalogSkills: SkillCatalogItem[];
  running: boolean;
  onRun: () => void;
  onAttachFiles: (kind: AttachmentKind) => void;
  onAttachDroppedFiles: (files: FileList) => void;
  onSelectQuickPrompt: (prompt: string) => void;
  onShowToast?: (message: string) => void;
}) {
  const [mode, setMode] = useState<ClawPermissionMode>(preferences.permissionMode);
  const [dragging, setDragging] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [dismissedSlashKey, setDismissedSlashKey] = useState("");
  const [slashCaretIndex, setSlashCaretIndex] = useState(0);
  const [slashMenuPosition, setSlashMenuPosition] = useState<SlashMenuPosition | null>(null);
  const composerSurfaceRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenu = useMemo(() => buildSlashMenuState(prompt, catalogSkills), [catalogSkills, prompt]);
  const showSlashMenu = slashMenu.visible && dismissedSlashKey !== slashMenu.dismissKey;
  const {
    supported: speechSupported,
    listening: speechListening,
    interimTranscript: speechInterimTranscript,
    provider: speechProvider,
    toggle: toggleSpeechInput,
    stop: stopSpeechInput,
  } = useSpeechDictation({
    value: prompt,
    onChange: setPrompt,
    onError: (message) => onShowToast?.(normalizeSpeechErrorMessage(message)),
  });
  const groupedSlashOptions = useMemo<SlashMenuGroup[]>(() => {
    const groups: Record<SlashMenuOption["kind"], SlashMenuGroup> = {
      command: { id: "command", label: "命令", items: [] },
      skill: { id: "skill", label: "技能", items: [] },
    };

    slashMenu.options.forEach((option, index) => {
      groups[option.kind].items.push({ option, index });
    });

    return [groups.command, groups.skill].filter((group) => group.items.length > 0);
  }, [slashMenu.options]);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashMenu.dismissKey, slashMenu.mode, slashMenu.query]);

  useEffect(() => {
    setMode(preferences.permissionMode);
  }, [preferences.permissionMode]);

  useEffect(() => {
    if (running && speechListening) {
      stopSpeechInput();
    }
  }, [running, speechListening, stopSpeechInput]);

  useEffect(() => {
    if (!speechListening || !textareaRef.current) return;
    const cursor = prompt.length;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(cursor, cursor);
  }, [prompt, speechListening]);

  useLayoutEffect(() => {
    if (!showSlashMenu) {
      setSlashMenuPosition(null);
      return;
    }

    const textarea = textareaRef.current;
    const composerSurface = composerSurfaceRef.current;
    const slashMenuNode = slashMenuRef.current;
    if (!textarea || !composerSurface || !slashMenuNode) return;

    const normalizedPrompt = prompt.replace(/\r\n?/g, "\n");
    const [firstLine = ""] = normalizedPrompt.split("\n");
    const fallbackIndex = firstLine.length;
    const anchorIndex = slashCaretIndex > 0 ? Math.min(slashCaretIndex, firstLine.length) : fallbackIndex;
    const caretPosition = getTextareaCaretPosition(textarea, anchorIndex);
    if (!caretPosition) return;

    const surfaceRect = composerSurface.getBoundingClientRect();
    const menuRect = slashMenuNode.getBoundingClientRect();
    const viewportPadding = 16;
    const horizontalPadding = 12;
    const left = Math.min(
      Math.max(horizontalPadding, caretPosition.left - 18),
      Math.max(horizontalPadding, surfaceRect.width - menuRect.width - horizontalPadding),
    );
    const anchorX = Math.min(
      Math.max(horizontalPadding + 12, caretPosition.left),
      surfaceRect.width - horizontalPadding - 12,
    );
    const belowTop = caretPosition.top + caretPosition.lineHeight + 10;
    const aboveTop = caretPosition.top - menuRect.height - 14;
    const fitsBelow = surfaceRect.top + belowTop + menuRect.height <= window.innerHeight - viewportPadding;
    const placement = fitsBelow ? "below" : "above";

    setSlashMenuPosition({
      left,
      top: placement === "below" ? belowTop : aboveTop,
      arrowLeft: Math.max(18, Math.min(menuRect.width - 18, anchorX - left)),
      placement,
    });
  }, [showSlashMenu, prompt, slashCaretIndex, slashMenu.options.length]);

  const syncSlashCaretIndex = (target: HTMLTextAreaElement | null) => {
    if (!target) return;
    setSlashCaretIndex(target.selectionStart ?? target.value.length);
  };

  const applySlashOption = (option: SlashMenuOption) => {
    const normalizedPrompt = prompt.replace(/\r\n?/g, "\n");
    const [, ...restLines] = normalizedPrompt.split("\n");
    const restBody = restLines.join("\n").trim();
    const nextPrompt = restBody ? `${option.insertValue.trimEnd()}\n${restBody}` : option.insertValue;
    const nextDismissKey = nextPrompt.split("\n")[0]?.trim() || option.insertValue.trim().split("\n")[0] || "";
    setPrompt(nextPrompt);
    setDismissedSlashKey(nextDismissKey);
    setSlashCaretIndex(nextPrompt.length);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const cursor = nextPrompt.length;
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-3 grid grid-cols-5 gap-2">
        {quickActions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => onSelectQuickPrompt(action.prompt)}
            className="flex h-9 items-center gap-2 rounded-lg border border-black/5 bg-white px-2.5 text-[12px] font-medium text-neutral-600 shadow-sm transition-colors hover:border-black/10 hover:bg-neutral-50 hover:text-neutral-900"
          >
            <action.icon className="h-3.5 w-3.5 text-neutral-500" />
            <span className="truncate">{action.label}</span>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
        <span className="text-[11px] font-medium text-neutral-400">Slash 命令</span>
        {visibleSlashCommands.map((command) => (
          <button
            key={command}
            type="button"
            onClick={() => onSelectQuickPrompt(command === "/skill" ? "/skill " : `${command} `)}
            className="rounded-full border border-black/5 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-500 transition-colors hover:border-black/10 hover:bg-neutral-50 hover:text-neutral-800"
          >
            {command}
          </button>
        ))}
        <span className="text-[11px] text-neutral-400">也支持直接输入 `/frontend-ui-engineering` 这类技能名。</span>
      </div>

      <div
        ref={composerSurfaceRef}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) onAttachDroppedFiles(event.dataTransfer.files);
        }}
        className={cx(
          "relative rounded-2xl border bg-white shadow-sm transition-colors focus-within:border-black/20",
          dragging ? "border-neutral-400 bg-neutral-50" : "border-black/10",
        )}
      >
        {showSlashMenu && (
          <div
            ref={slashMenuRef}
            className="absolute z-20"
            style={{
              left: `${slashMenuPosition?.left ?? 12}px`,
              top: `${slashMenuPosition?.top ?? 12}px`,
              width: "min(460px, calc(100% - 24px))",
              visibility: slashMenuPosition ? "visible" : "hidden",
            }}
          >
            <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-white/96 shadow-[0_18px_50px_rgba(15,23,42,0.14)] backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-black/5 bg-[linear-gradient(180deg,rgba(250,250,249,0.96),rgba(255,255,255,0.86))] px-3 py-2">
                <span className="text-[11px] font-medium text-neutral-500">
                  {slashMenu.mode === "skill" ? "技能匹配" : "Slash 命令 / 技能"}
                </span>
                <span className="text-[10px] text-neutral-400">↑↓ 选择 · Enter/Tab 插入 · Esc 关闭</span>
              </div>
              {slashMenu.options.length === 0 ? (
                <div className="px-3 py-3">
                  <div className="rounded-xl border border-dashed border-black/10 bg-neutral-50/70 px-3 py-3 text-[12px] text-neutral-400">
                    没有匹配项。你也可以继续输入后直接回车，运行前会做 /命令校验。
                  </div>
                </div>
              ) : (
                <div className="max-h-[320px] overflow-y-auto px-3 py-2">
                  <div className="grid gap-2">
                    {groupedSlashOptions.map((group) => (
                      <div key={group.id} className="grid gap-1">
                        <div className="px-1 text-[10px] font-medium tracking-[0.16em] text-neutral-400">{group.label}</div>
                        {group.items.map(({ option, index }) => (
                          <button
                            key={option.id}
                            type="button"
                            onMouseEnter={() => setSelectedSlashIndex(index)}
                            onFocus={() => setSelectedSlashIndex(index)}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              applySlashOption(option);
                            }}
                            className={cx(
                              "flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                              index === selectedSlashIndex
                                ? "border-neutral-900 bg-neutral-900 text-white shadow-[0_10px_24px_rgba(17,24,39,0.18)]"
                                : "border-black/5 bg-white/90 text-neutral-700 hover:border-black/10 hover:bg-neutral-50"
                            )}
                          >
                            <div className="min-w-0">
                              <div className={cx("text-[12px] font-semibold", index === selectedSlashIndex ? "text-white" : "text-neutral-900")}>
                                {option.label}
                              </div>
                              <div className={cx("mt-1 text-[11px] leading-5", index === selectedSlashIndex ? "text-white/75" : "text-neutral-500")}>
                                {option.description}
                              </div>
                            </div>
                            <div
                              className={cx(
                                "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium",
                                index === selectedSlashIndex ? "bg-white/10 text-white/85" : "bg-neutral-100 text-neutral-500"
                              )}
                            >
                              {option.meta}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div
                className={cx(
                  "pointer-events-none absolute h-3 w-3 rotate-45 bg-white/96",
                  slashMenuPosition?.placement === "below" ? "-top-1.5 border-l border-t border-black/10" : "-bottom-1.5 border-b border-r border-black/10",
                )}
                style={{ left: `${(slashMenuPosition?.arrowLeft ?? 24) - 6}px` }}
              />
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            syncSlashCaretIndex(event.target);
            if (dismissedSlashKey && dismissedSlashKey !== event.target.value.split("\n")[0]?.trim()) {
              setDismissedSlashKey("");
            }
          }}
          onClick={(event) => syncSlashCaretIndex(event.currentTarget)}
          onKeyDown={(event) => {
            if (showSlashMenu && slashMenu.options.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setSelectedSlashIndex((current) => (current + 1) % slashMenu.options.length);
              return;
            }
            if (showSlashMenu && slashMenu.options.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setSelectedSlashIndex((current) => (current - 1 + slashMenu.options.length) % slashMenu.options.length);
              return;
            }
            if (showSlashMenu && slashMenu.options.length > 0 && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              applySlashOption(slashMenu.options[selectedSlashIndex] || slashMenu.options[0]);
              return;
            }
            if (showSlashMenu && event.key === "Escape") {
              event.preventDefault();
              setDismissedSlashKey(slashMenu.dismissKey);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onRun();
            }
          }}
          onKeyUp={(event) => syncSlashCaretIndex(event.currentTarget)}
          onFocus={(event) => syncSlashCaretIndex(event.currentTarget)}
          onSelect={(event) => syncSlashCaretIndex(event.currentTarget)}
          placeholder="输入任务，或使用 /spec、/plan、/review、/skill frontend-ui-engineering"
          className="min-h-[92px] max-h-56 w-full resize-none border-0 bg-transparent px-4 pt-3 text-[14px] leading-6 text-neutral-800 outline-none placeholder:text-neutral-400"
        />
        <div className="flex items-center px-2 pb-2">
          <AttachmentMenuButton
            compact
            disabled={running}
            onSelect={onAttachFiles}
            buttonClassName="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          />

          <div className="ml-1 flex items-center gap-0.5 rounded-lg border border-black/5 bg-black/[0.03] p-0.5">
            {[
              { id: "read-only" as const, icon: Shield, label: "只读" },
              { id: "workspace-write" as const, icon: Zap, label: "工作区写入" },
              { id: "danger-full-access" as const, icon: AlertTriangle, label: "完全访问" },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => setMode(item.id)}
                className={cx(
                  "rounded-md p-1.5 transition-colors",
                  mode === item.id ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-400 hover:text-neutral-700",
                )}
              >
                <item.icon className="h-4 w-4" strokeWidth={1.75} />
              </button>
            ))}
          </div>

          <div className="ml-3 hidden max-w-[220px] items-center gap-1.5 truncate text-[12px] text-neutral-400 md:flex">
            <FileText className="h-3.5 w-3.5" />
            <span className="truncate">{files.length ? `${files.length} 个文件已附加` : "支持 .md / txt / 代码文件"}</span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className="ml-1 flex h-7 max-w-[210px] items-center gap-1 rounded-md px-2 text-[12px] text-neutral-700 transition-colors hover:bg-black/5"
              title={preferences.defaultModel}
            >
              <Sparkles className="h-3.5 w-3.5 text-neutral-500" />
              <span className="truncate">{preferences.defaultModel}</span>
              <ChevronDown className="h-3 w-3 text-neutral-400" />
            </button>
            <button
              type="button"
              onClick={toggleSpeechInput}
              disabled={running || !speechSupported}
              className={cx(
                "ml-1 rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                speechListening
                  ? "bg-red-50 text-red-600 hover:bg-red-100"
                  : "text-neutral-400 hover:bg-black/5 hover:text-neutral-600",
              )}
              title={
                !speechSupported
                  ? "当前环境不支持语音输入"
                  : speechListening
                    ? "停止语音输入"
                    : "开始语音输入"
              }
            >
              <Mic className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onRun}
              disabled={!prompt.trim() || running}
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-white transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
              title="运行"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div className="px-3 pb-3">
          <SpeechStreamingStatus listening={speechListening} interimTranscript={speechInterimTranscript} provider={speechProvider} />
        </div>
      </div>
    </div>
  );
}

function Dashboard({
  preferences,
  systemStatus,
  tasks,
  files,
  catalogSkills,
  prompt,
  setPrompt,
  onRunTask,
  onAttachFiles,
  onAttachDroppedFiles,
  onSelectFolder,
  onOpenTaskLog,
  onShowToast,
}: {
  preferences: PublicPreferences;
  systemStatus: SystemStatus | null;
  tasks: ClawTask[];
  files: AttachedFile[];
  catalogSkills: SkillCatalogItem[];
  prompt: string;
  setPrompt: (value: string) => void;
  onRunTask: () => void;
  onAttachFiles: () => void;
  onAttachDroppedFiles: (files: FileList) => void;
  onSelectFolder: () => void;
  onOpenTaskLog: () => void;
  onShowToast?: (message: string) => void;
}) {
  const running = tasks.some((task) => task.status === "running" || task.status === "pending");
  const latestTask = tasks[0] || null;
  const stats = useMemo(
    () => [
      { label: "任务总数", value: tasks.length.toString(), icon: Activity },
      { label: "运行中", value: tasks.filter((task) => task.status === "running" || task.status === "pending").length.toString(), icon: Loader2 },
      { label: "输入文件", value: files.length.toString(), icon: FileText },
    ],
    [files.length, tasks],
  );

  const handleExportConversation = async (format: "markdown" | "json" | "html") => {
    if (!latestTask) return;
    try {
      const result = await api.derived.exportConversation({
        taskId: latestTask.id,
        format,
      });
      alert(`导出成功: ${result.filePath}`);
    } catch (error) {
      alert(`导出失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleGenerateSummary = async () => {
    if (!latestTask) return;
    try {
      const result = await api.derived.generateSummary({
        taskId: latestTask.id,
      });
      alert(`摘要生成成功:\n\n${result.summary}`);
    } catch (error) {
      alert(`生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleCreateSnapshot = async () => {
    if (!latestTask) return;
    try {
      const snapshotName = window.prompt("请输入快照名称:", `snapshot-${new Date().toISOString().slice(0, 10)}`);
      if (!snapshotName) return;
      const result = await api.derived.createSnapshot({
        taskId: latestTask.id,
        snapshotName,
      });
      alert(`快照创建成功!\n\nID: ${result.snapshotId}\n路径: ${result.snapshotPath}`);
    } catch (error) {
      alert(`创建失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleShareContext = async (format: "clipboard" | "file") => {
    if (!latestTask) return;
    try {
      const result = await api.derived.shareContext({
        taskId: latestTask.id,
        format,
      });
      if (format === "clipboard" && result.content) {
        navigator.clipboard.writeText(result.content);
        alert("已复制到剪贴板!");
      } else if (format === "file" && result.filePath) {
        alert(`已保存到: ${result.filePath}`);
      }
    } catch (error) {
      alert(`操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleBranchTask = async () => {
    if (!latestTask) return;
    try {
      const branchName = window.prompt("请输入分支名称:", `branch-${new Date().toISOString().slice(0, 10)}`);
      if (!branchName) return;
      const result = await api.derived.branchTask({
        sourceTaskId: latestTask.id,
        branchName,
      });
      alert(`分支创建成功!\n\nID: ${result.newTaskId}\n路径: ${result.taskPath}`);
    } catch (error) {
      alert(`创建失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleCompareOutputs = async () => {
    if (tasks.length < 2) {
      alert("需要至少两个任务才能对比");
      return;
    }
    try {
      const result = await api.derived.compareOutputs({
        taskId1: latestTask!.id,
        taskId2: tasks[1].id,
      });
      alert(`对比结果:\n\n相似度: ${result.commonalityScore}%\n差异: ${result.differences.join(", ")}`);
    } catch (error) {
      alert(`对比失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleExtractInsights = async () => {
    if (!latestTask) return;
    try {
      const result = await api.derived.extractInsights({
        taskId: latestTask.id,
      });
      alert(`提取的洞察:\n\n${JSON.stringify(result.insights, null, 2)}`);
    } catch (error) {
      alert(`提取失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const handleGenerateDocumentation = async () => {
    if (!latestTask) return;
    try {
      const result = await api.derived.generateDocumentation({
        taskId: latestTask.id,
      });
      alert(`文档生成成功!\n\n${result.documentation.slice(0, 200)}...`);
    } catch (error) {
      alert(`生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto px-8 pb-8">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center py-6">
        <div className="mb-9 text-center">
          <h1 className="text-[32px] font-semibold tracking-tight text-neutral-900">我们该做什么?</h1>
        </div>
        <Composer
          prompt={prompt}
          setPrompt={setPrompt}
          preferences={preferences}
          files={files}
          catalogSkills={catalogSkills}
          running={false}
          onRun={onRunTask}
          onAttachFiles={onAttachFiles}
          onAttachDroppedFiles={onAttachDroppedFiles}
          onSelectQuickPrompt={setPrompt}
          onShowToast={onShowToast}
        />

        <div className="mt-8 grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-xl border border-black/5 bg-white px-4 py-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between text-neutral-400">
                <span className="text-[12px] font-medium">{stat.label}</span>
                <stat.icon className="h-4 w-4" />
              </div>
              <div className="text-[24px] font-semibold tracking-tight text-neutral-900">{stat.value}</div>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <section className="rounded-xl border border-black/5 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-[14px] font-semibold text-neutral-900">工作区</h2>
                <p className="mt-0.5 text-[12px] text-neutral-400">claw 将在此目录运行</p>
              </div>
              <IconButton label="选择工作区" onClick={onSelectFolder}>
                <FolderOpen className="h-4 w-4" />
              </IconButton>
            </div>
            <div className="rounded-lg border border-black/5 bg-[#fbfbfa] p-3">
              <div className="mb-3 flex items-center gap-2 text-neutral-700">
                <HardDrive className="h-4 w-4 text-neutral-500" />
                <span className="truncate text-[13px] font-medium">{preferences.workspacePath}</span>
              </div>
              <div className="flex items-center justify-between text-[12px] text-neutral-500">
                <span>{systemStatus?.platform || "local runtime"}</span>
                <span>{systemStatus?.clawPath || preferences.clawPath}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function FeaturePage({
  view,
  preferences,
  tasks,
  files,
  catalog,
  onUsePrompt,
  onRunPrompt,
  onOpenTaskLog,
  onOpenTask,
}: {
  view: FeatureViewKey;
  preferences: PublicPreferences;
  tasks: ClawTask[];
  files: AttachedFile[];
  catalog: LocalCatalog;
  onUsePrompt: (prompt: string) => void;
  onRunPrompt: (prompt: string) => Promise<void>;
  onOpenTaskLog: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const page = featurePages[view];
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [startingPrompt, setStartingPrompt] = useState<string | null>(null);
  const recentTasks = tasks.slice(0, 4);
  const runningCount = tasks.filter((task) => task.status === "running" || task.status === "pending").length;
  const localCatalog = useMemo(() => {
    if (view === "skills") {
      return {
        title: "本机技能库",
        count: catalog.skills.length,
        empty: "未在本机技能目录中发现 SKILL.md",
        items: catalog.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          meta: skill.source,
          description: skill.description,
          path: skill.path,
          prompt: `/skill ${skill.name}\n\n请在这里补充你的具体任务、约束和验收标准。`,
        })),
      };
    }
    if (view === "plugins") {
      return {
        title: "本机插件缓存",
        count: catalog.plugins.length,
        empty: "未在本机插件缓存中发现插件",
        items: catalog.plugins.slice(0, 8).map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          meta: `${plugin.provider} / ${plugin.skillCount} 个技能`,
          description: plugin.description,
          path: plugin.path,
          prompt: `分析插件 ${plugin.name} 对当前桌面应用的接入价值，并给出最小接入方案。\n\n插件路径: ${plugin.path}`,
        })),
      };
    }
    if (view === "automation") {
      return {
        title: "本机自动化",
        count: catalog.automations.length,
        empty: "未在 ~/.codex/automations 中发现自动化任务",
        items: catalog.automations.slice(0, 8).map((automation) => ({
          id: automation.id,
          name: automation.name,
          meta: `${automation.kind} / ${automation.status}`,
          description: automation.prompt || automation.schedule || "本地自动化任务",
          path: automation.path,
          prompt: `审阅自动化 ${automation.name}，检查它是否适合纳入 Claw Currentthink 的自动化入口。\n\n自动化路径: ${automation.path}`,
        })),
      };
    }
    return null;
  }, [catalog, view]);

  const queryPrompt = () => {
    const value = query.trim();
    return value ? `${page.promptPrefix}: ${value}` : page.actions[0].prompt;
  };

  const runPrompt = async (value: string) => {
    setStartingPrompt(value);
    try {
      await onRunPrompt(value);
    } finally {
      setStartingPrompt(null);
    }
  };

  const submitQuery = async () => {
    const value = query.trim();
    if (view === "search") {
      if (!value) return;
      setSearching(true);
      setSearchError("");
      try {
        setSearchResults(await api.workspace.search({ query: value, cwd: preferences.workspacePath }));
      } catch (error) {
        setSearchResults([]);
        setSearchError(error instanceof Error ? error.message : "搜索失败");
      } finally {
        setSearching(false);
      }
      return;
    }
    onUsePrompt(queryPrompt());
  };

  return (
    <div className="h-full overflow-y-auto px-8 pb-8 pt-3">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-black/5 bg-white text-neutral-600 shadow-sm">
              <page.icon className="h-5 w-5" strokeWidth={1.85} />
            </div>
            <h1 className="text-[22px] font-semibold tracking-tight text-neutral-900">{page.title}</h1>
            <p className="mt-1 text-[13px] text-neutral-500">{page.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onOpenTaskLog}
            className="flex h-8 items-center gap-1.5 rounded-md border border-black/5 bg-white px-3 text-[12px] font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50"
          >
            <Terminal className="h-3.5 w-3.5" />
            查看日志
          </button>
        </header>

        <section className="mb-4 rounded-xl border border-black/5 bg-white p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Search className="ml-1 h-4 w-4 shrink-0 text-neutral-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void submitQuery();
                }
              }}
              placeholder={page.inputPlaceholder}
              className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[13px] text-neutral-800 outline-none placeholder:text-neutral-400"
            />
            <button
              type="button"
              onClick={() => void submitQuery()}
              className="flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-neutral-800"
            >
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SendHorizontal className="h-3.5 w-3.5" />}
              {page.primaryLabel}
            </button>
            <button
              type="button"
              onClick={() => void runPrompt(queryPrompt())}
              disabled={Boolean(startingPrompt)}
              className="flex h-8 items-center gap-1.5 rounded-md border border-black/5 bg-white px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {startingPrompt === queryPrompt() ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Terminal className="h-3.5 w-3.5" />}
              运行任务
            </button>
          </div>
        </section>

        {view === "search" && (
          <section className="mb-4 rounded-xl border border-black/5 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-neutral-900">搜索结果</h2>
              <span className="text-[11px] text-neutral-400">{searchResults.length ? `${searchResults.length} 条命中` : "输入关键词后回车"}</span>
            </div>
            {searchError ? (
              <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[12px] text-red-700">{searchError}</div>
            ) : searchResults.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/10 px-3 py-8 text-center text-[12px] text-neutral-400">
                {searching ? "正在搜索..." : "暂无搜索结果"}
              </div>
            ) : (
              <div className="grid max-h-[280px] gap-2 overflow-y-auto pr-1">
                {searchResults.map((result) => (
                  <button
                    key={`${result.path}:${result.line}`}
                    type="button"
                    onClick={() => onUsePrompt(`阅读并解释 ${result.path}:${result.line}\n\n命中内容: ${result.preview}`)}
                    className="rounded-lg border border-black/5 bg-[#fbfbfa] px-3 py-2 text-left transition-colors hover:bg-white"
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                      <span className="truncate text-[12px] font-semibold text-neutral-900">{result.name}</span>
                      <span className="shrink-0 text-[11px] text-neutral-400">:{result.line}</span>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-neutral-400">{result.path}</div>
                    <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-neutral-600">{result.preview}</div>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {localCatalog && (
          <section className="mb-4 rounded-xl border border-black/5 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-neutral-900">{localCatalog.title}</h2>
              <span className="text-[11px] text-neutral-400">{localCatalog.count} 条本地记录</span>
            </div>
            {localCatalog.items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/10 px-3 py-8 text-center text-[12px] text-neutral-400">{localCatalog.empty}</div>
            ) : (
              <div className="grid max-h-[300px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                {localCatalog.items.map((item) => (
                  <div key={item.id} className="rounded-lg border border-black/5 bg-[#fbfbfa] p-3 transition-colors hover:bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold text-neutral-900">{item.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-neutral-400">{item.meta}</div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <IconButton label="写入主输入框" onClick={() => onUsePrompt(item.prompt)}>
                          <PenSquare className="h-4 w-4" />
                        </IconButton>
                        <IconButton label="直接运行任务" disabled={Boolean(startingPrompt)} onClick={() => void runPrompt(item.prompt)}>
                          {startingPrompt === item.prompt ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                        </IconButton>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-neutral-500">{item.description}</p>
                    <div className="mt-2 truncate text-[11px] text-neutral-400">{item.path}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
          <section className="rounded-xl border border-black/5 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-neutral-900">建议操作</h2>
              <span className="rounded-md bg-neutral-50 px-2 py-1 text-[11px] text-neutral-500">写入或直接运行</span>
            </div>
            <div className="grid gap-2">
              {page.actions.map((action) => (
                <div
                  key={action.title}
                  className="group flex items-center gap-3 rounded-lg border border-black/5 bg-[#fbfbfa] p-3 text-left transition-colors hover:border-black/10 hover:bg-white"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-neutral-500 shadow-sm">
                    <action.icon className="h-4 w-4" strokeWidth={1.85} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-neutral-900">{action.title}</span>
                    <span className="mt-0.5 block text-[12px] leading-5 text-neutral-500">{action.description}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton label="写入主输入框" onClick={() => onUsePrompt(action.prompt)}>
                      <PenSquare className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="直接运行任务" disabled={Boolean(startingPrompt)} onClick={() => void runPrompt(action.prompt)}>
                      {startingPrompt === action.prompt ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                    </IconButton>
                    <ChevronRight className="h-4 w-4 text-neutral-300 transition-colors group-hover:text-neutral-500" />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <aside className="space-y-4">
            <section className="rounded-xl border border-black/5 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-[14px] font-semibold text-neutral-900">当前上下文</h2>
              <div className="grid gap-2 text-[12px] text-neutral-500">
                <div className="flex items-center justify-between rounded-lg bg-[#fbfbfa] px-3 py-2">
                  <span>工作区</span>
                  <span className="max-w-[220px] truncate text-neutral-800">{preferences.workspacePath}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-[#fbfbfa] px-3 py-2">
                  <span>任务队列</span>
                  <span className="text-neutral-800">{runningCount} 个运行中 / {tasks.length} 个总计</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-[#fbfbfa] px-3 py-2">
                  <span>附加文件</span>
                  <span className="text-neutral-800">{files.length} 个</span>
                </div>
              </div>
            </section>

            <section className="rounded-xl border border-black/5 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-[14px] font-semibold text-neutral-900">最近任务</h2>
              {recentTasks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-black/10 px-3 py-8 text-center text-[12px] text-neutral-400">暂无任务</div>
              ) : (
                <div className="grid gap-2">
                  {recentTasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => onOpenTask(task.id)}
                      className="rounded-lg border border-black/5 bg-[#fbfbfa] px-3 py-2 text-left transition-colors hover:bg-white"
                    >
                      <div className="truncate text-[12px] font-medium text-neutral-800">{task.prompt}</div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-400">
                        <span>{formatTime(task.createdAt)}</span>
                        <span>{statusLabel(task.status)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function FilePanel({
  files,
  preferences,
  onAttachFiles,
  onAttachDroppedFiles,
  onRemoveFile,
  onSelectFolder,
}: {
  files: AttachedFile[];
  preferences: PublicPreferences;
  onAttachFiles: () => void;
  onAttachDroppedFiles: (files: FileList) => void;
  onRemoveFile: (fileId: string) => void;
  onSelectFolder: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className="h-full overflow-y-auto px-8 pb-8 pt-6"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length) onAttachDroppedFiles(event.dataTransfer.files);
      }}
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-neutral-900">文件输入</h1>
            <p className="mt-1 text-[12px] text-neutral-400">当前工作区: {preferences.workspacePath}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSelectFolder}
              className="flex h-8 items-center gap-1.5 rounded-md border border-black/5 bg-white px-3 text-[12px] font-medium text-neutral-700 shadow-sm transition-colors hover:bg-neutral-50"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              选择目录
            </button>
            <button
              type="button"
              onClick={onAttachFiles}
              className="flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-3 text-[12px] font-semibold text-white transition-colors hover:bg-neutral-800"
              title="添加文件（支持 .md）"
            >
              <FilePlus className="h-3.5 w-3.5" />
              添加文件
            </button>
          </div>
        </div>

        <div className={cx("rounded-xl border bg-white shadow-sm transition-colors", dragging ? "border-neutral-400 bg-neutral-50" : "border-black/5")}>
          <div className="grid grid-cols-[1fr_100px_132px_40px] border-b border-black/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            <span>名称</span>
            <span>大小</span>
            <span>修改时间</span>
            <span />
          </div>
          {files.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center text-neutral-400">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-neutral-50">
                <FileText className="h-6 w-6" />
              </div>
              <p className="text-[13px]">未选择文件</p>
              <p className="mt-1 text-[12px] text-neutral-400">可添加 Markdown、文本和常见代码文件</p>
            </div>
          ) : (
            files.map((file) => (
              <div key={file.id} className="grid grid-cols-[1fr_100px_132px_40px] items-center border-b border-black/5 px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-neutral-900">{file.name}</div>
                  <div className="mt-0.5 truncate text-[11px] text-neutral-400">{file.path}</div>
                </div>
                <span className="text-[12px] text-neutral-500">{formatBytes(file.size)}</span>
                <span className="text-[12px] text-neutral-500">{formatTime(file.modifiedAt)}</span>
                <IconButton label="移除文件" onClick={() => onRemoveFile(file.id)}>
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function parseTaskOutput(output: string, isRunning: boolean) {
  const repairUtf8MojibakeSegments = (value: string) =>
    String(value || "").replace(/(?:[\u00c2-\u00f4][\u0080-\u00bf]{1,3})+/g, (segment) => {
      try {
        const repaired = decodeURIComponent(
          Array.from(segment)
            .map((ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
            .join(""),
        );
        return repaired.includes("\uFFFD") ? segment : repaired;
      } catch {
        return segment;
      }
    });

  let reasoning = "";
  let content = repairUtf8MojibakeSegments(output || "")
    .replace(/^\s*[^\n]*Thinking\.\.\.[^\n]*\n?/gim, "")
    .replace(/^\s*[▶>]\s*Thinking \(\d+ chars hidden\)\s*\n?/gim, "")
    .replace(/^[^\n]*Thinking \(\d+ chars hidden\)[^\n]*\n?/gim, "")
    .replace(/^\s*7\s*8\s*\n+/gm, "")
    .replace(/^\s*78\s*\n+/gm, "")
    .trim();
  let isThinking = false;
  let hasThink = false;

  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length >= 2) {
    const normalize = (value: string) => value.replace(/[`*#>|-]/g, " ").replace(/\s+/g, " ").trim();
    const lead = (value: string) => normalize(value).split(/[：:]/)[0]?.trim() || "";
    const [first, second, third] = blocks;
    if (third && lead(first) && lead(first) === lead(second) && third.includes("- **")) {
      content = [second, third, ...blocks.slice(3)].join("\n\n");
    } else if (third && lead(first) && lead(first) === lead(third) && third.includes("- **")) {
      content = [third, ...blocks.slice(3)].join("\n\n");
    } else if (lead(first) && lead(first) === lead(second) && second.includes("- **")) {
      content = [second, ...blocks.slice(2)].join("\n\n");
    }
  }

  if (output && output.includes("<think>")) {
    hasThink = true;
    const startIdx = output.indexOf("<think>");
    const endIdx = output.lastIndexOf("</think>");
    if (endIdx !== -1) {
      reasoning = output.substring(startIdx + 7, endIdx).trim();
      content = output.substring(endIdx + 8).trim();
    } else {
      reasoning = output.substring(startIdx + 7).trim();
      content = "";
      isThinking = isRunning;
    }
  }

  return { reasoning, content, isThinking, hasThink };
}

function renderMessageContent(text: string) {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("```")) {
      const lines = part.split("\n");
      const firstLine = lines[0].replace("```", "").trim();
      const code = lines.slice(1, -1).join("\n");
      return (
        <div key={idx} className="my-3 overflow-hidden rounded-lg border border-black/10 bg-[#1e1e1e] text-neutral-100 font-mono shadow-md">
          <div className="flex items-center justify-between border-b border-white/5 bg-[#252526] px-4 py-1.5 text-[11px] text-neutral-400">
            <span>{firstLine || "code"}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(code)}
              className="flex items-center gap-1 hover:text-white transition-colors"
            >
              <Copy className="h-3 w-3" />
              <span>复制</span>
            </button>
          </div>
          <pre className="overflow-x-auto p-4 text-[12px] leading-relaxed whitespace-pre">{code}</pre>
        </div>
      );
    } else {
      return (
        <span key={idx} className="whitespace-pre-wrap">{part}</span>
      );
    }
  });
}

function TaskLog({
  tasks,
  selectedTaskId,
  preferences,
  onSelectTask,
  onSwitchWorkspace,
  onCancelTask,
  onClearTasks,
  onDeleteTask,
  onBranchTask,
  onRunFollowUp,
  onShowToast,
}: {
  tasks: ClawTask[];
  selectedTaskId: string | null;
  preferences: PublicPreferences;
  onSelectTask: (taskId: string) => void;
  onSwitchWorkspace: (workspacePath: string) => void;
  onCancelTask: (taskId: string) => void;
  onClearTasks: () => void;
  onDeleteTask: (taskId: string) => void;
  onBranchTask: (taskId: string) => void;
  onRunFollowUp: (
    value: string,
    conversationId: string | null,
    cwd: string,
    model: string,
    permissionMode: ClawPermissionMode,
    files: AttachedFile[]
  ) => void;
  onShowToast?: (message: string) => void;
}) {
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) || null : null;
  const isDark = preferences.theme === "dark";
  const dialogueScrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const debounceTimerRef = useRef<number | null>(null);
  const activeWorkspacePath = normalizeWorkspacePathValue(preferences.workspacePath);
  const selectedTaskWorkspacePath = normalizeWorkspacePathValue(selectedTask?.cwd || "");
  const selectedTaskInOtherWorkspace = Boolean(selectedTask?.cwd && selectedTaskWorkspacePath !== activeWorkspacePath);
  const selectedConversationId = selectedTask && !selectedTaskInOtherWorkspace ? selectedTask.conversationId || null : null;
  const selectedConversationLabel = selectedTaskInOtherWorkspace
    ? null
    : selectedTask?.conversationId
      ? "当前对话"
      : selectedTask
        ? "当前任务"
        : null;

  // States
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null);
  const [showContextPopover, setShowContextPopover] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpModel, setFollowUpModel] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [followUpPermissionMode, setFollowUpPermissionMode] = useState<ClawPermissionMode>("danger-full-access");
  const [followUpFiles, setFollowUpFiles] = useState<AttachedFile[]>([]);
  const [tokenCountVersion, setTokenCountVersion] = useState(0);
  const [liveDurationTick, setLiveDurationTick] = useState(0);
  const followUpTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    supported: followUpSpeechSupported,
    listening: followUpSpeechListening,
    interimTranscript: followUpSpeechInterimTranscript,
    provider: followUpSpeechProvider,
    toggle: toggleFollowUpSpeechInput,
    stop: stopFollowUpSpeechInput,
  } = useSpeechDictation({
    value: followUpPrompt,
    onChange: setFollowUpPrompt,
    onError: (message) => onShowToast?.(normalizeSpeechErrorMessage(message)),
  });

  // Update follow-up states based on selected task
  useEffect(() => {
    if (selectedTask) {
      setFollowUpModel(selectedTask.model || preferences.defaultModel || "deepseek-v4-pro");
      setFollowUpPermissionMode(selectedTask.permissionMode || preferences.permissionMode || "danger-full-access");
      // Auto open reasoning block for running/latest tasks
      setReasoningOpen(prev => ({
        ...prev,
        [selectedTask.id]: prev[selectedTask.id] !== undefined ? prev[selectedTask.id] : false
      }));
    }
  }, [selectedTaskId, selectedTask?.id]);

  // Group tasks in same conversation sorted chronologically
  const conversationTasks = useMemo(() => {
    if (!selectedTask) return [];
    const cid = selectedTask.conversationId;
    if (!cid) return [selectedTask];
    return tasks
      .filter((t) => {
        if (t.conversationId !== cid) return false;
        return normalizeWorkspacePathValue(t.cwd || "") === selectedTaskWorkspacePath;
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [selectedTask, selectedTaskWorkspacePath, tasks]);

  // Trigger re-render once the lazy-loaded BPE tokenizer finishes loading
  const [tokenizerReady, setTokenizerReady] = useState(false);
  useEffect(() => {
    waitForTokenizer().then(() => setTokenizerReady(true));
  }, []);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!tasks.some((task) => task.status === "running")) return;
    const timer = window.setInterval(() => {
      setLiveDurationTick((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  const conversationCharCount = useMemo(() => {
    return conversationTasks.reduce((total, task) => total + (task.prompt?.length || 0) + (task.output?.length || 0), 0);
  }, [conversationTasks, liveDurationTick]);

  const shouldDebounceTokenCount = conversationCharCount > largeConversationCharThreshold;
  const anyRunning = tasks.some(
    (t) =>
      ["running", "pending"].includes(t.status) &&
      (selectedConversationId
        ? t.conversationId === selectedConversationId &&
          normalizeWorkspacePathValue(t.cwd || "") === selectedTaskWorkspacePath
        : t.id === selectedTask?.id)
  );

  useEffect(() => {
    if (!shouldDebounceTokenCount) {
      setTokenCountVersion((value) => value + 1);
      return;
    }
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = window.setTimeout(() => {
      setTokenCountVersion((value) => value + 1);
      debounceTimerRef.current = null;
    }, largeConversationDebounceMs);
  }, [shouldDebounceTokenCount, conversationTasks.map((t) => `${t.id}:${t.prompt?.length || 0}:${t.output?.length || 0}`).join(",")]);

  useEffect(() => {
    if (anyRunning && followUpSpeechListening) {
      stopFollowUpSpeechInput();
    }
  }, [anyRunning, followUpSpeechListening, stopFollowUpSpeechInput]);

  useEffect(() => {
    if (!followUpSpeechListening || !followUpTextareaRef.current) return;
    const cursor = followUpPrompt.length;
    followUpTextareaRef.current.focus();
    followUpTextareaRef.current.setSelectionRange(cursor, cursor);
  }, [followUpPrompt, followUpSpeechListening]);

  // Real BPE token counting per conversation turn
  const turnTokens: TurnTokens[] = useMemo(() => {
    return countTurnTokens(
      conversationTasks.map((t) => ({ prompt: t.prompt, output: t.output }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationTasks.map((t) => `${t.prompt?.length || 0}:${t.output?.length || 0}`).join(","), tokenizerReady, tokenCountVersion]);

  const tokenDetails: TokenBreakdown = useMemo(() => {
    return computeTokenBreakdown(turnTokens, selectedTask?.model || "claude-opus-4-6", {
      enableDeepSeek1M: preferences.enableDeepSeek1M,
      modelProfiles: preferences.modelProfiles,
    });
  }, [turnTokens, selectedTask?.model, preferences.enableDeepSeek1M, preferences.modelProfiles]);

  // Aggregate and deduplicate all files across the current conversation
  const allConversationFiles = useMemo(() => {
    const fileMap = new Map<string, AttachedFile>();
    conversationTasks.forEach((t) => {
      t.files?.forEach((f) => {
        if (f.path) {
          fileMap.set(f.path, f);
        }
      });
    });
    return Array.from(fileMap.values());
  }, [conversationTasks]);

  useEffect(() => {
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    if (dialogueScrollRef.current) {
      dialogueScrollRef.current.scrollTop = dialogueScrollRef.current.scrollHeight;
    }
  }, [selectedTaskId]);

  // Scroll to bottom only when the viewer is already near the bottom.
  useEffect(() => {
    if (dialogueScrollRef.current && shouldAutoScrollRef.current) {
      dialogueScrollRef.current.scrollTop = dialogueScrollRef.current.scrollHeight;
    }
  }, [selectedTask?.output, selectedTask?.error, conversationTasks.length]);

  const handleDialogueScroll = () => {
    if (!dialogueScrollRef.current) return;
    const { scrollTop, clientHeight, scrollHeight } = dialogueScrollRef.current;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    shouldAutoScrollRef.current = distanceFromBottom <= 48;
    setShowScrollToBottom(distanceFromBottom > 160);
  };

  const scrollDialogueToBottom = () => {
    if (!dialogueScrollRef.current) return;
    shouldAutoScrollRef.current = true;
    setShowScrollToBottom(false);
    dialogueScrollRef.current.scrollTo({
      top: dialogueScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  };

  const handleSend = () => {
    const val = followUpPrompt.trim();
    if (!val || anyRunning || !selectedTask) return;
    onRunFollowUp(
      val,
      selectedTask.conversationId || null,
      selectedTask.cwd,
      followUpModel,
      followUpPermissionMode,
      followUpFiles
    );
    setFollowUpPrompt("");
    setFollowUpFiles([]);
  };

  const flushTokenCount = () => {
    if (!shouldDebounceTokenCount) return;
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setTokenCountVersion((value) => value + 1);
  };

  const handleAttachFiles = async (kind: AttachmentKind) => {
    const selected = await api.files.selectFiles(kind);
    if (selected && selected.length > 0) {
      setFollowUpFiles((prev) => {
        const existingPaths = new Set(prev.map(f => f.path));
        const newFiles = selected.filter(f => !existingPaths.has(f.path));
        return [...prev, ...newFiles];
      });
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedTaskId(id);
    setTimeout(() => {
      setCopiedTaskId(null);
    }, 2000);
  };

  const availableModels = useMemo(() => {
    const set = new Set([
      "deepseek-v4-pro",
      "claude-3-5-sonnet",
      "gpt-4o",
      ...providerPresetCards.flatMap((item) => item.models.map((model) => model.id)),
      stripOpenAiModelPrefixForUi(preferences.defaultModel),
    ]);
    if (selectedTask?.model) {
      set.add(stripOpenAiModelPrefixForUi(selectedTask.model));
    }
    return Array.from(set).filter(Boolean);
  }, [preferences.defaultModel, selectedTask?.model]);

  const latestConversationTask = conversationTasks[conversationTasks.length - 1] || selectedTask;

  const handleHeaderExportConversation = (format: "markdown" | "json" | "html") => {
    if (!latestConversationTask) return;
    void api.derived.exportConversation({
      taskId: latestConversationTask.id,
      format,
      includeContext: true,
    }).then((result) => {
      alert(`导出成功: ${result.filePath}`);
    }).catch((error) => {
      alert(`导出失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderGenerateSummary = () => {
    if (!latestConversationTask) return;
    void api.derived.generateSummary({
      taskId: latestConversationTask.id,
      conversationId: latestConversationTask.conversationId,
    }).then((result) => {
      alert(`摘要生成成功!\n\n${result.summary}\n\n关键点:\n${result.keyPoints.join("\n")}`);
    }).catch((error) => {
      alert(`生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderCreateSnapshot = () => {
    if (!latestConversationTask) return;
    const snapshotName = `snapshot-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;
    void api.derived.createSnapshot({
      taskId: latestConversationTask.id,
      snapshotName,
      includeFiles: true,
    }).then((result) => {
      alert(`快照创建成功: ${result.snapshotPath}`);
    }).catch((error) => {
      alert(`创建失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderShareContext = (format: "clipboard" | "file") => {
    if (!latestConversationTask) return;
    void api.derived.shareContext({
      taskId: latestConversationTask.id,
      format,
    }).then((result) => {
      if (format === "clipboard") {
        if (!result.content) {
          alert("没有可复制的上下文内容");
          return;
        }
        navigator.clipboard.writeText(result.content);
        alert("上下文已复制到剪贴板");
      } else {
        alert(result.filePath ? `上下文已保存: ${result.filePath}` : "上下文已导出");
      }
    }).catch((error) => {
      alert(`分享失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderBranchTask = () => {
    if (!latestConversationTask) return;
    void onBranchTask(latestConversationTask.id);
  };

  const handleHeaderCompareOutputs = () => {
    if (!latestConversationTask || conversationTasks.length < 2) {
      alert("需要至少两个任务才能对比输出");
      return;
    }
    const firstTask = conversationTasks[0];
    void api.derived.compareOutputs({
      taskId1: firstTask.id,
      taskId2: latestConversationTask.id,
    }).then((result) => {
      alert(`对比结果:\n\n相似度: ${result.commonalityScore}%\n\n相同点:\n${result.similarities.join("\n")}\n\n差异点:\n${result.differences.join("\n")}`);
    }).catch((error) => {
      alert(`对比失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderExtractInsights = () => {
    if (!latestConversationTask) return;
    void api.derived.extractInsights({
      taskId: latestConversationTask.id,
    }).then((result) => {
      const insights = Array.isArray(result.insights.key_findings)
        ? result.insights.key_findings.join("\n")
        : String(result.insights);
      alert(`洞察提取成功!\n\n关键发现:\n${insights}`);
    }).catch((error) => {
      alert(`提取失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  const handleHeaderGenerateDocumentation = () => {
    if (!latestConversationTask) return;
    void api.derived.generateDocumentation({
      taskId: latestConversationTask.id,
    }).then((result) => {
      alert(`文档生成成功!\n\n${result.documentation.slice(0, 200)}...`);
    }).catch((error) => {
      alert(`生成失败: ${error instanceof Error ? error.message : "未知错误"}`);
    });
  };

  return (
    <div className="theme-scope flex h-full min-h-0 flex-col overflow-hidden">
      {/* Main Pane */}
      <div className="theme-main flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Right Pane Header */}
        <div className="relative flex h-12 shrink-0 items-center justify-between border-b border-black/5 px-4">
          <div className="min-w-0 pr-4">
            <div className="truncate text-[13px] font-semibold theme-text-primary">{selectedTask?.prompt || "选择任务查看输出"}</div>
            <div className="flex items-center gap-2 text-[11px] theme-text-faint">
              <div className="min-w-0 truncate">{selectedTask?.cwd || "-"}</div>
              {selectedConversationLabel && (
                <div className="shrink-0 rounded-full border border-blue-200 bg-blue-50/80 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                  {selectedConversationLabel}
                </div>
              )}
              {selectedTask?.startedAt && (
                <div className="shrink-0">{selectedTask.status === "running" ? `处理中 ${taskDuration(selectedTask)}` : `耗时 ${taskDuration(selectedTask)}`}</div>
              )}
              {selectedTaskInOtherWorkspace && selectedTask?.cwd && (
                <button
                  type="button"
                  onClick={() => onSwitchWorkspace(selectedTask.cwd)}
                  className="shrink-0 rounded-full border border-black/10 bg-neutral-50 px-2 py-0.5 text-[10px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                  title="显式切换到这条任务所在的工作区"
                >
                  切换到此工作区
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {latestConversationTask && (
              <DerivedFeatures
                compact
                taskId={latestConversationTask.id}
                isRunning={anyRunning}
                theme={preferences.theme}
                onExport={handleHeaderExportConversation}
                onGenerateSummary={handleHeaderGenerateSummary}
                onCreateSnapshot={handleHeaderCreateSnapshot}
                onShareContext={handleHeaderShareContext}
                onBranchTask={handleHeaderBranchTask}
                onCompareOutputs={handleHeaderCompareOutputs}
                onExtractInsights={handleHeaderExtractInsights}
                onGenerateDocumentation={handleHeaderGenerateDocumentation}
              />
            )}
            {selectedTask && <StatusPill task={selectedTask} />}
            {selectedTask && (
              <>
                <button
                  type="button"
                  onClick={() => setShowContextPopover(!showContextPopover)}
                  className={cx(
                    "flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors",
                    showContextPopover
                      ? "theme-button-surface bg-[var(--surface-panel-strong)] text-[var(--text-primary)] border-[color:var(--border-strong)] shadow-sm"
                      : "theme-button-surface"
                  )}
                  title="查看当前对话的上下文（Token 与文件）"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>上下文</span>
                </button>

                {showContextPopover && (
                  <>
                    <div
                      className="fixed inset-0 z-40 bg-transparent"
                      onClick={() => setShowContextPopover(false)}
                    />
                    <div className="theme-card theme-shadow-card absolute right-4 top-12 z-50 w-80 space-y-4 rounded-2xl border border-black/5 p-4 text-left animate-fade-in">
                      {/* Popover Header */}
                      <div className="theme-text-faint flex items-center justify-between text-[11px] font-medium uppercase tracking-wider select-none">
                        <span>上下文 · TOKENS</span>
                        <span className="theme-text-secondary font-mono normal-case">{tokenDetails.totalTokens.toLocaleString()} / {tokenDetails.contextLimit.toLocaleString()}</span>
                      </div>

                      {shouldDebounceTokenCount && (
                        <div className="rounded-xl border border-amber-100 bg-amber-50/80 px-3 py-2 text-[11px] leading-5 text-amber-800">
                          超大对话已启用延迟精算，避免实时分词造成输入卡顿。输入框失焦或短暂停顿后会自动刷新。
                        </div>
                      )}

                      {/* Progress Bar */}
                      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-card-muted)] flex">
                        <div
                          style={{ width: `${Math.min((tokenDetails.inputTokens / tokenDetails.contextLimit) * 100, 100)}%` }}
                          className="h-full bg-[#1a73e8] rounded-l-full transition-all duration-300"
                        />
                        <div
                          style={{ width: `${Math.min((tokenDetails.outputTokens / tokenDetails.contextLimit) * 100, 100)}%` }}
                          className="h-full bg-[#6b4ce6] transition-all duration-300"
                        />
                        <div
                          style={{ width: `${Math.min((tokenDetails.cacheTokens / tokenDetails.contextLimit) * 100, 50)}%` }}
                          className="h-full bg-[#b06000] rounded-r-full transition-all duration-300 opacity-40"
                        />
                      </div>

                      {/* Legend */}
                      <div className="theme-text-secondary flex flex-wrap items-center gap-3 text-[11px]">
                        <div className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#1a73e8] shrink-0" />
                          <span>输入</span>
                          <span className="font-semibold theme-text-primary">{tokenDetails.inputTokens.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#6b4ce6] shrink-0" />
                          <span>输出</span>
                          <span className="font-semibold theme-text-primary">{tokenDetails.outputTokens.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="h-2.5 w-2.5 rounded-[3px] bg-[#b06000] shrink-0 opacity-60" />
                          <span>缓存</span>
                          <span className="font-semibold theme-text-primary">{tokenDetails.cacheTokens.toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Remaining Tokens */}
                      <div className="flex items-center justify-between text-[12px] pt-1">
                        <div className="theme-text-muted font-semibold">
                          <span>余 </span>
                          <span className="theme-text-primary font-bold">{tokenDetails.remaining.toLocaleString()}</span>
                        </div>
                        <span className="theme-text-faint text-[10px] font-mono">{selectedTask?.model || "—"}</span>
                      </div>

                      <div className="theme-note theme-border-soft rounded-xl border px-3 py-3">
                        <div className="flex items-center justify-between gap-3 text-[12px]">
                          <span className="theme-text-secondary font-semibold">预估费用</span>
                          <span
                            className={cx(
                              "font-mono",
                              tokenDetails.costWarningLevel === "high" && "text-red-600",
                              tokenDetails.costWarningLevel === "elevated" && "text-amber-700",
                              (tokenDetails.costWarningLevel === "normal" || tokenDetails.costWarningLevel === null) && "text-neutral-700"
                            )}
                          >
                            {tokenDetails.estimatedCostUsd === null ? "未配置" : formatUsd(tokenDetails.estimatedCostUsd)}
                          </span>
                        </div>
                        <div className="theme-text-muted mt-1 text-[11px] leading-5">
                          {tokenDetails.estimatedCostUsd === null
                            ? "为当前模型补充每百万 tokens 的价格后，这里会显示对话吞吐的简单估算。"
                            : tokenDetails.costWarningLevel === "high"
                              ? "当前对话吞吐预估费用较高，发送前建议再次确认模型与上下文规模。"
                              : tokenDetails.costWarningLevel === "elevated"
                                ? "当前对话已进入较高成本区间，建议留意上下文长度与模型资费。"
                                : "估算基于当前模型配置，适合用来做发送前的成本预判。"}
                        </div>
                      </div>

                      {/* Collapsible Files List */}
                      <div className="theme-border-soft space-y-2 border-t pt-3">
                        <button
                          type="button"
                          onClick={() => setFilesExpanded(!filesExpanded)}
                          className="theme-button-ghost flex w-full items-center justify-between text-[11px] font-semibold transition-colors"
                        >
                          <span>上下文中的文件</span>
                          <span className="text-[14px] font-mono leading-none">{filesExpanded ? "−" : "+"}</span>
                        </button>

                        {filesExpanded && (
                          <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
                            {allConversationFiles.length === 0 ? (
                              <div className="theme-text-faint space-y-1 py-6 text-center select-none">
                                <div className="text-[11px] font-medium">上下文里还没有文件。</div>
                                <div className="text-[10px] opacity-75">当 AI 读取或编辑文件后，文件将显示在此处。</div>
                              </div>
                            ) : (
                              allConversationFiles.map((file) => (
                                <button
                                  key={file.path}
                                  type="button"
                                  onClick={() => {
                                    api.system.revealPath(file.path);
                                    setShowContextPopover(false);
                                  }}
                                  className="theme-button-surface group flex w-full items-center justify-between rounded-lg border p-2 text-left text-[11px] transition-all shadow-sm"
                                  title={`点击在 Finder 中定位: ${file.path}`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <FileText className="theme-text-faint h-3.5 w-3.5 shrink-0" />
                                    <div className="min-w-0">
                                      <div className="theme-text-secondary truncate font-semibold">{file.name}</div>
                                      <div className="theme-text-faint truncate font-mono text-[9px]">{file.path}</div>
                                    </div>
                                  </div>
                                  <Folder className="theme-text-faint h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
            <IconButton
              label="取消任务"
              disabled={!selectedTask || !["running", "pending"].includes(selectedTask.status)}
              onClick={() => selectedTask && onCancelTask(selectedTask.id)}
            >
              <Square className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {/* Content Body */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={dialogueScrollRef}
            onScroll={handleDialogueScroll}
            className="theme-main h-full space-y-6 overflow-y-auto px-6 py-6"
          >
            {!selectedTask ? (
              <div className="flex h-full items-center justify-center text-[13px] theme-text-faint">选择任务查看输出</div>
            ) : (
              conversationTasks.map((task) => {
              const isTaskRunning = task.status === "running";
              const isTaskPending = task.status === "pending";
              const durationLabel = taskDuration(task);
              
              // Parse outputs
              const { reasoning, content, isThinking, hasThink } = parseTaskOutput(task.output, isTaskRunning);
              const hasErrorOnly = task.status === "failed" && task.error && !task.output;

              return (
                <div key={task.id} className="space-y-4 border-b border-black/5 pb-6 last:border-0 last:pb-0">
                  {/* User Prompt Turn */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="theme-text-primary whitespace-pre-wrap text-[15px] font-medium">
                        {task.prompt}
                      </div>
                      {task.files && task.files.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {task.files.map((file) => (
                            <button
                              key={file.id}
                              type="button"
                              onClick={() => api.system.revealPath(file.path)}
                              className="theme-button-surface flex items-center gap-1 rounded border px-2 py-0.5 text-left text-[11px] transition-colors shadow-sm animate-fade-in"
                              title={`点击在 Finder 中定位: ${file.path}`}
                            >
                              <FileText className="theme-text-faint h-3 w-3 shrink-0" />
                              <span className="truncate max-w-[150px]">{file.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleCopy(task.prompt, `${task.id}-prompt`)}
                      className="theme-button-ghost flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] transition-colors"
                    >
                      {copiedTaskId === `${task.id}-prompt` ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-green-500" />
                          <span className="text-green-500">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          <span>复制</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Assistant Message Turn */}
                  <div className="space-y-3 border-l-2 border-[color:var(--border-soft)] pl-4">
                    {task.startedAt && (
                      <div className="flex items-center gap-2 text-[11px] theme-text-faint">
                        <Clock className="h-3.5 w-3.5" />
                        <span>{task.status === "running" ? `处理中 ${durationLabel}` : `处理耗时 ${durationLabel}`}</span>
                      </div>
                    )}

                    {/* Collapsible Reasoning Process Block */}
                    {hasThink && (
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={() => setReasoningOpen(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                          className="theme-button-surface flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] transition-colors shadow-sm"
                        >
                          <Brain className="h-3.5 w-3.5 text-blue-500" />
                          <span>reasoning 思考</span>
                          <span className={cx(
                            "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                            isThinking ? "bg-amber-100 text-amber-700 animate-pulse" : "bg-neutral-200 text-neutral-600"
                          )}>
                            {isThinking ? "进行中" : "完成"}
                          </span>
                          <span className="theme-text-faint text-[10px] font-medium">
                            {isThinking ? `已思考 ${durationLabel}` : `思考 ${durationLabel}`}
                          </span>
                          {(reasoningOpen[task.id] || isThinking) ? (
                            <ChevronDown className="h-3 w-3 opacity-60" />
                          ) : (
                            <ChevronRight className="h-3 w-3 opacity-60" />
                          )}
                        </button>

                        {(reasoningOpen[task.id] || isThinking) && (
                          <div className="theme-note theme-border-soft max-h-60 overflow-y-auto rounded-lg border p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap">
                            {reasoning}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Content Output */}
                    {isTaskPending && !task.output && !task.error ? (
                      <div className="flex items-center gap-2 text-[13px] text-neutral-400 py-2">
                        <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
                        <span>准备执行任务中...</span>
                      </div>
                    ) : isTaskRunning && !content && !reasoning ? (
                      <div className="flex items-center gap-2 text-[13px] text-neutral-400 py-2">
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                        <span>思考中...</span>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {content && (
                          <div className="theme-text-secondary text-[14px] leading-6">
                            {renderMessageContent(content)}
                            {isTaskRunning && (
                              <span className="ml-1 inline-block h-4 w-[2px] animate-pulse rounded-full bg-neutral-400 align-middle" />
                            )}
                          </div>
                        )}

                        {hasErrorOnly && (
                          <div className="rounded-lg border border-red-100 bg-red-50/50 p-3 text-[12px] text-red-600 font-mono">
                            {task.error || "任务执行失败"}
                          </div>
                        )}

                        {/* Reply Actions */}
                        {(content || task.error) && (
                          <div className="pt-1 flex items-center justify-between">
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleCopy(content || task.error, `${task.id}-output`)}
                                className="theme-button-ghost flex h-7 items-center gap-1 rounded px-2 text-[11px] transition-colors"
                              >
                                {copiedTaskId === `${task.id}-output` ? (
                                  <>
                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                    <span className="text-green-500">已复制</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3.5 w-3.5" />
                                    <span>复制</span>
                                  </>
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => onBranchTask(task.id)}
                                className="theme-button-ghost flex h-7 items-center gap-1 rounded px-2 text-[11px] transition-colors"
                              >
                                <GitBranch className="h-3.5 w-3.5" />
                                <span>分叉</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
              })
            )}
          </div>

          <AnimatePresence>
            {showScrollToBottom && selectedTask && (
              <motion.button
                initial={{ opacity: 0, y: 12, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.96 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                type="button"
                onClick={scrollDialogueToBottom}
                className="theme-card theme-shadow-card absolute bottom-5 right-5 z-20 flex items-center gap-2 rounded-full border border-black/10 px-3 py-2 text-[12px] font-medium theme-text-primary backdrop-blur-sm transition-colors hover:bg-[var(--surface-hover-strong)]"
                title="滚动到底部"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                <span>到底部</span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Composer */}
        {selectedTask && (
          <div className="theme-panel-strong shrink-0 border-t border-black/5 p-4">
            <div className="theme-card rounded-2xl border border-black/10 p-2 shadow-sm transition-all focus-within:border-black/20 focus-within:ring-1 focus-within:ring-black/5">
              <textarea
                ref={followUpTextareaRef}
                rows={2}
                value={followUpPrompt}
                onChange={(e) => setFollowUpPrompt(e.target.value)}
                onBlur={flushTokenCount}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={anyRunning}
                placeholder={anyRunning ? "有任务正在运行中，请稍候..." : "我们该做什么？"}
                className="theme-text-primary w-full resize-none bg-transparent px-3 py-1.5 text-[13px] placeholder:text-[var(--text-faint)] outline-none disabled:opacity-50"
              />

              <div className="mt-2 flex items-center justify-between px-1">
                {/* Left Side tools */}
                <div className="flex items-center gap-2">
                  <AttachmentMenuButton
                    compact
                    disabled={anyRunning}
                    onSelect={handleAttachFiles}
                    buttonClassName="theme-button-ghost flex h-7 w-7 items-center justify-center rounded-lg transition-all active:scale-95 disabled:opacity-50"
                  />

                  {/* Attached files indicators */}
                  <div className="flex flex-wrap gap-1">
                    {followUpFiles.map((file) => (
                      <div key={file.id} className="theme-chip flex items-center gap-1 rounded px-2 py-0.5 text-[11px]">
                        <span className="max-w-[80px] truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => setFollowUpFiles((prev) => prev.filter((f) => f.id !== file.id))}
                          className="theme-text-faint transition-colors hover:text-red-500"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right Side actions */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleFollowUpSpeechInput}
                    disabled={anyRunning || !followUpSpeechSupported}
                    className={cx(
                      "flex h-7 w-7 items-center justify-center rounded-lg transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40",
                      followUpSpeechListening
                        ? "bg-red-50 text-red-600 hover:bg-red-100"
                        : "theme-button-ghost",
                    )}
                    title={
                      !followUpSpeechSupported
                        ? "当前环境不支持语音输入"
                        : followUpSpeechListening
                          ? "停止语音输入"
                          : "开始语音输入"
                    }
                  >
                    <Mic className="h-3.5 w-3.5" />
                  </button>

                  {/* Permission Mode pill button */}
                  <button
                    type="button"
                    onClick={() => {
                      const modes: ClawPermissionMode[] = ["read-only", "workspace-write", "danger-full-access"];
                      const nextIdx = (modes.indexOf(followUpPermissionMode) + 1) % modes.length;
                      setFollowUpPermissionMode(modes[nextIdx]);
                    }}
                    className={cx(
                      "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] font-medium border border-black/5 transition-all active:scale-95",
                      followUpPermissionMode === "read-only" && "bg-blue-50/50 text-blue-600 border-blue-100/50 hover:bg-blue-100/50",
                      followUpPermissionMode === "workspace-write" && "bg-green-50/50 text-green-600 border-green-100/50 hover:bg-green-100/50",
                      followUpPermissionMode === "danger-full-access" && "bg-red-50/50 text-red-600 border-red-100/50 hover:bg-red-100/50"
                    )}
                    title={`当前权限模式 (点击切换)`}
                  >
                    <Shield className="h-3.5 w-3.5" />
                    <span>
                      {followUpPermissionMode === "read-only"
                        ? "只读模式"
                        : followUpPermissionMode === "workspace-write"
                        ? "修改工作区"
                        : "全部权限"}
                    </span>
                  </button>

                  {/* Model Selector Dropdown */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowModelDropdown(!showModelDropdown)}
                      className="theme-button-surface flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium transition-colors shadow-sm"
                    >
                      <div className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      <span className="max-w-[100px] truncate">{followUpModel}</span>
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>

                    {showModelDropdown && (
                      <div className="theme-menu absolute bottom-full right-0 z-50 mb-1 max-h-60 w-72 overflow-y-auto rounded-xl border p-1 ring-1 ring-black/5">
                        {availableModels.map((model) => (
                          <button
                            key={model}
                            type="button"
                            onClick={() => {
                              setFollowUpModel(model);
                              setShowModelDropdown(false);
                            }}
                            className={cx(
                              "w-full rounded-lg px-3 py-1.5 text-left text-[11px] transition-colors",
                              followUpModel === model
                                ? "bg-[var(--surface-hover)] font-semibold text-[var(--text-primary)]"
                                : "theme-button-ghost"
                            )}
                            title={model}
                          >
                            <div className="min-w-0">
                              <div className="truncate">
                                {findPresetModelMeta(model)?.label || model}
                              </div>
                              {findPresetModelMeta(model)?.providerLabel && (
                                <div className="theme-text-faint mt-0.5 truncate text-[10px] font-normal">
                                  {findPresetModelMeta(model)?.providerLabel}
                                </div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Send circular button */}
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!followUpPrompt.trim() || anyRunning}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800 transition-all active:scale-95 disabled:bg-neutral-100 disabled:text-neutral-300 disabled:scale-100 disabled:cursor-not-allowed"
                  >
                    {anyRunning ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <SendHorizontal className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
              <div className="px-3 pt-2">
                <SpeechStreamingStatus
                  listening={followUpSpeechListening}
                  interimTranscript={followUpSpeechInterimTranscript}
                  provider={followUpSpeechProvider}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ArchivedConversationCard({
  conversation,
  onOpen,
  onRestore,
  restoring = false,
  showMeta = false,
  titleLines = 1,
}: {
  conversation: ArchivedConversation;
  onOpen?: () => void;
  onRestore?: () => void;
  restoring?: boolean;
  showMeta?: boolean;
  titleLines?: 1 | 2;
}) {
  const content = (
    <>
      <div
        className={cx(
          "font-semibold text-neutral-800",
          titleLines === 1 ? "line-clamp-1 text-[11px]" : "line-clamp-2 text-[12px] leading-5",
        )}
      >
        {conversation.title}
      </div>
      <div className={cx("mt-1 truncate text-neutral-400", titleLines === 1 ? "text-[10px]" : "text-[11px]")}>
        {conversation.cwd}
      </div>
      {showMeta && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="rounded-md bg-neutral-100 px-2 py-0.5">{conversation.taskCount} 条任务</span>
          <span className="rounded-md bg-neutral-100 px-2 py-0.5">{conversation.model || "未知模型"}</span>
          <span className="rounded-md bg-neutral-100 px-2 py-0.5">{formatTime(conversation.archivedAt)}</span>
        </div>
      )}
    </>
  );

  return (
    <div className="theme-scope theme-card rounded-xl border border-black/5 p-3 text-left shadow-sm transition-colors hover:bg-neutral-50">
      <div className="flex items-start justify-between gap-3">
        {onOpen ? (
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
            {content}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{content}</div>
        )}
        {onRestore && (
          <button
            type="button"
            onClick={onRestore}
            disabled={restoring}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/5 bg-white px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            恢复
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsModal({
  open,
  preferences,
  systemStatus,
  archivedConversations,
  restoringConversationId,
  onClose,
  onSave,
  onChooseFolder,
  onRestoreConversation,
}: {
  open: boolean;
  preferences: PublicPreferences;
  systemStatus: SystemStatus | null;
  archivedConversations: ArchivedConversation[];
  restoringConversationId: string | null;
  onClose: () => void;
  onSave: (patch: PreferencesPatch) => Promise<void>;
  onChooseFolder: () => Promise<string | null>;
  onRestoreConversation: (conversationId: string) => void;
}) {
  const [activeTab, setActiveTab] = useState("通用");
  const [presetCategory, setPresetCategory] = useState("全部");
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>("nvidia-nim");
  const [draft, setDraft] = useState({
    clawPath: preferences.clawPath,
    defaultModel: stripOpenAiModelPrefixForUi(preferences.defaultModel),
    openaiBaseUrl: preferences.openaiBaseUrl,
    openaiCompatEnabled: preferences.openaiCompatEnabled ?? false,
    permissionMode: preferences.permissionMode,
    workspacePath: preferences.workspacePath,
    theme: preferences.theme,
    fontSize: preferences.fontSize,
    autoSaveLogs: preferences.autoSaveLogs,
    enableDeepSeek1M: preferences.enableDeepSeek1M,
    saveSingleTurnInOnePlace: preferences.saveSingleTurnInOnePlace ?? true,
    modelProfiles: normalizeModelProfilesForUi(preferences.modelProfiles),
    anthropicApiKey: "",
    anthropicAuthToken: "",
    openaiApiKey: "",
  });
  const [secretTouched, setSecretTouched] = useState<Record<SecretDraftKey, boolean>>({
    anthropicApiKey: false,
    anthropicAuthToken: false,
    openaiApiKey: false,
  });

  useEffect(() => {
    setDraft((value) => ({
      ...value,
      clawPath: preferences.clawPath,
      defaultModel: stripOpenAiModelPrefixForUi(preferences.defaultModel),
      openaiBaseUrl: preferences.openaiBaseUrl,
      openaiCompatEnabled: preferences.openaiCompatEnabled ?? false,
      permissionMode: preferences.permissionMode,
      workspacePath: preferences.workspacePath,
      theme: preferences.theme,
      fontSize: preferences.fontSize,
      autoSaveLogs: preferences.autoSaveLogs,
      enableDeepSeek1M: preferences.enableDeepSeek1M,
      saveSingleTurnInOnePlace: preferences.saveSingleTurnInOnePlace ?? true,
      modelProfiles: normalizeModelProfilesForUi(preferences.modelProfiles),
      anthropicApiKey: "",
      anthropicAuthToken: "",
      openaiApiKey: "",
    }));
    setSecretTouched({
      anthropicApiKey: false,
      anthropicAuthToken: false,
      openaiApiKey: false,
    });
  }, [preferences]);

  useEffect(() => {
    if (!open) return;
    setActiveTab("数据");
    setPresetCategory("全部");
    const activeProvider =
      providerPresetCards.find((provider) => provider.baseUrl === preferences.openaiBaseUrl)?.providerId || "nvidia-nim";
    setExpandedProviderId(activeProvider);
  }, [open, preferences.openaiBaseUrl]);

  const tabs = [
    { icon: Monitor, label: "通用" },
    { icon: Cpu, label: "模型" },
    { icon: SlidersHorizontal, label: "预设" },
    { icon: Key, label: "API" },
    { icon: Database, label: "数据" },
    { icon: Puzzle, label: "MCP 服务器" },
    { icon: Archive, label: "已归档对话" },
  ];

  const updateModelProfile = (index: number, patch: Partial<ModelProfile>) => {
    setDraft((current) => ({
      ...current,
      modelProfiles: current.modelProfiles.map((profile, idx) => (idx === index ? { ...profile, ...patch } : profile)),
    }));
  };

  const addModelProfile = () => {
    setDraft((current) => ({
      ...current,
      modelProfiles: [
        ...current.modelProfiles,
        { modelId: "", contextLimit: undefined, inputPricePerMillion: undefined, outputPricePerMillion: undefined, cachePricePerMillion: undefined },
      ],
    }));
  };

  const removeModelProfile = (index: number) => {
    setDraft((current) => ({
      ...current,
      modelProfiles: current.modelProfiles.filter((_, idx) => idx !== index),
    }));
  };

  const updateSecretField = (key: SecretDraftKey, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSecretTouched((current) => ({ ...current, [key]: true }));
  };

  const markSecretForDeletion = async (key: SecretDraftKey) => {
    let keyLabel = "API Key";
    if (key === "anthropicApiKey") keyLabel = "ANTHROPIC_API_KEY";
    if (key === "anthropicAuthToken") keyLabel = "ANTHROPIC_AUTH_TOKEN";

    const confirmed = window.confirm(`确定要从配置中删除 ${keyLabel} 吗？删除后将立即生效。`);
    if (confirmed) {
      setDraft((current) => ({ ...current, [key]: "" }));
      setSecretTouched((current) => ({ ...current, [key]: false }));
      await onSave({ [key]: "" });
    }
  };

  const secretStatusLabel = (key: SecretDraftKey, isConfigured: boolean) => {
    if (secretTouched[key] && !draft[key].trim()) return "待清除";
    if (isConfigured) {
      const hintKey = (key + "Hint") as keyof PublicPreferences;
      const hint = preferences[hintKey];
      if (typeof hint === "string" && hint) {
        return hint;
      }
      return "已配置";
    }
    return "未配置";
  };

  const secretStatusClass = (key: SecretDraftKey, isConfigured: boolean) =>
    cx(
      "text-[11px]",
      secretTouched[key] && !draft[key].trim()
        ? "text-red-600"
        : isConfigured
          ? "text-emerald-700"
          : "text-neutral-400",
    );

  const buildSecretPatch = (): Partial<Pick<PreferencesPatch, SecretDraftKey>> => {
    const patch: Partial<Pick<PreferencesPatch, SecretDraftKey>> = {};
    (["anthropicApiKey", "anthropicAuthToken", "openaiApiKey"] as SecretDraftKey[]).forEach((key) => {
      if (secretTouched[key]) {
        patch[key] = draft[key];
      }
    });
    return patch;
  };

  const applyProviderPreset = (
    provider: Pick<ProviderPresetCard, "providerId">,
    preset: Pick<ProviderPresetVariant, "baseUrl" | "models">,
    preferredModelId?: string,
  ) => {
    const nextModelId = preferredModelId || preset.models[0]?.id;
    const selectedModel = preset.models.find((model) => model.id === nextModelId);
    setExpandedProviderId(provider.providerId);
    setDraft((current) => ({
      ...current,
      openaiBaseUrl: preset.baseUrl,
      defaultModel: stripOpenAiModelPrefixForUi(nextModelId || current.defaultModel),
      modelProfiles: selectedModel?.contextLimit
        ? upsertModelProfile(
            applyPresetModelProfiles(current.modelProfiles, preset.models),
            {
              modelId: stripOpenAiModelPrefixForUi(selectedModel.id),
              contextLimit: selectedModel.contextLimit,
            },
          )
        : applyPresetModelProfiles(current.modelProfiles, preset.models),
    }));
  };

  if (!open) return null;

  return (
    <div className="theme-scope fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
      <motion.div
        initial={{ scale: 0.96, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.96, opacity: 0 }}
        className="theme-card flex h-[720px] w-[1040px] max-h-[calc(100vh-48px)] max-w-[calc(100vw-64px)] overflow-hidden rounded-[28px] border border-black/5 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.15)]"
      >
        <div className="theme-panel-strong w-[240px] border-r border-black/5 p-4">
          <div className="theme-text-primary mb-4 px-3 py-2 text-[18px] font-bold">设置</div>
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-col gap-0.5">
              {tabs.map((tab) => (
                <button
                  key={tab.label}
                  type="button"
                  onClick={() => setActiveTab(tab.label)}
                  className={cx(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors",
                    activeTab === tab.label
                      ? "bg-[var(--surface-hover-strong)] font-semibold text-[var(--text-primary)]"
                      : "theme-button-ghost",
                  )}
                >
                  <tab.icon className="h-4 w-4" strokeWidth={activeTab === tab.label ? 2 : 1.75} />
                  {tab.label}
                </button>
              ))}
            </div>

          </div>
        </div>

        <div className="theme-main flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 items-center justify-between border-b border-black/5 px-8">
            <span className="theme-text-primary text-[15px] font-semibold">{activeTab}</span>
            <IconButton label="关闭设置" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
            <div className="max-w-xl space-y-8">
              {activeTab === "通用" && (
                <>
                  <section>
                    <h3 className="theme-text-primary mb-4 text-[13px] font-semibold">运行环境</h3>
                    <div className="space-y-3">
                      <label className="block">
                        <span className="theme-text-muted mb-1 block text-[12px] font-medium">claw 命令路径</span>
                        <input
                          value={draft.clawPath}
                          onChange={(event) => setDraft({ ...draft, clawPath: event.target.value })}
                          className="theme-field h-9 w-full rounded-lg px-3 text-[13px] outline-none focus:border-black/20"
                        />
                      </label>
                      <div className="theme-note theme-border-soft rounded-xl border p-3">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="theme-text-secondary text-[12px] font-medium">状态</span>
                          <span className={cx("text-[12px]", systemStatus?.clawFound ? "text-emerald-700" : "text-red-700")}>
                            {systemStatus?.clawFound ? "可用" : "不可用"}
                          </span>
                        </div>
                        <pre className="log-output theme-text-muted max-h-24 overflow-auto whitespace-pre-wrap text-[11px] leading-4">
                          {systemStatus?.version || systemStatus?.error || "等待检测"}
                        </pre>
                      </div>
                    </div>
                  </section>

                  <section>
                    <h3 className="theme-text-primary mb-4 text-[13px] font-semibold">工作区</h3>
                    <div className="flex items-center gap-2">
                      <input
                        value={draft.workspacePath}
                        onChange={(event) => setDraft({ ...draft, workspacePath: event.target.value })}
                        className="theme-field h-9 flex-1 rounded-lg px-3 text-[13px] outline-none focus:border-black/20"
                      />
                      <IconButton
                        label="选择工作区"
                        onClick={async () => {
                          const folder = await onChooseFolder();
                          if (folder) setDraft((value) => ({ ...value, workspacePath: folder }));
                        }}
                      >
                        <FolderOpen className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </section>

                  <section>
                    <h3 className="theme-text-primary mb-4 text-[13px] font-semibold">外观主题</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { id: "light", label: "浅色模式", description: "适合白天与高亮环境" },
                        { id: "dark", label: "暗黑模式", description: "适合夜间与长时间专注" },
                      ].map((themeOption) => (
                        <button
                          key={themeOption.id}
                          type="button"
                          onClick={() => setDraft({ ...draft, theme: themeOption.id as "light" | "dark" })}
                          className={cx(
                            "rounded-2xl border p-4 text-left transition-colors",
                            draft.theme === themeOption.id
                              ? "border-neutral-900 bg-neutral-900 text-white"
                              : "theme-button-surface border",
                          )}
                        >
                          <div className="text-[13px] font-semibold">{themeOption.label}</div>
                          <div className={cx("mt-1 text-[11px] leading-5", draft.theme === themeOption.id ? "text-white/75" : "theme-text-muted")}>
                            {themeOption.description}
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h3 className="theme-text-primary mb-4 text-[13px] font-semibold">会话交互</h3>
                    <label className="flex items-center justify-between py-1 cursor-pointer">
                      <div className="pr-4">
                        <span className="theme-text-secondary block text-[13px] font-medium">单轮对话保存在同一个地方</span>
                        <span className="theme-text-muted mt-0.5 block text-[12px] leading-relaxed">
                          开启后，每个工作区新发起的所有单轮对话都将被自动合并并记录在同一个“单轮对话”会话中，极大地保持侧边栏的整洁。
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, saveSingleTurnInOnePlace: !draft.saveSingleTurnInOnePlace })}
                        className={cx(
                          "relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                          draft.saveSingleTurnInOnePlace ? "bg-neutral-900" : "bg-neutral-200"
                        )}
                      >
                        <span
                          className={cx(
                            "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                            draft.saveSingleTurnInOnePlace && "translate-x-4"
                          )}
                        />
                      </button>
                    </label>
                  </section>

                </>
              )}

              {activeTab === "模型" && (
                <>
                  <section>
                    <h3 className="mb-4 text-[13px] font-semibold text-neutral-900">模型名称</h3>
                    <label className="block">
                      <span className="mb-1 block text-[12px] font-medium text-neutral-500">模型 ID</span>
                      <input
                        value={draft.defaultModel}
                        onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })}
                        placeholder="例如 claude-sonnet-4、deepseek-v4-pro、mimo-v2.5、gpt-4o"
                        className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                      />
                    </label>
                    <p className="mt-2 text-[12px] leading-5 text-neutral-500">
                      手动填写任意需要使用的模型名称/ID。任务执行始终走原生 `claw` / REPL 路径。
                    </p>
                  </section>
                  <section>
                    <h3 className="mb-4 text-[13px] font-semibold text-neutral-900">兼容配置</h3>
                    <label className="flex items-center justify-between py-1">
                      <div className="pr-4">
                        <span className="text-[13px] font-medium text-neutral-700 block">Anthropic 兼容接口已停用</span>
                        <span className="text-[12px] text-neutral-500 block mt-0.5 leading-relaxed">
                          为避免错误路由与模型名漂移，当前版本已禁用所有兼容 HTTP 执行链路，任务只走原生 `claw` / REPL。
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled
                        className="relative h-5 w-9 shrink-0 cursor-not-allowed rounded-full bg-neutral-200 p-0.5 opacity-60"
                      >
                        <span
                          className="block h-4 w-4 rounded-full bg-white shadow-sm"
                        />
                      </button>
                    </label>
                  </section>
                  <section>
                    <h3 className="mb-4 text-[13px] font-semibold text-neutral-900">兼容 Base URL</h3>
                    <label className="block">
                      <span className="mb-1 block text-[12px] font-medium text-neutral-500">保留旧配置，仅兼容展示</span>
                      <input
                        value={draft.openaiBaseUrl}
                        onChange={(event) => setDraft({ ...draft, openaiBaseUrl: event.target.value })}
                        placeholder="例如 https://api.deepseek.com/v1"
                        className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                      />
                    </label>
                    <p className="mt-2 text-[12px] leading-5 text-neutral-500">
                      这个字段会继续保留在本地配置里以兼容旧数据，但当前不会驱动任务或语音转写路由。
                    </p>
                  </section>
                  <section>
                    <h3 className="mb-4 text-[13px] font-semibold text-neutral-900">权限模式</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { id: "read-only", label: "只读", icon: Shield },
                        { id: "workspace-write", label: "工作区写入", icon: Zap },
                        { id: "danger-full-access", label: "完全访问", icon: AlertTriangle },
                      ].map((mode) => (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setDraft({ ...draft, permissionMode: mode.id as ClawPermissionMode })}
                          className={cx(
                            "flex flex-col items-center gap-2 rounded-xl border p-4 text-[12px] font-medium transition-colors",
                            draft.permissionMode === mode.id ? "border-neutral-900 text-neutral-900" : "border-black/5 text-neutral-500 hover:border-black/10",
                          )}
                        >
                          <mode.icon className="h-5 w-5" />
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section>
                    <h3 className="mb-4 text-[13px] font-semibold text-neutral-900">高级模型功能</h3>
                    <label className="flex items-center justify-between py-1">
                      <div className="pr-4">
                        <span className="text-[13px] font-medium text-neutral-700 block">DeepSeek 1,000,000 上下文</span>
                        <span className="text-[12px] text-neutral-500 block mt-0.5 leading-relaxed">
                          开启后，DeepSeek 模型（包含 deepseek 字样）的上下文限制将扩展为 1,000,000 tokens。
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, enableDeepSeek1M: !draft.enableDeepSeek1M })}
                        className={cx(
                          "relative h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
                          draft.enableDeepSeek1M ? "bg-neutral-900" : "bg-neutral-200"
                        )}
                      >
                        <span
                          className={cx(
                            "block h-4 w-4 rounded-full bg-white shadow-sm transition-transform",
                            draft.enableDeepSeek1M && "translate-x-4"
                          )}
                        />
                      </button>
                    </label>
                  </section>
                  <section className="space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-[13px] font-semibold text-neutral-900">自定义模型上下文与计费</h3>
                        <p className="mt-1 text-[12px] leading-5 text-neutral-500">
                          为任意模型 ID 手动配置上下文上限，以及每百万 tokens 的输入、输出、缓存价格。
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={addModelProfile}
                        className="flex h-8 items-center gap-1.5 rounded-lg border border-black/5 px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-black/[0.02]"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        添加配置
                      </button>
                    </div>

                    <div className="space-y-3">
                      {draft.modelProfiles.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-black/10 bg-neutral-50/60 p-4 text-[12px] leading-5 text-neutral-500">
                          还没有自定义模型配置。比如可添加 `gpt-4o` 的 `200000` 上下文限制，或填入对应计费参数以启用费用预估。
                        </div>
                      ) : (
                        draft.modelProfiles.map((profile, index) => (
                          <div key={`${profile.modelId || "new"}-${index}`} className="space-y-3 rounded-xl border border-black/5 bg-neutral-50/50 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <label className="block flex-1">
                                <span className="mb-1 block text-[12px] font-medium text-neutral-500">模型 ID</span>
                                <input
                                  value={profile.modelId}
                                  onChange={(event) => updateModelProfile(index, { modelId: event.target.value })}
                                  placeholder="例如 claude-sonnet-4、deepseek-v4-pro、gpt-4o"
                                  className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                                />
                              </label>
                              <IconButton label="删除模型配置" onClick={() => removeModelProfile(index)}>
                                <Trash2 className="h-4 w-4" />
                              </IconButton>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                              <label className="block">
                                <span className="mb-1 block text-[12px] font-medium text-neutral-500">Context Window</span>
                                <input
                                  value={profile.contextLimit ?? ""}
                                  onChange={(event) => updateModelProfile(index, { contextLimit: parseOptionalNumber(event.target.value) })}
                                  placeholder="例如 200000"
                                  className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-[12px] font-medium text-neutral-500">输入价格 / 1M</span>
                                <input
                                  value={profile.inputPricePerMillion ?? ""}
                                  onChange={(event) => updateModelProfile(index, { inputPricePerMillion: parseOptionalNumber(event.target.value) })}
                                  placeholder="例如 5"
                                  className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-[12px] font-medium text-neutral-500">输出价格 / 1M</span>
                                <input
                                  value={profile.outputPricePerMillion ?? ""}
                                  onChange={(event) => updateModelProfile(index, { outputPricePerMillion: parseOptionalNumber(event.target.value) })}
                                  placeholder="例如 15"
                                  className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-[12px] font-medium text-neutral-500">缓存价格 / 1M</span>
                                <input
                                  value={profile.cachePricePerMillion ?? ""}
                                  onChange={(event) => updateModelProfile(index, { cachePricePerMillion: parseOptionalNumber(event.target.value) })}
                                  placeholder="留空则按输入价格估算"
                                  className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                                />
                              </label>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>
                </>
              )}

              {activeTab === "预设" && (
                <>
                  <section>
                    <div className="mb-5">
                      <div>
                        <h3 className="text-[13px] font-semibold text-neutral-900">Provider 预设</h3>
                        <p className="mt-1 text-[12px] leading-5 text-neutral-500">
                          按分类浏览，一键带入 Base URL 与推荐模型。
                        </p>
                      </div>
                    </div>

                    {(() => {
                      const categoryOrder = ["全部", "高性能推理", "国内模型", "路由聚合"];
                      const categoryMeta: Record<string, { icon: string; description: string }> = {
                        "全部": { icon: "✦", description: "浏览所有可用 provider 预设" },
                        "高性能推理": { icon: "⚡", description: "面向复杂推理与大规模上下文的高性能模型" },
                        "国内模型": { icon: "🇨🇳", description: "国内厂商官方接入地址与模型预设，适合直连" },
                        "路由聚合": { icon: "🔀", description: "统一入口接入多家模型供应商" },
                      };
                      const visibleProviders =
                        presetCategory === "全部"
                          ? providerPresetCards
                          : providerPresetCards.filter((provider) =>
                              (provider.filterCategories || [provider.category]).includes(presetCategory),
                            );
                      const selectedMeta = categoryMeta[presetCategory] || categoryMeta["全部"];

                      return (
                        <div className="space-y-4">
                          <div className="flex flex-wrap gap-2">
                            {categoryOrder.map((category) => (
                              <button
                                key={category}
                                type="button"
                                onClick={() => setPresetCategory(category)}
                                className={cx(
                                  "rounded-full px-3 py-1.5 text-[12px] font-medium transition-all",
                                  presetCategory === category
                                    ? "bg-neutral-900 text-white shadow-sm"
                                    : "border border-black/5 bg-white text-neutral-600 hover:border-black/10 hover:bg-neutral-50",
                                )}
                                >
                                  {category}
                              </button>
                            ))}
                          </div>

                          <div className="flex items-center gap-2 rounded-2xl border border-black/5 bg-neutral-50/80 px-4 py-3">
                            <span className="text-[14px]">{selectedMeta.icon}</span>
                            <div>
                              <div className="text-[12px] font-semibold text-neutral-800">{presetCategory}</div>
                              <div className="text-[11px] text-neutral-500">{selectedMeta.description}</div>
                            </div>
                          </div>

                          <div className="grid gap-3">
                            {visibleProviders.map((provider) => {
                              const providerActive = draft.openaiBaseUrl === provider.baseUrl;
                              const expanded = expandedProviderId === provider.providerId;
                              const domesticProvider = (provider.filterCategories || [provider.category]).includes("国内模型");
                              const nvidiaPresetActive = Boolean(
                                provider.nvidiaPreset &&
                                  draft.openaiBaseUrl === provider.nvidiaPreset.baseUrl &&
                                  provider.nvidiaPreset.models.some((item) => modelIdsEqualForUi(item.id, draft.defaultModel)),
                              );

                              return (
                                <div
                                  key={provider.providerId}
                                  className="overflow-hidden rounded-2xl border border-black/5 bg-white shadow-[0_10px_30px_-18px_rgba(15,23,42,0.35)]"
                                >
                                  <div className={cx("relative bg-gradient-to-r text-white", provider.accent)}>
                                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.18),transparent_35%)]" />
                                    <div className="relative flex items-start gap-3 px-4 py-4">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedProviderId((current) =>
                                            current === provider.providerId ? null : provider.providerId,
                                          )
                                        }
                                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                                      >
                                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10">
                                          <ChevronDown
                                            className={cx("h-4 w-4 transition-transform", expanded && "rotate-180")}
                                          />
                                        </div>
                                        <div className="min-w-0">
                                          <div className="flex flex-wrap items-center gap-2">
                                            <div className="inline-flex rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.18em] uppercase">
                                              {provider.chip}
                                            </div>
                                            <div className="inline-flex rounded-full border border-white/15 bg-black/10 px-2 py-0.5 text-[10px] font-medium text-white/80">
                                              {provider.category}
                                            </div>
                                          </div>
                                          <div className="mt-2 text-[15px] font-semibold">{provider.providerLabel}</div>
                                          <div className="mt-1 text-[12px] leading-5 text-white/80">{provider.helper}</div>
                                        </div>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          applyProviderPreset(provider, {
                                            baseUrl: provider.baseUrl,
                                            models: provider.models,
                                          })
                                        }
                                        className="relative shrink-0 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20"
                                      >
                                        {providerActive ? "已选中" : "应用预设"}
                                      </button>
                                    </div>
                                  </div>

                                  <AnimatePresence initial={false}>
                                    {expanded && (
                                      <motion.div
                                        key={`${provider.providerId}-content`}
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.2, ease: "easeInOut" }}
                                        className="overflow-hidden"
                                      >
                                        <div className="space-y-3 px-4 py-4">
                                          <div className="rounded-xl border border-black/5 bg-neutral-50/70 px-3 py-2">
                                            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-400">Base URL</div>
                                            <div className="mt-1 break-all font-mono text-[11px] text-neutral-600">{provider.baseUrl}</div>
                                          </div>

                                          <div className="grid gap-2">
                                            {provider.models.map((item) => (
                                              <button
                                                key={item.id}
                                                type="button"
                                                onClick={() =>
                                                  applyProviderPreset(
                                                    provider,
                                                    {
                                                      baseUrl: provider.baseUrl,
                                                      models: provider.models,
                                                    },
                                                    item.id,
                                                  )
                                                }
                                                className={cx(
                                                  "w-full rounded-xl border p-3 text-left transition-colors",
                                                  modelIdsEqualForUi(draft.defaultModel, item.id)
                                                    ? "border-neutral-900 bg-neutral-50 text-neutral-900"
                                                    : "border-black/5 bg-white text-neutral-600 hover:border-black/10 hover:bg-neutral-50",
                                                )}
                                              >
                                                <div className="flex items-center justify-between gap-3">
                                                  <div className="min-w-0">
                                                    <div className="truncate text-[12px] font-semibold">{item.label}</div>
                                                    <div className="mt-1 truncate font-mono text-[10px] text-neutral-400">{item.id}</div>
                                                  </div>
                                                  {modelIdsEqualForUi(draft.defaultModel, item.id) && <Check className="h-4 w-4 shrink-0 text-neutral-800" />}
                                                </div>
                                                <div className="mt-2 text-[11px] leading-5 text-neutral-500">{item.description}</div>
                                                {item.contextNote && (
                                                  <div className="mt-2 inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
                                                    {item.contextNote}
                                                  </div>
                                                )}
                                              </button>
                                            ))}
                                          </div>

                                          {domesticProvider && provider.nvidiaPreset && (
                                            <div className="space-y-3 rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                                              <div className="flex items-start justify-between gap-3">
                                                <div>
                                                  <div className="text-[12px] font-semibold text-emerald-900">{provider.nvidiaPreset.label}</div>
                                                  <div className="mt-1 text-[11px] leading-5 text-emerald-800/80">
                                                    {provider.nvidiaPreset.helper}
                                                  </div>
                                                </div>
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    provider.nvidiaPreset &&
                                                    provider.nvidiaPreset.models.length > 0 &&
                                                    applyProviderPreset(provider, provider.nvidiaPreset)
                                                  }
                                                  disabled={provider.nvidiaPreset.models.length === 0}
                                                  className={cx(
                                                    "shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
                                                    nvidiaPresetActive
                                                      ? "bg-emerald-600 text-white"
                                                      : "border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100",
                                                    provider.nvidiaPreset.models.length === 0 && "cursor-not-allowed opacity-50 hover:bg-white",
                                                  )}
                                                >
                                                  {nvidiaPresetActive ? "已切到 NVIDIA" : "应用 NVIDIA 预设"}
                                                </button>
                                              </div>

                                              <div className="rounded-xl border border-emerald-100 bg-white/80 px-3 py-2">
                                                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500">Base URL</div>
                                                <div className="mt-1 break-all font-mono text-[11px] text-emerald-800">
                                                  {provider.nvidiaPreset.baseUrl}
                                                </div>
                                              </div>

                                              {provider.nvidiaPreset.unavailableReason ? (
                                                <div className="rounded-xl border border-dashed border-emerald-200 bg-white/70 px-3 py-3 text-[11px] leading-5 text-emerald-900/80">
                                                  {provider.nvidiaPreset.unavailableReason}
                                                </div>
                                              ) : (
                                                <div className="grid gap-2">
                                                  {provider.nvidiaPreset.models.map((item) => (
                                                    <button
                                                      key={`${provider.providerId}-nvidia-${item.id}`}
                                                      type="button"
                                                      onClick={() => applyProviderPreset(provider, provider.nvidiaPreset!, item.id)}
                                                      className={cx(
                                                        "w-full rounded-xl border p-3 text-left transition-colors",
                                                        modelIdsEqualForUi(draft.defaultModel, item.id) && draft.openaiBaseUrl === provider.nvidiaPreset?.baseUrl
                                                          ? "border-emerald-500 bg-white text-emerald-950"
                                                          : "border-emerald-100 bg-white text-emerald-900 hover:border-emerald-200 hover:bg-emerald-50/70",
                                                      )}
                                                    >
                                                      <div className="flex items-center justify-between gap-3">
                                                        <div className="min-w-0">
                                                          <div className="truncate text-[12px] font-semibold">{item.label}</div>
                                                          <div className="mt-1 truncate font-mono text-[10px] text-emerald-700/70">{item.id}</div>
                                                        </div>
                                                        {modelIdsEqualForUi(draft.defaultModel, item.id) && draft.openaiBaseUrl === provider.nvidiaPreset?.baseUrl && (
                                                          <Check className="h-4 w-4 shrink-0 text-emerald-700" />
                                                        )}
                                                      </div>
                                                      <div className="mt-2 text-[11px] leading-5 text-emerald-900/75">{item.description}</div>
                                                      {item.contextNote && (
                                                        <div className="mt-2 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
                                                          {item.contextNote}
                                                        </div>
                                                      )}
                                                    </button>
                                                  ))}
                                                </div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                  </section>
                </>
              )}

              {activeTab === "API" && (
                <section className="space-y-6">
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-[13px] font-semibold text-neutral-900">模型凭据</h3>
                      <p className="mt-1 text-[12px] leading-5 text-neutral-500">
                        这些密钥保留用于原生 `claw` CLI 所需的认证或向后兼容显示，不再用于兼容 HTTP 路由。
                      </p>
                    </div>
                    <label className="block">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[12px] font-medium text-neutral-500">API Key</span>
                        <div className="flex items-center gap-2">
                          <span className={secretStatusClass("openaiApiKey", preferences.openaiApiKeySet)}>
                            {secretStatusLabel("openaiApiKey", preferences.openaiApiKeySet)}
                          </span>
                          {preferences.openaiApiKeySet && (
                            <button
                              type="button"
                              onClick={() => markSecretForDeletion("openaiApiKey")}
                              className="rounded-full border border-red-200 px-2 py-0.5 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-50"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>
                      <input
                        type="password"
                        value={draft.openaiApiKey}
                        onChange={(event) => updateSecretField("openaiApiKey", event.target.value)}
                        placeholder={preferences.openaiApiKeySet ? "输入新值以覆盖" : "粘贴模型 API Key；本地 Ollama 可留空"}
                        className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                      />
                    </label>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <h3 className="text-[13px] font-semibold text-neutral-900">原生 Provider 凭据（可选）</h3>
                      <p className="mt-1 text-[12px] leading-5 text-neutral-500">
                        原生 `claw` CLI 使用 Claude 系模型时，优先读取下面两个字段：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`。
                      </p>
                    </div>
                    {[
                      { key: "anthropicApiKey" as const, label: "ANTHROPIC_API_KEY", set: preferences.anthropicApiKeySet },
                      { key: "anthropicAuthToken" as const, label: "ANTHROPIC_AUTH_TOKEN", set: preferences.anthropicAuthTokenSet },
                    ].map((item) => (
                      <label key={item.key} className="block">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="text-[12px] font-medium text-neutral-500">{item.label}</span>
                          <div className="flex items-center gap-2">
                            <span className={secretStatusClass(item.key, item.set)}>{secretStatusLabel(item.key, item.set)}</span>
                            {item.set && (
                              <button
                                type="button"
                                onClick={() => markSecretForDeletion(item.key)}
                                className="rounded-full border border-red-200 px-2 py-0.5 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-50"
                              >
                                删除
                              </button>
                            )}
                          </div>
                        </div>
                        <input
                          type="password"
                          value={draft[item.key]}
                          onChange={(event) => updateSecretField(item.key, event.target.value)}
                          placeholder={item.set ? "输入新值以覆盖" : "粘贴本地凭据"}
                          className="h-9 w-full rounded-lg border border-black/10 bg-white px-3 text-[13px] outline-none focus:border-black/20"
                        />
                      </label>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "数据" && (
                <section className="space-y-4">
                  <h3 className="text-[13px] font-semibold text-neutral-900">本地数据</h3>
                  <div className="rounded-xl border border-black/5 bg-neutral-50/60 p-4">
                    <div className="mb-2 flex items-center gap-2 text-neutral-700">
                      <Database className="h-4 w-4 text-neutral-500" />
                      <span className="text-[13px] font-medium">LowDB JSON Store</span>
                    </div>
                    <p className="text-[12px] leading-5 text-neutral-500">{systemStatus?.userDataPath || "Electron userData"}</p>
                  </div>
                  <label className="flex items-center justify-between py-1">
                    <span className="text-[13px] font-medium text-neutral-700">自动保存任务日志</span>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, autoSaveLogs: !draft.autoSaveLogs })}
                      className={cx("relative h-5 w-9 rounded-full p-0.5 transition-colors", draft.autoSaveLogs ? "bg-neutral-900" : "bg-neutral-200")}
                    >
                      <span className={cx("block h-4 w-4 rounded-full bg-white shadow-sm transition-transform", draft.autoSaveLogs && "translate-x-4")} />
                    </button>
                  </label>
                </section>
              )}

              {activeTab === "MCP 服务器" && (
                <section className="space-y-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-[13px] font-semibold text-neutral-900">MCP 服务器</h3>
                    <button className="flex h-8 items-center gap-1.5 rounded-lg border border-black/5 px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-black/[0.02]">
                      <Plus className="h-3.5 w-3.5" />
                      添加服务器
                    </button>
                  </div>
                  <div className="space-y-3">
                    {[
                      { name: "Local File System", status: "ready", type: "stdio" },
                      { name: "GitHub Connector", status: "paused", type: "stdio" },
                    ].map((server) => (
                      <div key={server.name} className="flex items-center justify-between rounded-xl border border-black/5 bg-white p-4 shadow-sm">
                        <div className="flex items-center gap-3">
                          <span className={cx("h-2 w-2 rounded-full", server.status === "ready" ? "bg-green-500" : "bg-amber-500")} />
                          <div>
                            <div className="text-[13px] font-medium text-neutral-900">{server.name}</div>
                            <div className="text-[11px] uppercase tracking-wider text-neutral-400">{server.type}</div>
                          </div>
                        </div>
                        <IconButton label="归档服务器">
                          <Archive className="h-4 w-4" />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "已归档对话" && (
                <section className="space-y-4">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-[13px] font-semibold text-neutral-900">已归档对话</h3>
                  </div>

                  <div className="rounded-2xl border border-black/5 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 text-neutral-700">
                          <Archive className="h-4 w-4 text-neutral-500" />
                          <h3 className="text-[13px] font-semibold text-neutral-900">已归档对话</h3>
                        </div>
                        <p className="mt-2 text-[12px] leading-5 text-neutral-500">从侧边栏归档的工作区对话会保留在这里，可随时恢复。</p>
                      </div>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                        {archivedConversations.length}
                      </span>
                    </div>

                    <div className="mt-4">
                      {archivedConversations.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-black/10 bg-neutral-50/60 p-4 text-[12px] leading-5 text-neutral-500">
                          暂无已归档对话。
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {archivedConversations.map((conversation) => (
                            <ArchivedConversationCard
                              key={conversation.id}
                              conversation={conversation}
                              showMeta
                              titleLines={2}
                              onRestore={() => onRestoreConversation(conversation.id)}
                              restoring={restoringConversationId === conversation.id}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>

          <div className="flex h-16 items-center justify-end gap-2 border-t border-black/5 bg-[#fbfbfa] px-8">
            <button type="button" onClick={onClose} className="h-9 rounded-lg px-4 text-[13px] font-medium text-neutral-600 transition-colors hover:bg-black/5">
              取消
            </button>
            <button
              type="button"
              onClick={async () => {
                const { anthropicApiKey, anthropicAuthToken, openaiApiKey, ...restDraft } = draft;
                await onSave({
                  ...restDraft,
                  ...buildSecretPatch(),
                  modelProfiles: sanitizeModelProfilesForSave(draft.modelProfiles),
                });
                onClose();
              }}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-neutral-900 px-5 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800"
            >
              <Save className="h-3.5 w-3.5" />
              保存
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function App() {
  const [activeView, setActiveView] = useState<ViewKey>("dashboard");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [worktreeModalState, setWorktreeModalState] = useState<WorktreeModalState | null>(null);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [worktreeError, setWorktreeError] = useState("");
  const [preferences, setPreferences] = useState<PublicPreferences>(defaultPreferences);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [tasks, setTasks] = useState<ClawTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<ArchivedConversation[]>([]);
  const [restoringConversationId, setRestoringConversationId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<LocalCatalog>(emptyCatalog);
  const [prompt, setPrompt] = useState("");
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);
  const [pendingFreshConversationWorkspace, setPendingFreshConversationWorkspace] = useState<string | null>(null);

  const activeWorkspaceTasks = useMemo(() => {
    const activePath = normalizeWorkspacePathValue(preferences.workspacePath);
    return tasks.filter(
      (task) => task.cwd && normalizeWorkspacePathValue(task.cwd) === activePath
    );
  }, [tasks, preferences.workspacePath]);

  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>(() => {
    try {
      const saved = localStorage.getItem("claw_workspaces");
      if (saved) return sanitizeWorkspaceItems(JSON.parse(saved));
    } catch {}
    return sanitizeWorkspaceItems([
      { id: "ws-1", name: "Codex", path: "/Users/mac/Documents/Codex", isPinned: false },
      { id: "ws-2", name: "New Think", path: "/Users/mac/Documents/New project", isPinned: false },
      { id: "ws-3", name: "New project 2", path: "/Users/mac/Documents/New project 2", isPinned: false },
      { id: "ws-4", name: "byroncad", path: "/Users/mac/Documents/byroncad", isPinned: false },
      { id: "ws-5", name: "test", path: "/Users/mac/Documents/test", isPinned: false },
    ]);
  });

  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("claw_expanded_workspaces");
      if (saved) return sanitizeExpandedWorkspaceState(JSON.parse(saved), workspaces);
    } catch {}
    return { "ws-2": true };
  });

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const workspacesRef = useRef<WorkspaceItem[]>(workspaces);

  useEffect(() => {
    const sanitized = sanitizeWorkspaceItems(workspaces);
    workspacesRef.current = sanitized;
    localStorage.setItem("claw_workspaces", JSON.stringify(sanitized));
    const changed =
      sanitized.length !== workspaces.length ||
      sanitized.some((item, index) => {
        const current = workspaces[index];
        return !current || item.id !== current.id || item.name !== current.name || item.path !== current.path || item.isPinned !== current.isPinned;
      });
    if (changed) {
      setWorkspaces(sanitized);
    }
  }, [workspaces]);

  useEffect(() => {
    const sanitized = sanitizeExpandedWorkspaceState(expandedWorkspaces, workspaces);
    localStorage.setItem("claw_expanded_workspaces", JSON.stringify(sanitized));
    if (Object.keys(sanitized).length !== Object.keys(expandedWorkspaces).length) {
      setExpandedWorkspaces(sanitized);
    }
  }, [expandedWorkspaces, workspaces]);

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme || "light";
    document.body.dataset.theme = preferences.theme || "light";
  }, [preferences.theme]);

  const activeWorkspacePath = normalizeWorkspacePathValue(preferences.workspacePath);

  function findLatestTaskIdForWorkspace(workspacePath: string, sourceTasks: ClawTask[] = tasks) {
    const activePath = normalizeWorkspacePathValue(workspacePath);
    return (
      sourceTasks.find((task) => task.cwd && normalizeWorkspacePathValue(task.cwd) === activePath)?.id ||
      null
    );
  }

  function findLatestTaskForWorkspace(workspacePath: string, sourceTasks: ClawTask[] = tasks) {
    const activePath = normalizeWorkspacePathValue(workspacePath);
    return (
      [...sourceTasks]
        .filter((task) => task.cwd && normalizeWorkspacePathValue(task.cwd) === activePath)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
    );
  }

  const selectedTaskForComposer = useMemo(() => {
    return selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) || null : null;
  }, [selectedTaskId, tasks]);
  const taskPendingDeletion = useMemo(() => {
    return taskToDelete ? tasks.find((task) => task.id === taskToDelete) || null : null;
  }, [taskToDelete, tasks]);

  const selectedTaskWorkspacePathForComposer = normalizeWorkspacePathValue(selectedTaskForComposer?.cwd || "");
  const selectedTaskInOtherWorkspaceForComposer = Boolean(
    selectedTaskForComposer?.cwd && selectedTaskWorkspacePathForComposer !== activeWorkspacePath
  );

  const selectedConversationIdForUI = selectedTaskForComposer && !selectedTaskInOtherWorkspaceForComposer
    ? selectedTaskForComposer.conversationId || null
    : null;
  const defaultWorkspaceConversationIdForComposer = useMemo(() => {
    if (selectedTaskForComposer && !selectedTaskInOtherWorkspaceForComposer) {
      return null;
    }
    return (
      [...tasks]
        .filter((task) => {
          if (!task.conversationId) return false;
          return task.cwd && normalizeWorkspacePathValue(task.cwd) === activeWorkspacePath;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.conversationId || null
    );
  }, [activeWorkspacePath, selectedTaskForComposer, selectedTaskInOtherWorkspaceForComposer, tasks]);

  const selectedConversationLabel = selectedTaskInOtherWorkspaceForComposer
    ? null
    : selectedConversationIdForUI
      ? "当前对话"
      : selectedTaskForComposer
        ? "当前任务"
        : null;
  const sidebarHighlightedConversationId =
    pendingFreshConversationWorkspace === activeWorkspacePath ? null : selectedConversationIdForUI;
  const sidebarHighlightedStandaloneTaskId =
    pendingFreshConversationWorkspace === activeWorkspacePath
      ? null
      : selectedTaskForComposer &&
          selectedTaskWorkspacePathForComposer === activeWorkspacePath &&
          !selectedTaskForComposer.conversationId
        ? selectedTaskForComposer.id
        : null;

  const refreshStatus = async () => {
    const [nextPreferences, nextStatus, nextCatalog, nextArchivedConversations] = await Promise.all([
      api.preferences.get(),
      api.system.status(),
      api.catalog.list(),
      api.conversations.listArchived(),
    ]);
    setPreferences(nextPreferences);
    setSystemStatus(nextStatus);
    setCatalog(nextCatalog);
    setArchivedConversations(nextArchivedConversations);
    document.documentElement.style.setProperty("--app-font-size", `${nextPreferences.fontSize}px`);
  };

  useEffect(() => {
    let mounted = true;

    Promise.all([
      api.preferences.get(),
      api.system.status(),
      api.catalog.list(),
      api.tasks.list(),
    ]).then(([nextPreferences, nextStatus, nextCatalog, nextTasks]) => {
      if (!mounted) return;
      setPreferences(nextPreferences);
      setSystemStatus(nextStatus);
      setCatalog(nextCatalog);
      document.documentElement.style.setProperty("--app-font-size", `${nextPreferences.fontSize}px`);
      setTasks(nextTasks);

      // Default to selecting the latest task of the active workspace
      const activePath = normalizeWorkspacePathValue(nextPreferences.workspacePath);
      const activeTasks = nextTasks.filter(
        (task) => task.cwd && normalizeWorkspacePathValue(task.cwd) === activePath
      );
      setSelectedTaskId(activeTasks[0]?.id || null);
    });

    const unsubscribe = api.tasks.onEvent((event: TaskBusEvent) => {
      if (!mounted) return;
      if (event.type === "task:updated") {
        const task = event.payload as ClawTask;
        setTasks((current) => {
          const exists = current.some((item) => item.id === task.id);
          const next = exists
            ? current.map((item) => {
                if (item.id !== task.id) return item;
                return {
                  ...item,
                  ...task,
                  // Preserve already streamed content if an older summary arrives.
                  output: task.output && task.output.length >= (item.output || "").length ? task.output : item.output,
                  error: task.error && task.error.length >= (item.error || "").length ? task.error : item.error,
                  events: (task.events && task.events.length >= (item.events || []).length) ? task.events : item.events,
                };
              })
            : [task, ...current];
          return next.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        });

        // Safe preference state reader callback to avoid preferences dependency
        setPreferences((currentPrefs) => {
          const activePath = normalizeWorkspacePathValue(currentPrefs.workspacePath);
          const taskPath = task.cwd ? normalizeWorkspacePathValue(task.cwd) : "";
          if (taskPath === activePath) {
            setSelectedTaskId((currentTaskId) => currentTaskId || task.id);
          }
          return currentPrefs;
        });
      }
      if (event.type === "task:chunk") {
        const chunk = event.payload as TaskEvent;
        setTasks((current) =>
          current.map((task) => {
            if (task.id !== chunk.taskId) return task;
            const existingEvents = task.events || [];
            if (existingEvents.some((eventItem) => eventItem.id === chunk.id)) {
              return task;
            }
            const nextOutput =
              chunk.stream === "stdout" ? `${task.output || ""}${chunk.chunk || ""}` : task.output;
            const nextError =
              chunk.stream === "stderr" ? `${task.error || ""}${chunk.chunk || ""}` : task.error;
            return {
              ...task,
              output: nextOutput,
              error: nextError,
              events: [...existingEvents, chunk].slice(-200),
            };
          }),
        );
      }
      if (event.type === "task:cleared") {
        const payload = event.payload as ClawTask[];
        setTasks(payload);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    api.conversations.listArchived().then((nextArchivedConversations) => {
      if (!mounted) return;
      setArchivedConversations(nextArchivedConversations);
    });

    return () => {
      mounted = false;
    };
  }, [preferences.workspacePath, tasks]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const selectedTaskExists = tasks.some((task) => task.id === selectedTaskId);
    if (selectedTaskExists) return;
    setSelectedTaskId(findLatestTaskIdForWorkspace(preferences.workspacePath, tasks));
  }, [selectedTaskId, tasks, preferences.workspacePath]);

  useEffect(() => {
    if (!settingsOpen) return;
    let mounted = true;
    api.conversations.listArchived().then((nextArchivedConversations) => {
      if (!mounted) return;
      setArchivedConversations(nextArchivedConversations);
    }).catch(() => {});
    return () => {
      mounted = false;
    };
  }, [settingsOpen]);

  const runPromptDirect = async (nextPrompt: string) => {
    const resolved = resolveSlashCommandPrompt(nextPrompt, catalog.skills);
    if (resolved.error) {
      setToastMessage(resolved.error);
      return;
    }

    const value = resolved.prompt.trim();
    if (!value) return;

    const shouldForceFreshConversation =
      pendingFreshConversationWorkspace !== null &&
      pendingFreshConversationWorkspace === activeWorkspacePath &&
      selectedTaskId === null;

    const selectedTaskIsStandaloneInActiveWorkspace = Boolean(
      selectedTaskForComposer
      && !selectedTaskInOtherWorkspaceForComposer
      && !selectedTaskForComposer.conversationId
      && selectedTaskWorkspacePathForComposer === activeWorkspacePath
    );
    let targetConversationId =
      shouldForceFreshConversation
        ? null
        : selectedConversationIdForUI || (!selectedTaskForComposer ? defaultWorkspaceConversationIdForComposer : null);
    if (!targetConversationId && !shouldForceFreshConversation && !selectedTaskIsStandaloneInActiveWorkspace && (preferences.saveSingleTurnInOnePlace ?? true)) {
      targetConversationId = singleTurnConversationIdForWorkspace(preferences.workspacePath);
    }

    const task = await api.tasks.run({
      prompt: value,
      conversationId: targetConversationId,
      forceFreshConversation: shouldForceFreshConversation,
      cwd: preferences.workspacePath,
      model: preferences.defaultModel,
      permissionMode: preferences.permissionMode,
      files: attachedFiles,
    });
    if (resolved.matchedCommand && resolved.matchedSkillName) {
      setToastMessage(`已套用 ${resolved.matchedCommand} -> ${resolved.matchedSkillName}`);
    }
    setPendingFreshConversationWorkspace(null);
    setPrompt("");
    setSelectedTaskId(task.id);
    setActiveView("tasks");
  };

  const runTask = async () => {
    await runPromptDirect(prompt);
  };

  const attachFiles = async (kind: AttachmentKind) => {
    const files = await api.files.selectFiles(kind);
    setAttachedFiles((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]));
      files.forEach((file) => byPath.set(file.path, file));
      return [...byPath.values()];
    });
  };

  const attachDroppedFiles = async (fileList: FileList) => {
    const files = await api.files.fromDroppedFiles(fileList);
    setAttachedFiles((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]));
      files.forEach((file) => byPath.set(file.path, file));
      return [...byPath.values()];
    });
  };

  const chooseFolder = async () => api.files.selectFolder();

  const selectFolder = async () => {
    const folder = await chooseFolder();
    if (!folder) return;
    const next = await api.preferences.save({ workspacePath: folder });
    setPendingFreshConversationWorkspace(null);
    setPreferences(next);
    setSelectedTaskId((current) => {
      const currentTask = current ? tasks.find((task) => task.id === current) : null;
      if (currentTask && normalizeWorkspacePathValue(currentTask.cwd) === normalizeWorkspacePathValue(next.workspacePath)) {
        return current;
      }
      return findLatestTaskIdForWorkspace(next.workspacePath);
    });
  };

  const savePreferences = async (patch: PreferencesPatch) => {
    const next = await api.preferences.save(patch);
    setPreferences(next);
    if (Object.prototype.hasOwnProperty.call(patch, "workspacePath")) {
      setPendingFreshConversationWorkspace(null);
      setSelectedTaskId((current) => {
        const currentTask = current ? tasks.find((task) => task.id === current) : null;
        if (currentTask && normalizeWorkspacePathValue(currentTask.cwd) === normalizeWorkspacePathValue(next.workspacePath)) {
          return current;
        }
        return findLatestTaskIdForWorkspace(next.workspacePath);
      });
    }
    document.documentElement.style.setProperty("--app-font-size", `${next.fontSize}px`);
    await refreshStatus();
  };

  const clearTasks = async () => {
    const remaining = await api.tasks.clear();
    setTasks(remaining);
    setPendingFreshConversationWorkspace(null);
    setSelectedTaskId(findLatestTaskIdForWorkspace(preferences.workspacePath, remaining));
  };

  const handleSelectTask = (taskId: string) => {
    setPendingFreshConversationWorkspace(null);
    setSelectedTaskId(taskId);
  };

  const branchTaskFromTaskLog = async (taskId: string) => {
    const sourceTask = tasks.find((task) => task.id === taskId);
    if (!sourceTask) return;
    try {
      const branchName = window.prompt("请输入分支名称:", `branch-${new Date().toISOString().slice(0, 10)}`);
      if (!branchName) return;
      const result = await api.derived.branchTask({
        sourceTaskId: sourceTask.id,
        branchName,
      });
      const nextTasks = await api.tasks.list();
      setTasks(nextTasks);
      setPendingFreshConversationWorkspace(null);
      setSelectedTaskId(result.newTaskId);
      setActiveView("tasks");
      setToastMessage(`已创建对话分叉：${branchName}`);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "创建对话分叉失败");
    }
  };

  const switchWorkspace = async (workspacePath: string) => {
    const next = await api.preferences.save({ workspacePath });
    setPendingFreshConversationWorkspace(null);
    setPreferences(next);
    setSelectedTaskId((current) => {
      const currentTask = current ? tasks.find((task) => task.id === current) : null;
      if (currentTask && normalizeWorkspacePathValue(currentTask.cwd) === normalizeWorkspacePathValue(next.workspacePath)) {
        return current;
      }
      return findLatestTaskIdForWorkspace(next.workspacePath);
    });
  };

  const deleteTask = async (taskId: string) => {
    setTaskToDelete(taskId);
  };

  const handleConfirmDelete = async () => {
    if (!taskToDelete) return;
    const remaining = await api.tasks.delete(taskToDelete);
    setTasks(remaining);
    if (selectedTaskId === taskToDelete) {
      setSelectedTaskId(findLatestTaskIdForWorkspace(preferences.workspacePath, remaining));
    }
    setTaskToDelete(null);
  };

  const handleToggleWorkspace = (id: string) => {
    setExpandedWorkspaces((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handlePinWorkspace = (id: string) => {
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id === id ? { ...ws, isPinned: !ws.isPinned } : ws))
    );
    setToastMessage("置顶状态已更新");
  };

  const handleRenameWorkspace = (id: string, newName: string) => {
    if (!newName.trim()) return;
    setWorkspaces((prev) =>
      prev.map((ws) => (ws.id === id ? { ...ws, name: newName.trim() } : ws))
    );
    setToastMessage("项目重命名成功");
  };

  const handleRemoveWorkspace = (id: string) => {
    setWorkspaces((prev) => {
      const next = sanitizeWorkspaceItems(prev.filter((ws) => ws.id !== id));
      workspacesRef.current = next;
      return next;
    });
    setExpandedWorkspaces((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setToastMessage("项目已移出侧边栏");
  };

  const handleNewConversation = async (path: string) => {
    const next = await api.preferences.save({ workspacePath: path });
    setPendingFreshConversationWorkspace(normalizeWorkspacePathValue(path));
    setPreferences(next);
    setSelectedTaskId(null);
    setPrompt("");
    setActiveView("dashboard");
    setToastMessage("已在此文件夹内发起新对话");
  };

  const addWorkspaceToSidebar = (pathValue: string, explicitName?: string) => {
    const normalizedFolder = normalizeWorkspacePathValue(pathValue);
    const normalizedFolderKey = workspacePathKey(normalizedFolder);
    const latestWorkspaces = sanitizeWorkspaceItems(workspacesRef.current);
    const existingWorkspace = latestWorkspaces.find((ws) => workspacePathKey(ws.path) === normalizedFolderKey);
    if (existingWorkspace) {
      setExpandedWorkspaces((prev) => ({ ...prev, [existingWorkspace.id]: true }));
      return existingWorkspace;
    }

    const newWorkspace: WorkspaceItem = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: explicitName?.trim() || deriveWorkspaceNameFromPath(normalizedFolder),
      path: normalizedFolder,
      isPinned: false,
    };
    const nextWorkspaces = [...latestWorkspaces, newWorkspace];
    workspacesRef.current = nextWorkspaces;
    setWorkspaces(nextWorkspaces);
    setExpandedWorkspaces((prev) => ({ ...prev, [newWorkspace.id]: true }));
    return newWorkspace;
  };

  const handleAddWorkspace = async () => {
    const folder = await chooseFolder();
    if (!folder) return;
    const existingWorkspace = sanitizeWorkspaceItems(workspacesRef.current).find(
      (ws) => workspacePathKey(ws.path) === workspacePathKey(folder),
    );
    if (existingWorkspace) {
      setExpandedWorkspaces((prev) => ({ ...prev, [existingWorkspace.id]: true }));
      setToastMessage("该工作区已在侧边栏中");
      return;
    }
    addWorkspaceToSidebar(folder);
    setToastMessage("工作区添加成功");
  };

  const handleOpenWorktreeModal = (state: WorktreeModalState) => {
    setWorktreeError("");
    setWorktreeModalState(state);
  };

  const handleCloseWorktreeModal = () => {
    if (creatingWorktree) return;
    setWorktreeError("");
    setWorktreeModalState(null);
  };

  const handleCreateWorktree = async (name: string) => {
    if (!worktreeModalState) return;
    setCreatingWorktree(true);
    setWorktreeError("");
    try {
      const result = await api.workspace.createWorktree({
        sourcePath: worktreeModalState.sourcePath,
        name,
      });
      addWorkspaceToSidebar(result.path, result.name);
      setWorktreeModalState(null);
      if (result.latestTaskId) {
        setSelectedTaskId(result.latestTaskId);
        setActiveView("tasks");
      }
      setToastMessage(
        `已创建工作树项目 ${result.name}，复制 ${result.clonedConversationCount} 段对话 / ${result.clonedTaskCount} 条任务`,
      );
    } catch (error) {
      setWorktreeError(error instanceof Error ? error.message : "创建工作树失败");
    } finally {
      setCreatingWorktree(false);
    }
  };

  const handleArchiveWorkspace = async (path: string, name: string) => {
    try {
      const result = await api.conversations.archiveWorkspace({ workspacePath: path });
      setTasks(result.tasks);
      setArchivedConversations(result.archivedConversations);
      setSelectedTaskId((current) => {
        if (current && result.tasks.some((task) => task.id === current)) return current;
        return findLatestTaskIdForWorkspace(preferences.workspacePath, result.tasks);
      });
      if (result.taskCount === 0) {
        setToastMessage(`${name} 暂无可归档对话`);
        return;
      }
      setToastMessage(`已归档 ${name} 的 ${result.archivedCount} 段对话 / ${result.taskCount} 条任务`);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "归档对话失败");
    }
  };

  const handleArchiveConversation = async (conversationId: string) => {
    try {
      const result = await api.conversations.archive(conversationId);
      setTasks(result.tasks);
      setArchivedConversations(result.archivedConversations);
      // If the currently selected task belongs to the archived conversation, deselect
      if (selectedTaskId) {
        const selectedTask = tasks.find((task) => task.id === selectedTaskId);
        if (selectedTask?.conversationId === conversationId) {
          setSelectedTaskId(null);
          setActiveView("dashboard");
        }
      }
      setToastMessage(`已归档对话（${result.taskCount} 条任务）`);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "归档对话失败");
    }
  };

  const handleRestoreConversation = async (conversationId: string) => {
    setRestoringConversationId(conversationId);
    try {
      const result = await api.conversations.restore(conversationId);
      setTasks(result.tasks);
      setArchivedConversations(result.archivedConversations);
      if (result.latestTaskId) {
        handleSelectTask(result.latestTaskId);
        setActiveView("tasks");
      }
      setToastMessage(`已恢复 ${result.restoredTaskCount} 条任务`);
    } catch (error) {
      setToastMessage(error instanceof Error ? error.message : "恢复归档对话失败");
    } finally {
      setRestoringConversationId(null);
    }
  };

  const usePrompt = (value: string) => {
    setPrompt(value);
    setActiveView("dashboard");
  };

  const openTask = (taskId: string) => {
    handleSelectTask(taskId);
    setActiveView("tasks");
  };

  const content = (() => {
    if (featureViewKeys.includes(activeView as FeatureViewKey)) {
      return (
        <FeaturePage
          view={activeView as FeatureViewKey}
          preferences={preferences}
          tasks={activeWorkspaceTasks}
          files={attachedFiles}
          catalog={catalog}
          onUsePrompt={usePrompt}
          onRunPrompt={runPromptDirect}
          onOpenTaskLog={() => setActiveView("tasks")}
          onOpenTask={openTask}
        />
      );
    }
    if (activeView === "files") {
      return (
        <FilePanel
          files={attachedFiles}
          preferences={preferences}
          onAttachFiles={() => void attachFiles("file")}
          onAttachDroppedFiles={attachDroppedFiles}
          onRemoveFile={(fileId) => setAttachedFiles((current) => current.filter((file) => file.id !== fileId))}
          onSelectFolder={selectFolder}
        />
      );
    }
    if (activeView === "tasks") {
      return (
        <TaskLog
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          preferences={preferences}
          onSelectTask={handleSelectTask}
          onSwitchWorkspace={(workspacePath) => void switchWorkspace(workspacePath)}
          onCancelTask={(taskId) => api.tasks.cancel(taskId)}
          onClearTasks={clearTasks}
          onDeleteTask={deleteTask}
          onBranchTask={(taskId) => void branchTaskFromTaskLog(taskId)}
          onRunFollowUp={async (value, conversationId, cwd, model, permissionMode, files) => {
            const followUpConversationId =
              conversationId || ((preferences.saveSingleTurnInOnePlace ?? true) ? singleTurnConversationIdForWorkspace(cwd) : null);
            const task = await api.tasks.run({
              prompt: value,
              conversationId: followUpConversationId,
              cwd,
              model,
              permissionMode,
              files: files || [],
            });
            handleSelectTask(task.id);
          }}
          onShowToast={setToastMessage}
        />
      );
    }
    if (activeView === "settings") {
      return (
        <div className="flex h-full items-center justify-center">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex h-10 items-center gap-2 rounded-lg bg-neutral-900 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-neutral-800"
          >
            <Settings className="h-4 w-4" />
            打开设置
          </button>
        </div>
      );
    }
    return (
      <Dashboard
        preferences={preferences}
        systemStatus={systemStatus}
        tasks={activeWorkspaceTasks}
        files={attachedFiles}
        catalogSkills={catalog.skills}
        prompt={prompt}
        setPrompt={setPrompt}
        onRunTask={runTask}
        onAttachFiles={() => void attachFiles("file")}
        onAttachDroppedFiles={attachDroppedFiles}
        onSelectFolder={selectFolder}
        onOpenTaskLog={() => setActiveView("tasks")}
        onShowToast={setToastMessage}
      />
    );
  })();

  return (
    <div className="theme-app theme-scope flex h-screen w-full">
      <AnimatePresence initial={false}>
        {sidebarVisible && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 256, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="h-full flex-shrink-0 overflow-hidden"
          >
            <Sidebar
              preferences={preferences}
              activeView={activeView}
              selectedTaskId={selectedTaskId}
              highlightedConversationId={sidebarHighlightedConversationId}
              highlightedStandaloneTaskId={sidebarHighlightedStandaloneTaskId}
              suppressConversationHighlight={pendingFreshConversationWorkspace === activeWorkspacePath}
              onChangeView={(view) => {
                setActiveView(view);
                if (view === "dashboard") {
                  setSelectedTaskId(null);
                }
              }}
              onToggleSidebar={() => setSidebarVisible(false)}
              tasks={tasks}
              onOpenSettings={() => setSettingsOpen(true)}
              onDeleteTask={deleteTask}
              onSelectTask={handleSelectTask}
              workspaces={workspaces}
              expandedWorkspaces={expandedWorkspaces}
              onToggleWorkspace={handleToggleWorkspace}
              onPinWorkspace={handlePinWorkspace}
              onRenameWorkspace={handleRenameWorkspace}
              onRemoveWorkspace={handleRemoveWorkspace}
              onNewConversation={handleNewConversation}
              onAddWorkspace={handleAddWorkspace}
              onCreateWorktree={handleOpenWorktreeModal}
              onArchiveWorkspace={(path, name) => void handleArchiveWorkspace(path, name)}
              onArchiveConversation={(cid) => void handleArchiveConversation(cid)}
              onShowToast={setToastMessage}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <main className="theme-main relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">{content}</div>
      </main>

      <AnimatePresence>
        <WorktreeModal
          state={worktreeModalState}
          creating={creatingWorktree}
          error={worktreeError}
          onClose={handleCloseWorktreeModal}
          onConfirm={(value) => void handleCreateWorktree(value)}
        />
      </AnimatePresence>

      <AnimatePresence>
        <SettingsModal
          open={settingsOpen}
          preferences={preferences}
          systemStatus={systemStatus}
          archivedConversations={archivedConversations}
          restoringConversationId={restoringConversationId}
          onClose={() => setSettingsOpen(false)}
          onSave={savePreferences}
          onChooseFolder={chooseFolder}
          onRestoreConversation={(conversationId) => void handleRestoreConversation(conversationId)}
        />
      </AnimatePresence>

      <AnimatePresence>
        {taskToDelete && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              className="w-[360px] rounded-2xl border border-black/5 bg-white p-6 shadow-[0_24px_64px_-12px_rgba(0,0,0,0.15)] flex flex-col gap-4"
            >
              <div className="flex items-center gap-3 text-red-600">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
                  <Trash2 className="h-5 w-5" strokeWidth={2} />
                </div>
                <h3 className="text-[16px] font-bold text-neutral-900">
                  {taskPendingDeletion?.conversationId ? "确认删除对话" : "确认删除任务"}
                </h3>
              </div>
              <p className="text-[13px] leading-relaxed text-neutral-500">
                {taskPendingDeletion?.conversationId
                  ? "确定要删除此对话吗？删除后将无法恢复这段对话下的全部任务记录和运行日志。"
                  : "确定要删除此任务吗？删除后将无法恢复该任务的对话记录和运行日志。"}
              </p>
              <div className="mt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTaskToDelete(null)}
                  className="rounded-lg bg-neutral-100 px-4 py-2 text-[13px] font-medium text-neutral-700 hover:bg-neutral-200 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  className="rounded-lg bg-red-500 px-4 py-2 text-[13px] font-medium text-white hover:bg-red-600 transition-colors cursor-pointer"
                >
                  删除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-black/5 bg-neutral-900/90 px-4 py-2 text-[12px] font-medium text-white shadow-xl backdrop-blur-md flex items-center gap-2"
          >
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
