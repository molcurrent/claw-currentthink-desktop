import type { ClawTask, TaskStatus } from "../types/electron";

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

export function formatTime(dateString?: string | null) {
  if (!dateString) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(dateString));
}

export function taskDuration(task: ClawTask) {
  if (!task.startedAt) return "-";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const start = new Date(task.startedAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function statusLabel(status: TaskStatus) {
  const labels: Record<TaskStatus, string> = {
    pending: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    canceled: "已取消",
  };
  return labels[status];
}

export function statusClass(status: TaskStatus) {
  const classes: Record<TaskStatus, string> = {
    pending: "bg-neutral-100 text-neutral-600 border-black/5",
    running: "bg-blue-50 text-blue-700 border-blue-100",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-100",
    failed: "bg-red-50 text-red-700 border-red-100",
    canceled: "bg-amber-50 text-amber-700 border-amber-100",
  };
  return classes[status];
}
