const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("clawDesktop", {
  window: {
    close: () => ipcRenderer.invoke("window:close"),
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleFullscreen: () => ipcRenderer.invoke("window:toggle-fullscreen"),
  },
  system: {
    status: () => ipcRenderer.invoke("system:status"),
    revealPath: (path) => ipcRenderer.invoke("system:reveal-path", path),
  },
  preferences: {
    get: () => ipcRenderer.invoke("preferences:get"),
    save: (preferences) => ipcRenderer.invoke("preferences:save", preferences),
  },
  files: {
    selectFiles: (kind) => ipcRenderer.invoke("files:select", kind),
    selectFolder: () => ipcRenderer.invoke("files:select-folder"),
    fromDroppedFiles: (files) => {
      const paths = Array.from(files || [])
        .map((file) => webUtils.getPathForFile(file))
        .filter(Boolean);
      return ipcRenderer.invoke("files:from-paths", paths);
    },
  },
  workspace: {
    search: (payload) => ipcRenderer.invoke("workspace:search", payload),
    createWorktree: (payload) => ipcRenderer.invoke("workspace:create-worktree", payload),
  },
  catalog: {
    list: () => ipcRenderer.invoke("catalog:list"),
  },
  conversations: {
    listArchived: () => ipcRenderer.invoke("conversations:list-archived"),
    archive: (conversationId) => ipcRenderer.invoke("conversations:archive", conversationId),
    archiveWorkspace: (payload) => ipcRenderer.invoke("conversations:archive-workspace", payload),
    restore: (conversationId) => ipcRenderer.invoke("conversations:restore", conversationId),
  },
  tasks: {
    list: () => ipcRenderer.invoke("tasks:list"),
    run: (payload) => ipcRenderer.invoke("tasks:run", payload),
    cancel: (taskId) => ipcRenderer.invoke("tasks:cancel", taskId),
    clear: () => ipcRenderer.invoke("tasks:clear"),
    delete: (taskId) => ipcRenderer.invoke("tasks:delete", taskId),
    onEvent: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("tasks:event", handler);
      return () => ipcRenderer.off("tasks:event", handler);
    },
  },
  derived: {
    exportConversation: (payload) => ipcRenderer.invoke("derived:export-conversation", payload),
    generateSummary: (payload) => ipcRenderer.invoke("derived:generate-summary", payload),
    createSnapshot: (payload) => ipcRenderer.invoke("derived:create-snapshot", payload),
    shareContext: (payload) => ipcRenderer.invoke("derived:share-context", payload),
    branchTask: (payload) => ipcRenderer.invoke("derived:branch-task", payload),
    compareOutputs: (payload) => ipcRenderer.invoke("derived:compare-outputs", payload),
    extractInsights: (payload) => ipcRenderer.invoke("derived:extract-insights", payload),
    generateDocumentation: (payload) => ipcRenderer.invoke("derived:generate-documentation", payload),
  },
  speech: {
    transcribe: (payload) => ipcRenderer.invoke("speech:transcribe", payload),
  },
});
