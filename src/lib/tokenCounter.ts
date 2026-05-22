import type { ModelProfile } from "../types/electron";

// Lazy-loaded BPE tokenizer to keep initial bundle small.
// The gpt-tokenizer module (~2 MB) is loaded on-demand when first needed.

let _encode: ((text: string) => number[]) | null = null;
let _loadPromise: Promise<void> | null = null;

async function ensureEncoder(): Promise<(text: string) => number[]> {
  if (_encode) return _encode;
  if (!_loadPromise) {
    _loadPromise = import("gpt-tokenizer/encoding/cl100k_base").then((mod) => {
      _encode = mod.encode;
    });
  }
  await _loadPromise;
  return _encode!;
}

/**
 * Count tokens using the real BPE tokenizer (cl100k_base).
 * Falls back to a character estimate before the tokenizer is loaded.
 */
function countTokensSync(text: string | null | undefined): number {
  if (!text) return 0;
  if (_encode) {
    try {
      return _encode(text).length;
    } catch {
      return Math.ceil(text.length / 4);
    }
  }
  // Tokenizer not loaded yet — use rough estimate
  return Math.ceil(text.length / 4);
}

// Kick off loading immediately on first import
ensureEncoder();

/**
 * Compute a detailed token breakdown for a list of conversation turns.
 */
export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  contextLimit: number;
  remaining: number;
  estimatedCostUsd: number | null;
  costWarningLevel: "normal" | "elevated" | "high" | null;
  pricingSource: "custom" | "preset" | null;
}

interface ModelPreset {
  contextLimit: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachePricePerMillion?: number;
}

const MODEL_PRESETS: Record<string, ModelPreset> = {
  "claude-opus-4-6": { contextLimit: 200000 },
  "claude-3-5-sonnet": { contextLimit: 200000 },
  "claude-sonnet-4": { contextLimit: 200000 },
  "glm-5.1": { contextLimit: 200000 },
  "kimi-k2.6": { contextLimit: 256000 },
  "deepseek-v4-pro": { contextLimit: 1000000 },
  "deepseek-v4-flash": { contextLimit: 1000000 },
  "openai/gpt-oss-120b": { contextLimit: 131072 },
  "minimax-m2.7": { contextLimit: 204800 },
  "qwen3.5-397b-a17b": { contextLimit: 256000 },
  "mimo-v2.5": { contextLimit: 1000000 },
  "gpt-4o": { contextLimit: 128000 },
  "gpt-4": { contextLimit: 128000 },
  "gpt-4-turbo": { contextLimit: 128000 },
  "gpt-3.5-turbo": { contextLimit: 16384 },
};

