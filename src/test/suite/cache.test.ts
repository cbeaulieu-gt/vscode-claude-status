import * as assert from 'assert';
import { isCacheValid, getCacheAge } from '../../data/cache';

// Minimal CacheFile shape for testing (without importing private type)
interface TestCacheFile {
  version: 2 | 3
  updatedAt: string
  usageData: {
    utilization5h: number
    utilization7d: number
    utilization7dSonnet?: number
    reset5hAt: number
    reset7dAt: number
    reset7dSonnetAt?: number
    limitStatus: string
  }
}

function makeCache(ageSeconds: number, version: 2 | 3 = 3): TestCacheFile {
  const updatedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  const nowSec = Date.now() / 1000;
  const base: TestCacheFile = {
    version,
    updatedAt,
    usageData: {
      utilization5h: 0.5,
      utilization7d: 0.3,
      reset5hAt: nowSec + 1800,
      reset7dAt: nowSec + 86400,
      limitStatus: 'allowed',
    },
  };
  if (version === 3) {
    base.usageData.utilization7dSonnet = 0.6;
    base.usageData.reset7dSonnetAt = nowSec + 172800;
  }
  return base;
}

suite('Cache', () => {
  test('isCacheValid returns true when cache is fresh', () => {
    const cache = makeCache(100) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), true);
  });

  test('isCacheValid returns false when cache is stale', () => {
    const cache = makeCache(400) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), false);
  });

  test('isCacheValid returns false exactly at boundary', () => {
    const cache = makeCache(300) as Parameters<typeof isCacheValid>[0];
    assert.strictEqual(isCacheValid(cache, 300), false);
  });

  test('getCacheAge returns approximate age in seconds', () => {
    const cache = makeCache(120) as Parameters<typeof getCacheAge>[0];
    const age = getCacheAge(cache);
    assert.ok(age >= 119 && age <= 125, `Expected ~120s, got ${age}`);
  });

  test('v3 cache includes Sonnet fields', () => {
    const cache = makeCache(100, 3);
    assert.strictEqual(cache.version, 3);
    assert.strictEqual(cache.usageData.utilization7dSonnet, 0.6);
    assert.ok((cache.usageData.reset7dSonnetAt ?? 0) > 0);
  });

  test('v2 cache defaults Sonnet fields to zero', () => {
    const cache = makeCache(100, 2);
    assert.strictEqual(cache.usageData.utilization7dSonnet, undefined);
    assert.strictEqual(cache.usageData.reset7dSonnetAt, undefined);
    // Consumers should default undefined to 0
    assert.strictEqual(cache.usageData.utilization7dSonnet ?? 0, 0);
    assert.strictEqual(cache.usageData.reset7dSonnetAt ?? 0, 0);
  });
});
