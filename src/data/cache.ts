import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RateLimitData } from './apiClient';

interface CacheFile {
  version: 2 | 3
  updatedAt: string
  usageData: {
    utilization5h: number
    utilization7d: number
    utilization7dSonnet?: number   // Added in v3; absent in v2
    // Unix timestamps in seconds (absolute, not relative) so that remaining
    // time can be recalculated correctly after reading a stale cache entry.
    reset5hAt: number
    reset7dAt: number
    reset7dSonnetAt?: number       // Added in v3; absent in v2
    limitStatus: string
  }
}

function getCachePath(): string {
  return path.join(os.homedir(), '.claude', 'vscode-claude-status-cache.json');
}

export async function readCache(): Promise<CacheFile | null> {
  try {
    const content = await fs.readFile(getCachePath(), 'utf-8');
    const parsed = JSON.parse(content) as CacheFile;
    // Accept v2 (legacy) and v3 (with Sonnet fields); reject v1
    if (parsed.version !== 2 && parsed.version !== 3) { return null; }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCache(data: RateLimitData): Promise<void> {
  const nowSec = Date.now() / 1000;
  const cache: CacheFile = {
    version: 3,
    updatedAt: new Date().toISOString(),
    usageData: {
      utilization5h: data.utilization5h,
      utilization7d: data.utilization7d,
      utilization7dSonnet: data.utilization7dSonnet,
      reset5hAt: nowSec + data.resetIn5h,
      reset7dAt: nowSec + data.resetIn7d,
      reset7dSonnetAt: nowSec + data.resetIn7dSonnet,
      limitStatus: data.limitStatus,
    },
  };
  try {
    await fs.writeFile(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // ignore write failures (e.g. read-only FS)
  }
}

export function isCacheValid(cache: CacheFile, ttlSeconds: number): boolean {
  const age = (Date.now() - new Date(cache.updatedAt).getTime()) / 1000;
  return age < ttlSeconds;
}

export function getCacheAge(cache: CacheFile): number {
  return (Date.now() - new Date(cache.updatedAt).getTime()) / 1000;
}
