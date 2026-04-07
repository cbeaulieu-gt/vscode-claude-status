import * as fs from 'fs/promises';
import { findAllJsonlFiles, calculateCost, TokenUsage } from './jsonlReader';

export type RecommendationKey = 'safe' | 'caution' | 'warning' | 'critical' | 'rate-limit-reached' | 'sonnet-limit-reached';

export interface PredictionData {
  estimatedExhaustionTime: Date | null  // null if pace is slow or unknown
  estimatedExhaustionIn: number | null  // seconds, null if safe/unknown
  currentBurnRate: number               // USD/hour (0 if < 2 entries in window)
  budgetRemaining: number | null        // null if no budget set
  budgetExhaustionTime: Date | null
  safeToStartHeavyTask: boolean
  recommendation: string        // English fallback (used by tests)
  recommendationKey: RecommendationKey  // i18n key for UI display
}

interface TimestampedCost {
  timestamp: number  // ms
  cost: number       // USD
  model: string      // e.g. 'claude-sonnet-4-6', empty if absent
}

async function readRecentCosts(windowMs: number): Promise<TimestampedCost[]> {
  const now = Date.now();
  const cutoff = now - windowMs;
  const result: TimestampedCost[] = [];

  const files = await findAllJsonlFiles();
  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          if (obj.type !== 'assistant' || typeof obj.timestamp !== 'string') { continue; }
          const ts = new Date(obj.timestamp).getTime();
          if (isNaN(ts) || ts < cutoff) { continue; }
          const msg = obj.message as { model?: string; usage?: Partial<TokenUsage> } | undefined;
          if (!msg?.usage) { continue; }
          const cost = calculateCost({
            input_tokens: msg.usage.input_tokens ?? 0,
            output_tokens: msg.usage.output_tokens ?? 0,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
          });
          if (cost > 0) {
            result.push({ timestamp: ts, cost, model: msg.model ?? '' });
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable files */ }
  }

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

export function calculateBurnRate(entries: ReadonlyArray<{ timestamp: number; cost: number }>): number {
  if (entries.length < 2) { return 0; }
  const totalCost = entries.reduce((sum, e) => sum + e.cost, 0);
  const spanMs = Date.now() - entries[0].timestamp;
  const spanHours = spanMs / (1000 * 3600);
  return spanHours > 0 ? totalCost / spanHours : 0;
}

export function buildRecommendation(exhaustionIn: number): string {
  if (exhaustionIn < 600)  { return 'Less than 10 min remaining. Save your work and pause.'; }
  if (exhaustionIn < 1800) { return 'Less than 30 min remaining. Wrap up current task.'; }
  if (exhaustionIn < 3600) { return 'About 1 hour remaining. Plan your next task accordingly.'; }
  return 'Plenty of capacity. Safe to start heavy tasks.';
}

export function buildRecommendationKey(exhaustionIn: number): RecommendationKey {
  if (exhaustionIn < 600)  { return 'critical'; }
  if (exhaustionIn < 1800) { return 'warning'; }
  if (exhaustionIn < 3600) { return 'caution'; }
  return 'safe';
}

/**
 * Estimate seconds until Sonnet-only 7d limit exhaustion.
 * Mirrors the existing 5h exhaustion pattern exactly.
 */
export function computeSonnetExhaustion(
  utilization7dSonnet: number,
  resetIn7dSonnet: number,
  costSonnet7d: number,
  sonnetBurnRate: number,
): number {
  if (utilization7dSonnet >= 1.0) { return 0; }
  if (utilization7dSonnet <= 0 || costSonnet7d <= 0 || sonnetBurnRate <= 0) { return Infinity; }

  const estimatedCapacityUsd = costSonnet7d / utilization7dSonnet;
  const remainingUsd = estimatedCapacityUsd * (1.0 - utilization7dSonnet);
  const hoursUntilExhaustion = remainingUsd / sonnetBurnRate;
  const secondsUntilExhaustion = hoursUntilExhaustion * 3600;

  return Math.min(secondsUntilExhaustion, resetIn7dSonnet);
}