export interface ResolvedModelConfig {
  contextLimit: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  cachePricePerMillion?: number;
  source: "custom" | "preset" | "fallback";
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function findPreset(model: string): ModelPreset | null {
  const lower = model.toLowerCase();
  if (MODEL_PRESETS[model]) return MODEL_PRESETS[model];
  if (MODEL_PRESETS[lower]) return MODEL_PRESETS[lower];
  for (const [key, preset] of Object.entries(MODEL_PRESETS)) {
    if (lower.includes(key)) return preset;
  }
  return null;
}

function findCustomProfile(model: string, modelProfiles: ModelProfile[] = []): ModelProfile | null {
  const lower = normalizeModelId(model);
  for (const profile of modelProfiles) {
    if (normalizeModelId(profile.modelId) === lower) return profile;
  }
  for (const profile of modelProfiles) {
    if (lower.includes(normalizeModelId(profile.modelId))) return profile;
  }
  return null;
}

export function resolveModelConfig(
  model: string,
  options?: {
    enableDeepSeek1M?: boolean;
    modelProfiles?: ModelProfile[];
  }
): ResolvedModelConfig {
  const lower = model.toLowerCase();
  const customProfile = findCustomProfile(model, options?.modelProfiles || []);
  const preset = findPreset(model);

  let contextLimit =
    customProfile?.contextLimit ||
    (options?.enableDeepSeek1M && lower.includes("deepseek") ? 1000000 : undefined) ||
    preset?.contextLimit ||
    128000;

  if (!Number.isFinite(contextLimit) || contextLimit <= 0) {
    contextLimit = 128000;
  }

  return {
    contextLimit,
    inputPricePerMillion: customProfile?.inputPricePerMillion ?? preset?.inputPricePerMillion,
    outputPricePerMillion: customProfile?.outputPricePerMillion ?? preset?.outputPricePerMillion,
    cachePricePerMillion: customProfile?.cachePricePerMillion ?? preset?.cachePricePerMillion,
    source: customProfile ? "custom" : preset ? "preset" : "fallback",
  };
}

export function getContextLimit(model: string, enableDeepSeek1M?: boolean, modelProfiles?: ModelProfile[]): number {
  return resolveModelConfig(model, { enableDeepSeek1M, modelProfiles }).contextLimit;
}

function estimateCostUsd(turnTokens: TurnTokens[], config: ResolvedModelConfig): number | null {
  const hasPricing =
    config.inputPricePerMillion !== undefined ||
    config.outputPricePerMillion !== undefined ||
    config.cachePricePerMillion !== undefined;
  if (!hasPricing) return null;

  let replayedPromptTokens = 0;
  let replayedAssistantTokens = 0;
  let totalInputCost = 0;
  let totalOutputCost = 0;
  let totalCacheCost = 0;

  turnTokens.forEach((turn) => {
    const freshPromptTokens = turn.promptTokens;
    const nonCacheInputTokens = freshPromptTokens + replayedAssistantTokens;

    totalInputCost += (nonCacheInputTokens / 1_000_000) * (config.inputPricePerMillion || 0);
    totalCacheCost += (replayedPromptTokens / 1_000_000) * (config.cachePricePerMillion || config.inputPricePerMillion || 0);
    totalOutputCost += (turn.outputTokens / 1_000_000) * (config.outputPricePerMillion || 0);

    replayedPromptTokens += turn.promptTokens;
    replayedAssistantTokens += turn.outputTokens;
  });

  return Math.max(0, totalInputCost + totalOutputCost + totalCacheCost);
}

function getCostWarningLevel(cost: number | null): TokenBreakdown["costWarningLevel"] {
  if (cost === null) return null;
  if (cost >= 5) return "high";
  if (cost >= 1) return "elevated";
  return "normal";
}

export interface TurnTokens {
  promptTokens: number;
  outputTokens: number;
}

/**
 * Count tokens for each turn using real BPE tokenizer (sync path).
 * On first render the tokenizer may not be loaded yet so we use a
 * character-based estimate; it self-corrects once the WASM loads.
 */
export function countTurnTokens(
  turns: Array<{ prompt?: string | null; output?: string | null }>
): TurnTokens[] {
  return turns.map((turn) => ({
    promptTokens: countTokensSync(turn.prompt),
    outputTokens: countTokensSync(turn.output),
  }));
}

/**
 * Aggregate per-turn counts into a full breakdown.
 * cacheTokens = prompt tokens from previous turns only; assistant
 * outputs are always billed as regular output tokens.
 */
export function computeTokenBreakdown(
  turnTokens: TurnTokens[],
  model: string,
  options?: {
    enableDeepSeek1M?: boolean;
    modelProfiles?: ModelProfile[];
  }
): TokenBreakdown {
  const config = resolveModelConfig(model, options);
  const contextLimit = config.contextLimit;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;

  turnTokens.forEach((t, i) => {
    inputTokens += t.promptTokens;
    outputTokens += t.outputTokens;
    if (i < turnTokens.length - 1) {
      cacheTokens += t.promptTokens;
    }
  });

  const totalTokens = inputTokens + outputTokens;
  const remaining = Math.max(0, contextLimit - totalTokens);
  const estimatedCostUsd = estimateCostUsd(turnTokens, config);

  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens,
    contextLimit,
    remaining,
    estimatedCostUsd,
    costWarningLevel: getCostWarningLevel(estimatedCostUsd),
    pricingSource:
      estimatedCostUsd === null
        ? null
        : config.source === "custom"
          ? "custom"
          : config.inputPricePerMillion !== undefined || config.outputPricePerMillion !== undefined || config.cachePricePerMillion !== undefined
            ? "preset"
            : null,
  };
}

/**
 * Utility: returns true once the real tokenizer is loaded.
 * Components can call this + re-render to switch from estimates to real counts.
 */
export function isTokenizerReady(): boolean {
  return _encode !== null;
}

/**
 * Wait for the tokenizer to finish loading.
 * Useful for triggering a one-time re-count after load.
 */
export async function waitForTokenizer(): Promise<void> {
  await ensureEncoder();
}
