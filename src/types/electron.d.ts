export type ClawPermissionMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ModelProfile {
  modelId: string;
  contextLimit?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachePricePerMillion?: number;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
}

export type AttachmentKind = "file" | "image";

export interface PublicPreferences {
  clawPath: string;
  defaultModel: string;
  openaiBaseUrl: string;
  openaiCompatEnabled?: boolean;
  offlineSpeechEnabled?: boolean;
  offlineSpeechModel?: string;
  permissionMode: ClawPermissionMode;
  workspacePath: string;
  theme: "light" | "dark";
  language: "zh-CN" | "en-US";
  fontSize: number;
  autoSaveLogs: boolean;
  anthropicApiKeySet: boolean;
  anthropicAuthTokenSet: boolean;
  openaiApiKeySet: boolean;
  anthropicApiKeyHint?: string;
  anthropicAuthTokenHint?: string;
  openaiApiKeyHint?: string;
  enableDeepSeek1M: boolean;
  modelProfiles: ModelProfile[];
  saveSingleTurnInOnePlace?: boolean;
}

export interface PreferencesPatch extends Partial<PublicPreferences> {
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  openaiApiKey?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  stream: "stdout" | "stderr";
  chunk: string;
  createdAt: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "canceled";

export interface ClawTask {
  id: string;
  conversationId?: string | null;
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: ClawPermissionMode;
  files: AttachedFile[];
  status: TaskStatus;
  output: string;
  error: string;
  events: TaskEvent[];
  logPath?: string | null;
  sessionId?: string | null;
  sessionPath?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
}

export interface SystemStatus {
  clawFound: boolean;
  clawPath: string;
  bundledClawPath?: string;
  usingBundledClaw?: boolean;
  version: string;
  error: string;
  platform: string;
  userDataPath: string;
}

export interface WorkspaceSearchResult {
  path: string;
  name: string;
  line: number;
  preview: string;
}

export interface CreateWorktreePayload {
  sourcePath: string;
  name: string;
}

export interface CreateWorktreeResult {
  name: string;
  path: string;
  sourcePath: string;
  clonedTaskCount: number;
  clonedConversationCount: number;
  latestTaskId: string | null;
}

export interface ArchivedConversation {
  id: string;
  cwd: string;
  model: string;
  title: string;
  taskCount: number;
  archivedAt: string;
  archivedReason: string;
  createdAt: string;
  updatedAt: string;
  latestTaskId: string | null;
}

export interface ArchiveWorkspaceResult {
  archivedConversations: ArchivedConversation[];
  tasks: ClawTask[];
  archivedCount: number;
  taskCount: number;
}

export interface RestoreConversationResult {
  archivedConversations: ArchivedConversation[];
  tasks: ClawTask[];
  restoredTaskCount: number;
  latestTaskId: string | null;
}

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface LocalPlugin {
  id: string;
  name: string;
  description: string;
  path: string;
  provider: string;
  status: "installed" | "available";
  skillCount: number;
}

export interface LocalAutomation {
  id: string;
  name: string;
  path: string;
  kind: string;
  status: string;
  schedule: string;
  prompt: string;
}

export interface LocalCatalog {
  skills: LocalSkill[];
  plugins: LocalPlugin[];
  automations: LocalAutomation[];
  generatedAt: string;
}

export interface TaskRunPayload {
  prompt: string;
  conversationId?: string | null;
  forceFreshConversation?: boolean;
  cwd?: string;
  model?: string;
  permissionMode?: ClawPermissionMode;
  files?: AttachedFile[];
}

export interface TaskBusEvent {
  type: "task:updated" | "task:chunk" | "task:cleared";
  payload: ClawTask | TaskEvent | ClawTask[];
}

// Derived functionality types
export type DerivedFeatureKind = "export-conversation" | "generate-summary" | "create-snapshot" | "share-context" | "branch-task" | "compare-outputs" | "extract-insights" | "generate-documentation";

export interface ExportConversationPayload {
  taskId: string;
  format: "markdown" | "json" | "html";
  includeContext?: boolean;
  fileName?: string;
}

export interface ExportConversationResult {
  filePath: string;
  size: number;
  format: string;
  taskCount: number;
}

export interface GenerateSummaryPayload {
  taskId: string;
  conversationId?: string | null;
  model?: string;
  maxTokens?: number;
}

export interface GenerateSummaryResult {
  summary: string;
  keyPoints: string[];
  suggestedFollowUps: string[];
  generatedAt: string;
}

export interface CreateSnapshotPayload {
  taskId: string;
  snapshotName: string;
  description?: string;
  includeFiles?: boolean;
}

export interface CreateSnapshotResult {
  snapshotId: string;
  snapshotPath: string;
  taskCount: number;
  fileCount: number;
  createdAt: string;
}

export interface ShareContextPayload {
  taskId: string;
  format: "clipboard" | "file" | "url";
  includeOutput?: boolean;
  maxChars?: number;
}

export interface ShareContextResult {
  content?: string;
  filePath?: string;
  url?: string;
  size: number;
}

export interface BranchTaskPayload {
  sourceTaskId: string;
  branchName: string;
  startFromTurn?: number;
}

export interface BranchTaskResult {
  newTaskId: string;
  newConversationId?: string | null;
  taskPath: string;
  copiedTurns: number;
}

export interface CompareOutputsPayload {
  taskId1: string;
  taskId2: string;
  outputFormat?: "markdown" | "side-by-side" | "diff";
}

export interface CompareOutputsResult {
  comparison: string;
  similarities: string[];
  differences: string[];
  commonalityScore: number;
}

export interface ExtractInsightsPayload {
  taskId: string;
  conversationId?: string | null;
  model?: string;
  categories?: string[];
}

export interface ExtractInsightsResult {
  insights: Record<string, string[]>;
  patterns: string[];
  recommendations: string[];
  extractedAt: string;
}

export interface GenerateDocumentationPayload {
  taskId: string;
  style?: "technical" | "user-friendly" | "minimal";
  includeExamples?: boolean;
  outputFormat?: "markdown" | "html";
}

export interface GenerateDocumentationResult {
  documentation: string;
  sections: string[];
  wordCount: number;
  generatedAt: string;
}

export interface SpeechTranscribePayload {
  audioBase64: string;
  mimeType: string;
  fileName?: string;
  language?: string;
  prompt?: string;
}

export interface SpeechTranscribeResult {
  text: string;
  model: string;
  provider: string;
}

declare global {
  interface Window {
    clawDesktop: {
      window: {
        close: () => Promise<boolean>;
        minimize: () => Promise<boolean>;
        toggleFullscreen: () => Promise<boolean>;
      };
      system: {
        status: () => Promise<SystemStatus>;
        revealPath: (path: string) => Promise<boolean>;
      };
      preferences: {
        get: () => Promise<PublicPreferences>;
        save: (preferences: PreferencesPatch) => Promise<PublicPreferences>;
      };
      files: {
        selectFiles: (kind?: AttachmentKind) => Promise<AttachedFile[]>;
        selectFolder: () => Promise<string | null>;
        fromDroppedFiles: (files: File[] | FileList) => Promise<AttachedFile[]>;
      };
      workspace: {
        search: (payload: { query: string; cwd?: string }) => Promise<WorkspaceSearchResult[]>;
        createWorktree: (payload: CreateWorktreePayload) => Promise<CreateWorktreeResult>;
      };
      catalog: {
        list: () => Promise<LocalCatalog>;
      };
      conversations: {
        listArchived: () => Promise<ArchivedConversation[]>;
        archive: (conversationId: string) => Promise<ArchiveWorkspaceResult>;
        archiveWorkspace: (payload: { workspacePath: string }) => Promise<ArchiveWorkspaceResult>;
        restore: (conversationId: string) => Promise<RestoreConversationResult>;
      };
      tasks: {
        list: () => Promise<ClawTask[]>;
        run: (payload: TaskRunPayload) => Promise<ClawTask>;
        cancel: (taskId: string) => Promise<boolean>;
        clear: () => Promise<ClawTask[]>;
        delete: (taskId: string) => Promise<ClawTask[]>;
        onEvent: (callback: (event: TaskBusEvent) => void) => () => void;
      };
      derived: {
        exportConversation: (payload: ExportConversationPayload) => Promise<ExportConversationResult>;
        generateSummary: (payload: GenerateSummaryPayload) => Promise<GenerateSummaryResult>;
        createSnapshot: (payload: CreateSnapshotPayload) => Promise<CreateSnapshotResult>;
        shareContext: (payload: ShareContextPayload) => Promise<ShareContextResult>;
        branchTask: (payload: BranchTaskPayload) => Promise<BranchTaskResult>;
        compareOutputs: (payload: CompareOutputsPayload) => Promise<CompareOutputsResult>;
        extractInsights: (payload: ExtractInsightsPayload) => Promise<ExtractInsightsResult>;
        generateDocumentation: (payload: GenerateDocumentationPayload) => Promise<GenerateDocumentationResult>;
      };
      speech: {
        transcribe: (payload: SpeechTranscribePayload) => Promise<SpeechTranscribeResult>;
      };
    };
  }
}