export async function computePrediction(
  utilization5h: number,
  resetIn5h: number,
  cost5h: number,
  costToday: number,
  dailyBudget: number | null,
  utilization7dSonnet = 0,
  resetIn7dSonnet = 0,
  costSonnet7d = 0,
): Promise<PredictionData> {
  const allEntries = await readRecentCosts(30 * 60 * 1000);
  const sonnetEntries = allEntries.filter(e => e.model.toLowerCase().includes('sonnet'));

  const burnRateUsdPerHour = calculateBurnRate(allEntries);
  const sonnetBurnRate = calculateBurnRate(sonnetEntries);

  // --- Rate limit exhaustion (5h) ---
  let exhaustion5hSeconds = Infinity;

  if (utilization5h >= 1.0) {
    exhaustion5hSeconds = 0;
  } else if (burnRateUsdPerHour > 0 && utilization5h > 0) {
    const estimatedCapacityUsd = cost5h / utilization5h;
    const remainingUsd = estimatedCapacityUsd * (1.0 - utilization5h);
    const hoursUntilExhaustion = remainingUsd / burnRateUsdPerHour;
    exhaustion5hSeconds = Math.min(hoursUntilExhaustion * 3600, resetIn5h);
  }

  // --- Sonnet-only 7d exhaustion (mirrors 5h pattern) ---
  const exhaustionSonnetSeconds = computeSonnetExhaustion(
    utilization7dSonnet, resetIn7dSonnet, costSonnet7d, sonnetBurnRate,
  );

  // --- Pick the most restrictive exhaustion ---
  const effectiveSeconds = Math.min(exhaustion5hSeconds, exhaustionSonnetSeconds);

  let estimatedExhaustionTime: Date | null = null;
  let estimatedExhaustionIn: number | null = null;
  let safeToStartHeavyTask = true;
  let recommendation = 'Plenty of capacity. Safe to start heavy tasks.';
  let recommendationKey: RecommendationKey = 'safe';

  if (effectiveSeconds === 0) {
    estimatedExhaustionTime = new Date();
    estimatedExhaustionIn = 0;
    safeToStartHeavyTask = false;
    if (exhaustion5hSeconds === 0) {
      recommendation = 'Rate limit reached. Wait for reset.';
      recommendationKey = 'rate-limit-reached';
    } else {
      recommendation = 'Sonnet limit reached. Switch model or wait for reset.';
      recommendationKey = 'sonnet-limit-reached';
    }
  } else if (isFinite(effectiveSeconds)) {
    estimatedExhaustionTime = new Date(Date.now() + effectiveSeconds * 1000);
    estimatedExhaustionIn = effectiveSeconds;
    safeToStartHeavyTask = effectiveSeconds > 1800;
    recommendation = buildRecommendation(effectiveSeconds);
    recommendationKey = buildRecommendationKey(effectiveSeconds);
  }

  // --- Budget exhaustion ---
  let budgetRemaining: number | null = null;
  let budgetExhaustionTime: Date | null = null;

  if (dailyBudget !== null) {
    const remaining = dailyBudget - costToday;
    budgetRemaining = Math.max(0, remaining);
    if (remaining <= 0) {
      budgetExhaustionTime = new Date();
    } else if (burnRateUsdPerHour > 0) {
      const hoursUntil = remaining / burnRateUsdPerHour;
      budgetExhaustionTime = new Date(Date.now() + hoursUntil * 3600 * 1000);
    }
  }

  return {
    estimatedExhaustionTime,
    estimatedExhaustionIn,
    currentBurnRate: burnRateUsdPerHour,
    budgetRemaining,
    budgetExhaustionTime,
    safeToStartHeavyTask,
    recommendation,
    recommendationKey,
  };
}
