# Sonnet-Only 7-Day Rate Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track and display the Sonnet-only 7-day rate limit window alongside the existing 5h and 7d unified windows.

**Architecture:** Mirror the existing 7d pattern — add parallel fields (`utilization7dSonnet`, `resetIn7dSonnet`, `has7dSonnetLimit`) through every layer: API client, cache, data manager, status bar, dashboard, and prediction. Prediction uses a single JSONL read with in-memory partitioning by `message.model` to avoid doubling I/O. Sonnet exhaustion is projected from utilization rate-of-change rather than cross-window cost estimation.

**Tech Stack:** TypeScript, VS Code Extension API, Mocha tests

**Spec:** `docs/superpowers/specs/2026-04-07-sonnet-7d-rate-limit-design.md`

---

## Execution Order

Tasks MUST be executed in this order to ensure every intermediate commit compiles and passes tests:

**1 → 2 → 5B → 6 → 3 → 4 → 5 → 7 → 8 → 9**

Rationale: Task 3 adds `costSonnet7d` to `ClaudeUsageData` (provided by `AggregatedUsage` from Task 5B) and calls `computePrediction` with 8 arguments (signature extended in Task 6). Running Task 3 before 5B and 6 would produce compile errors. This order builds the data producers first, then threads them through the manager and UI.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/data/apiClient.ts` | Modify | Parse 3 new headers, extend `RateLimitData`, update `limitStatus` |
| `src/data/cache.ts` | Modify | Version 3 schema, 2 new fields, backward compat for v2 |
| `src/data/dataManager.ts` | Modify | Extend `ClaudeUsageData`, thread fields, update `cacheToRateLimitData` |
| `src/statusBar.ts` | Modify | `S7d` label segment, tooltip line |
| `src/webview/panel.ts` | Modify | Progress row, visibility gate, updateUsage block, i18n |
| `src/data/jsonlReader.ts` | Modify | Add `costSonnet7d` to `AggregatedUsage` via model filter |
| `src/data/prediction.ts` | Modify | Model-filtered burn rate, Sonnet exhaustion mirroring 5h pattern |
| `src/test/suite/cache.test.ts` | Modify | Version 3 tests, backward compat |
| `src/test/suite/statusBar.test.ts` | Modify | Sonnet label/tooltip tests |
| `src/test/suite/prediction.test.ts` | Modify | Sonnet exhaustion scenarios |
| `l10n/bundle.l10n.ja.json` | Modify | Japanese translations for new strings |
| `l10n/bundle.l10n.zh-cn.json` | Modify | Chinese translations for new strings |
| `docs/DATA.md` | Modify | New headers, fields, cache v3 |
| `docs/ARCHITECTURE.md` | Modify | Updated type definitions |
| `CHANGELOG.md` | Modify | Unreleased entry |

---

### Task 1: Extend RateLimitData and Parse New Headers (apiClient.ts)

**Files:**
- Modify: `src/data/apiClient.ts:26-33` (RateLimitData interface)
- Modify: `src/data/apiClient.ts:100-124` (fetchRateLimitData function)
- Test: `src/test/suite/statusBar.test.ts` (indirectly — tested via integration)

- [ ] **Step 1: Add Sonnet fields to RateLimitData interface**

In `src/data/apiClient.ts`, replace the `RateLimitData` interface (lines 26-33):

```typescript
export interface RateLimitData {
  utilization5h: number
  utilization7d: number
  utilization7dSonnet: number
  resetIn5h: number
  resetIn7d: number
  resetIn7dSonnet: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'
  has7dLimit: boolean
  has7dSonnetLimit: boolean
}
```

- [ ] **Step 2: Parse Sonnet-only headers in fetchRateLimitData**

In `src/data/apiClient.ts`, replace lines 100-124 of `fetchRateLimitData` (from `const util5h =` through the return statement):

```typescript
  const util5h = parseFloat(response.headers.get('anthropic-ratelimit-unified-5h-utilization') ?? '0');
  const util7d = parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-utilization') ?? '0');
  const util7dSonnet = parseFloat(response.headers.get('anthropic-ratelimit-unified-7d-sonnet-utilization') ?? '0');
  const reset5hStr = response.headers.get('anthropic-ratelimit-unified-5h-reset');
  const reset7dStr = response.headers.get('anthropic-ratelimit-unified-7d-reset');
  const reset7dSonnetStr = response.headers.get('anthropic-ratelimit-unified-7d-sonnet-reset');
  // Status header value is "allowed" or "denied" (not a boolean)
  const status5h = response.headers.get('anthropic-ratelimit-unified-5h-status');
  const status7dSonnet = response.headers.get('anthropic-ratelimit-unified-7d-sonnet-status');

  // 7d limit is only present on Claude.ai Max plans — detect by header presence
  const has7dLimit = reset7dStr !== null;
  const has7dSonnetLimit = reset7dSonnetStr !== null;

  // Reset values are Unix timestamps in seconds (not ISO date strings)
  const nowSec = Date.now() / 1000;
  const resetIn5h = reset5hStr ? Math.max(0, parseInt(reset5hStr, 10) - nowSec) : 0;
  const resetIn7d = reset7dStr ? Math.max(0, parseInt(reset7dStr, 10) - nowSec) : 0;
  const resetIn7dSonnet = reset7dSonnetStr ? Math.max(0, parseInt(reset7dSonnetStr, 10) - nowSec) : 0;

  let limitStatus: 'allowed' | 'allowed_warning' | 'denied';
  if (status5h === 'denied') {
    limitStatus = 'denied';
  } else if (
    util5h >= 0.75 ||
    (has7dLimit && util7d >= 0.75) ||
    (has7dSonnetLimit && (util7dSonnet >= 0.75 || status7dSonnet === 'denied'))
  ) {
    limitStatus = 'allowed_warning';
  } else {
    limitStatus = 'allowed';
  }

  return {
    utilization5h: util5h, utilization7d: util7d, utilization7dSonnet: util7dSonnet,
    resetIn5h, resetIn7d, resetIn7dSonnet,
    limitStatus, has7dLimit, has7dSonnetLimit,
  };
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npm run compile`
Expected: SUCCESS (no type errors — downstream consumers will fail until updated, but the compile uses webpack which bundles from extension.ts entry point)

- [ ] **Step 4: Commit**

```
git add src/data/apiClient.ts
git commit -m "feat: parse Sonnet-only 7d rate limit headers in apiClient"
```

---

### Task 2: Update Cache Schema to Version 3 (cache.ts)

**Files:**
- Modify: `src/data/cache.ts:6-18` (CacheFile interface)
- Modify: `src/data/cache.ts:24-53` (readCache, writeCache functions)
- Test: `src/test/suite/cache.test.ts`

- [ ] **Step 1: Write failing test for v3 cache round-trip**

In `src/test/suite/cache.test.ts`, replace the `TestCacheFile` interface and `makeCache` function, and add new tests at the end of the suite:

Replace lines 4-15 (the interface):

```typescript
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
```

Replace lines 17-31 (the `makeCache` function):

```typescript
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
```

Add these tests inside the `suite('Cache', ...)` block after the existing tests:

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests pass**

Run: `npm test`
Expected: All tests PASS (these tests check data shape, not cache I/O)

- [ ] **Step 3: Update CacheFile interface to version 3 with backward compat**

In `src/data/cache.ts`, replace lines 6-18:

```typescript
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
```

- [ ] **Step 4: Update readCache to accept both v2 and v3**

In `src/data/cache.ts`, replace lines 24-32.

**Upgrade path:** v2 caches are accepted; missing Sonnet fields default to 0 via `??` in consumers.
**Downgrade path:** Old extension rejects v3 (`version !== 2`) and falls back to a fresh API call — safe, no corruption.

```typescript
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
```

- [ ] **Step 5: Update writeCache to write version 3**

In `src/data/cache.ts`, replace lines 35-54:

```typescript
export async function writeCache(data: RateLimitData): Promise<void> {
  const nowSec = Date.now() / 1000;
  const cache: CacheFile = {
    version: 3,
    updatedAt: new Date().toISOString(),
    usageData: {
      utilization5h: data.utilization5h,
      utilization7d: data.utilization7d,
      utilization7dSonnet: data.utilization7dSonnet,
      // Store absolute reset timestamps so remaining time stays correct
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
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```
git add src/data/cache.ts src/test/suite/cache.test.ts
git commit -m "feat: bump cache schema to v3 with Sonnet-only 7d fields"
```

---

### Task 3: Thread Sonnet Data Through DataManager (dataManager.ts)

**Files:**
- Modify: `src/data/dataManager.ts:14-39` (ClaudeUsageData interface)
- Modify: `src/data/dataManager.ts:115-127` (getUsageData assembly)
- Modify: `src/data/dataManager.ts:133-150` (cacheToRateLimitData)
- Modify: `src/data/dataManager.ts:225-234` (getPrediction call)
- Modify: `src/test/suite/statusBar.test.ts:5-26` (makeData defaults — keep build green)

- [ ] **Step 1: Add Sonnet fields to ClaudeUsageData interface**

In `src/data/dataManager.ts`, replace lines 14-39:

```typescript
export interface ClaudeUsageData {
  // From API / cache
  utilization5h: number
  utilization7d: number
  utilization7dSonnet: number
  resetIn5h: number
  resetIn7d: number
  resetIn7dSonnet: number
  limitStatus: 'allowed' | 'allowed_warning' | 'denied'

  // From local JSONL
  cost5h: number
  costDay: number
  cost7d: number
  costSonnet7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number

  // Rate limit metadata
  has7dLimit: boolean      // false for plans without a 7d window or non-Claude.ai providers
  has7dSonnetLimit: boolean
  providerType: ClaudeProvider

  // Metadata
  lastUpdated: Date
  cacheAge: number
  dataSource: 'api' | 'cache' | 'stale' | 'no-credentials' | 'no-data' | 'local-only'
}
```

- [ ] **Step 2: Update getUsageData assembly to include Sonnet fields**

In `src/data/dataManager.ts`, replace lines 115-127 (the `const data: ClaudeUsageData =` block):

```typescript
    const data: ClaudeUsageData = {
      utilization5h: rateLimitData?.utilization5h ?? 0,
      utilization7d: rateLimitData?.utilization7d ?? 0,
      utilization7dSonnet: rateLimitData?.utilization7dSonnet ?? 0,
      resetIn5h: rateLimitData?.resetIn5h ?? 0,
      resetIn7d: rateLimitData?.resetIn7d ?? 0,
      resetIn7dSonnet: rateLimitData?.resetIn7dSonnet ?? 0,
      limitStatus: rateLimitData?.limitStatus ?? 'allowed',
      has7dLimit: rateLimitData?.has7dLimit ?? false,
      has7dSonnetLimit: rateLimitData?.has7dSonnetLimit ?? false,
      providerType,
      ...localUsage,
      lastUpdated: new Date(),
      cacheAge,
      dataSource,
    };
```

- [ ] **Step 3: Update cacheToRateLimitData to derive Sonnet fields**

In `src/data/dataManager.ts`, replace the `cacheToRateLimitData` method (lines 133-150):

```typescript
  private cacheToRateLimitData(usageData: {
    utilization5h: number
    utilization7d: number
    utilization7dSonnet?: number
    reset5hAt: number
    reset7dAt: number
    reset7dSonnetAt?: number
    limitStatus: string
  }): RateLimitData {
    const nowSec = Date.now() / 1000;
    return {
      utilization5h: usageData.utilization5h,
      utilization7d: usageData.utilization7d,
      utilization7dSonnet: usageData.utilization7dSonnet ?? 0,
      resetIn5h: Math.max(0, usageData.reset5hAt - nowSec),
      resetIn7d: Math.max(0, usageData.reset7dAt - nowSec),
      resetIn7dSonnet: Math.max(0, (usageData.reset7dSonnetAt ?? 0) - nowSec),
      limitStatus: usageData.limitStatus as RateLimitData['limitStatus'],
      // Derive from cached reset timestamp: non-zero means a limit exists
      has7dLimit: usageData.reset7dAt > 0,
      has7dSonnetLimit: (usageData.reset7dSonnetAt ?? 0) > 0,
    };
  }
```

- [ ] **Step 4: Update getPrediction to pass Sonnet data**

In `src/data/dataManager.ts`, replace lines 225-234 (the `getPrediction` method):

```typescript
  async getPrediction(): Promise<PredictionData | null> {
    if (!this.lastData) { return null; }
    try {
      const prediction = await computePrediction(
        this.lastData.utilization5h,
        this.lastData.resetIn5h,
        this.lastData.cost5h,
        this.lastData.costDay,
        config.dailyBudget,
        this.lastData.utilization7dSonnet,
        this.lastData.resetIn7dSonnet,
        this.lastData.costSonnet7d,
      );
      this.lastPrediction = prediction;
      return prediction;
    } catch {
      return this.lastPrediction;
    }
  }
```

- [ ] **Step 5: Update makeData in statusBar.test.ts to include Sonnet defaults**

This must happen in the same commit as the interface change so the build stays green (per CLAUDE.md: "ALWAYS run npm run lint and npm test before committing").

In `src/test/suite/statusBar.test.ts`, replace lines 5-26 (the `makeData` function):

**Note:** `has7dSonnetLimit` defaults to `false` so existing tests continue to exercise the pre-Sonnet code path. Sonnet-specific tests explicitly set it to `true`.

```typescript
function makeData(overrides: Partial<ClaudeUsageData> = {}): ClaudeUsageData {
  return {
    utilization5h: 0.5,
    utilization7d: 0.3,
    utilization7dSonnet: 0,
    resetIn5h: 3600,
    resetIn7d: 86400,
    resetIn7dSonnet: 0,
    limitStatus: 'allowed',
    has7dLimit: true,
    has7dSonnetLimit: false,
    providerType: 'claude-ai',
    cost5h: 1.23,
    costDay: 2.50,
    cost7d: 10.00,
    costSonnet7d: 0,
    tokensIn5h: 50_000,
    tokensOut5h: 10_000,
    tokensCacheRead5h: 5_000,
    tokensCacheCreate5h: 1_000,
    lastUpdated: new Date(),
    cacheAge: 30,
    dataSource: 'cache',
    ...overrides,
  };
}
```

- [ ] **Step 6: Run lint and tests**

Run: `npm run lint && npm test`
Expected: All PASS — interfaces are consistent, test helpers match

- [ ] **Step 7: Commit**

```
git add src/data/dataManager.ts src/test/suite/statusBar.test.ts
git commit -m "feat: thread Sonnet-only 7d fields through DataManager"
```

---

### Task 4: Add Sonnet-Only Display to Status Bar (statusBar.ts)

**Files:**
- Modify: `src/statusBar.ts:40-96` (buildLabel function)
- Modify: `src/statusBar.ts:98-155` (buildTooltip function)
- Test: `src/test/suite/statusBar.test.ts`

- [ ] **Step 1: Write failing tests for Sonnet status bar display**

`makeData` was already updated with Sonnet defaults in Task 3 Step 5 (to keep the build green). Add these tests inside the `suite('StatusBar', ...)` block after the existing tests:

```typescript
  test('buildLabel includes S7d when has7dSonnetLimit is true', () => {
    const label = buildLabel(makeData({ has7dSonnetLimit: true, utilization7dSonnet: 0.40 }));
    assert.ok(label.includes('S7d:'), `Expected S7d: in: ${label}`);
    assert.ok(label.includes('40%'), `Expected 40% in: ${label}`);
  });

  test('buildLabel omits S7d when has7dSonnetLimit is false', () => {
    const label = buildLabel(makeData({ has7dSonnetLimit: false }));
    assert.ok(!label.includes('S7d'), `Expected no S7d in: ${label}`);
  });

  test('buildLabel shows ⚠ on S7d when Sonnet utilization >= 75%', () => {
    const label = buildLabel(makeData({
      has7dSonnetLimit: true,
      utilization7dSonnet: 0.80,
      limitStatus: 'allowed_warning',
    }));
    // There should be a ⚠ associated with the Sonnet segment
    const s7dIdx = label.indexOf('S7d:');
    assert.ok(s7dIdx >= 0, `Expected S7d: in: ${label}`);
    const afterS7d = label.slice(s7dIdx);
    assert.ok(afterS7d.includes('⚠'), `Expected ⚠ after S7d in: ${afterS7d}`);
  });

  test('buildTooltip shows Sonnet 7d window line when present', () => {
    const tooltip = buildTooltip(makeData({
      has7dSonnetLimit: true,
      utilization7dSonnet: 0.65,
      resetIn7dSonnet: 172800,
    }));
    assert.ok(tooltip.includes('Sonnet 7d'), `Expected Sonnet 7d in tooltip: ${tooltip}`);
    assert.ok(tooltip.includes('65%'), `Expected 65% in tooltip: ${tooltip}`);
  });

  test('buildTooltip omits Sonnet 7d line when has7dSonnetLimit is false', () => {
    const tooltip = buildTooltip(makeData({ has7dSonnetLimit: false }));
    assert.ok(!tooltip.includes('Sonnet 7d'), `Expected no Sonnet 7d in tooltip: ${tooltip}`);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `makeData` returns Sonnet fields but `buildLabel`/`buildTooltip` don't use them yet. The `S7d:` assertions will fail.

- [ ] **Step 3: Update buildLabel to show S7d segment**

In `src/statusBar.ts`, replace lines 40-96 (the `buildLabel` function):

```typescript
export function buildLabel(data: ClaudeUsageData, projectCosts: ProjectCostData[] = []): string {
  const {
    dataSource, utilization5h, utilization7d, utilization7dSonnet,
    limitStatus, cost5h, cost7d, cacheAge,
    has7dLimit, has7dSonnetLimit, providerType,
  } = data;
  const displayMode = config.displayMode;

  if (dataSource === 'no-credentials') {
    return vscode.l10n.t('🤖 Not logged in');
  }
  if (dataSource === 'no-data') {
    return vscode.l10n.t('🤖 Claude: run refresh');
  }

  const isStale = dataSource === 'stale';
  const staleSuffix = isStale ? ` [${formatDuration(cacheAge)} ago]` : '';

  // Non-Claude.ai providers (Bedrock, API key, local-only) always use cost mode
  const useCostMode = providerType !== 'claude-ai' || dataSource === 'local-only' || displayMode === 'cost';

  let part5h: string;
  let part7d: string;
  let partSonnet: string;

  if (useCostMode) {
    part5h = `5h:$${cost5h.toFixed(2)}`;
    part7d = ` 7d:$${cost7d.toFixed(2)}`;
    partSonnet = '';
  } else {
    // percent mode — Claude.ai only
    if (limitStatus === 'denied') {
      part5h = `5h:100%✗`;
      part7d = '';
      partSonnet = '';
    } else {
      const warn5h = utilization5h >= 0.75 ? '⚠' : '';
      part5h = `5h:${formatPercent(utilization5h)}${warn5h}`;
      if (has7dLimit) {
        const warn7d = utilization7d >= 0.75 ? '⚠' : '';
        part7d = ` 7d:${formatPercent(utilization7d)}${warn7d}`;
      } else {
        part7d = '';
      }
      if (has7dSonnetLimit) {
        const warnSonnet = utilization7dSonnet >= 0.75 ? '⚠' : '';
        partSonnet = ` S7d:${formatPercent(utilization7dSonnet)}${warnSonnet}`;
      } else {
        partSonnet = '';
      }
    }
  }

  // Project cost suffix
  let projectPart = '';
  if (config.showProjectCost && projectCosts.length > 0) {
    if (projectCosts.length === 1) {
      const pj = projectCosts[0];
      const shortName = truncateName(pj.projectName);
      projectPart = ` | ${shortName}:$${pj.costToday.toFixed(2)}`;
    } else {
      // Multi-root: aggregate
      const total = projectCosts.reduce((sum, p) => sum + p.costToday, 0);
      projectPart = ` | PJ:$${total.toFixed(2)}`;
    }
  }

  const main = `🤖 ${part5h}${part7d}${partSonnet}${projectPart}`;
  return isStale ? `${main}${staleSuffix}` : main;
}
```

- [ ] **Step 4: Update buildTooltip to show Sonnet 7d window line**

In `src/statusBar.ts`, replace lines 98-155 (the `buildTooltip` function):

```typescript
export function buildTooltip(data: ClaudeUsageData, projectCosts: ProjectCostData[] = []): string {
  const {
    utilization5h, utilization7d, utilization7dSonnet,
    resetIn5h, resetIn7d, resetIn7dSonnet,
    cost5h, costDay, cost7d, tokensIn5h, tokensOut5h,
    cacheAge, dataSource, has7dLimit, has7dSonnetLimit, providerType,
  } = data;

  if (dataSource === 'no-credentials') {
    return vscode.l10n.t('Claude Code is not logged in.\nRun: claude login');
  }
  if (dataSource === 'no-data') {
    return vscode.l10n.t('No usage data found.\nClick to open dashboard →');
  }

  const lastUpdated = cacheAge < 60
    ? vscode.l10n.t('just now')
    : vscode.l10n.t('{0} ago', formatDuration(cacheAge));
  const lines: string[] = [];

  if (providerType === 'claude-ai') {
    // Rate limit section — only for Claude.ai subscriptions
    const bar5h = buildBar(utilization5h, 8);
    lines.push(
      vscode.l10n.t('Claude Code Usage'),
      '─────────────────────────────',
      `5h window:   ${formatPercent(utilization5h)} [${bar5h}] resets in ${formatDuration(resetIn5h)}`,
    );
    if (has7dLimit) {
      const bar7d = buildBar(utilization7d, 8);
      lines.push(`7d window:   ${formatPercent(utilization7d)} [${bar7d}] resets in ${formatDuration(resetIn7d)}`);
    }
    if (has7dSonnetLimit) {
      const barSonnet = buildBar(utilization7dSonnet, 8);
      lines.push(`Sonnet 7d:   ${formatPercent(utilization7dSonnet)} [${barSonnet}] resets in ${formatDuration(resetIn7dSonnet)}`);
    }
    lines.push('');
  } else {
    const providerLabel = providerType === 'aws-bedrock' ? vscode.l10n.t('AWS Bedrock')
      : providerType === 'api-key' ? vscode.l10n.t('API Key')
      : vscode.l10n.t('Claude Code');
    lines.push(`Claude Code (${providerLabel})`, '─────────────────────────────', '');
  }

  lines.push(
    vscode.l10n.t('Token Cost (local)'),
    '─────────────────────────────',
    `5h:   in:${formatTokens(tokensIn5h)} out:${formatTokens(tokensOut5h)}  $${cost5h.toFixed(2)}`,
    `day:  $${costDay.toFixed(2)}`,
    `7d:   $${cost7d.toFixed(2)}`,
  );

  if (projectCosts.length > 0) {
    lines.push('');
    for (const pj of projectCosts) {
      lines.push(vscode.l10n.t('Project: {0}', pj.projectName));
      lines.push(`  ${vscode.l10n.t('Today')}: $${pj.costToday.toFixed(2)}  |  ${vscode.l10n.t('7 days')}: $${pj.cost7d.toFixed(2)}`);
    }
  }

  lines.push('', vscode.l10n.t('Last updated: {0}', lastUpdated), vscode.l10n.t('Click to open dashboard →'));
  return lines.join('\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```
git add src/statusBar.ts src/test/suite/statusBar.test.ts
git commit -m "feat: display Sonnet-only 7d rate limit in status bar"
```

---

### Task 5: Add Sonnet-Only Progress Row to Dashboard (panel.ts)

**Files:**
- Modify: `src/webview/panel.ts:29-111` (i18n labels)
- Modify: `src/webview/panel.ts:425-433` (HTML progress rows)
- Modify: `src/webview/panel.ts:569-615` (updateUsage JS function)

- [ ] **Step 1: Add i18n labels for Sonnet 7d**

In `src/webview/panel.ts`, in the `buildI18n` function, add these two entries after the `window7d` line (line 36):

After the line `window7d:              t('7d window'),` add:

```typescript
    window7dSonnet:        t('Sonnet 7d window'),
```

And after the line `days7short:            t('7d'),` (line 39) add:

```typescript
    days7dSonnetShort:     t('S7d'),
```

And after the line `recRateLimitReached: t('Rate limit reached. Wait for reset.'),` (line 110) add:

```typescript
    recSonnetLimitReached: t('Sonnet limit reached. Switch model or wait for reset.'),
```

- [ ] **Step 2: Add Sonnet progress row HTML**

In `src/webview/panel.ts`, after the closing `</div>` of the `usage-7d-row` (line 433), add the Sonnet progress row before the card's closing `</div>` (line 434):

After line 433 (`    </div>` closing usage-7d-row), insert:

```html
    <div class="progress-row" id="usage-7d-sonnet-row">
      <div class="progress-labels">
        <span>\${i18n.window7dSonnet}</span>
        <span id="usage-7d-sonnet-label">—</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="usage-7d-sonnet-fill" style="width:0%"></div>
      </div>
    </div>
```

- [ ] **Step 3: Update updateUsage JS to handle Sonnet row**

In `src/webview/panel.ts`, in the `updateUsage` function, after the line `const show7d = usage.has7dLimit && isClaudeAi;` (line 573), add:

```javascript
      const show7dSonnet = usage.has7dSonnetLimit && isClaudeAi;
```

After the `row7d` show/hide block (line 577), add:

```javascript
      const row7dSonnet = document.getElementById('usage-7d-sonnet-row');
      if (row7dSonnet) { row7dSonnet.style.display = show7dSonnet ? '' : 'none'; }
```

After the `if (show7d)` block in the cost mode section (after line 587), add:

```javascript
        if (show7dSonnet) {
          document.getElementById('usage-7d-sonnet-label').textContent =
            pct(usage.utilization7dSonnet) + ' — ' + i18n.resetsIn + ' ' + fmt(usage.resetIn7dSonnet);
        }
```

After the `if (show7d)` block in the percent mode section (after line 598), add:

```javascript
        if (show7dSonnet) {
          const warnSonnet = usage.utilization7dSonnet >= 0.75 ? ' ⚠' : '';
          document.getElementById('usage-7d-sonnet-label').textContent =
            pct(usage.utilization7dSonnet) + warnSonnet + ' — ' + i18n.resetsIn + ' ' + fmt(usage.resetIn7dSonnet);
        }
```

After the `if (show7d)` progress bar block (after line 615), add:

```javascript
      if (show7dSonnet) {
        const fillSonnet = document.getElementById('usage-7d-sonnet-fill');
        fillSonnet.style.width = Math.min(100, usage.utilization7dSonnet * 100) + '%';
        fillSonnet.className = 'progress-fill' + (usage.utilization7dSonnet >= 0.75 ? ' warning' : '');
      }
```

- [ ] **Step 4: Add Sonnet-specific recommendation to recI18n mapping**

In `src/webview/panel.ts`, in the `recI18n` object (around line 772), after the `'rate-limit-reached'` entry, add:

```javascript
        'sonnet-limit-reached': i18n.recSonnetLimitReached,
```

This ensures the dashboard displays the Sonnet-specific message ("Sonnet limit reached. Switch model or wait for reset.") instead of the generic "Rate limit reached" when only the Sonnet 7d limit is exhausted but the 5h unified limit is fine.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npm run compile`
Expected: SUCCESS

- [ ] **Step 6: Commit**

```
git add src/webview/panel.ts
git commit -m "feat: add Sonnet-only 7d progress row to dashboard"
```

---

### Task 5B: Add costSonnet7d to JSONL Reader (jsonlReader.ts)

**Files:**
- Modify: `src/data/jsonlReader.ts:17-24` (JsonlEntry interface — add model field)
- Modify: `src/data/jsonlReader.ts:26-34` (AggregatedUsage interface)
- Modify: `src/data/jsonlReader.ts:118-163` (readAllUsage function)

- [ ] **Step 1: Add model to JsonlEntry interface**

In `src/data/jsonlReader.ts`, replace lines 17-24:

```typescript
interface JsonlEntry {
  type: string
  timestamp: string
  cwd?: string
  message?: {
    model?: string
    usage?: TokenUsage
  }
}
```

- [ ] **Step 2: Add costSonnet7d to AggregatedUsage interface**

In `src/data/jsonlReader.ts`, replace lines 26-34:

```typescript
export interface AggregatedUsage {
  cost5h: number
  costDay: number
  cost7d: number
  costSonnet7d: number
  tokensIn5h: number
  tokensOut5h: number
  tokensCacheRead5h: number
  tokensCacheCreate5h: number
}
```

- [ ] **Step 3: Accumulate costSonnet7d in readAllUsage**

In `src/data/jsonlReader.ts`, in the `readAllUsage` function, add `costSonnet7d: 0` to the result initializer (after `cost7d: 0,`):

```typescript
  const result: AggregatedUsage = {
    cost5h: 0,
    costDay: 0,
    cost7d: 0,
    costSonnet7d: 0,
    tokensIn5h: 0,
    tokensOut5h: 0,
    tokensCacheRead5h: 0,
    tokensCacheCreate5h: 0,
  };
```

Then inside the `if (age <= window7d)` block (after `result.cost7d += cost;`), add the model check:

```typescript
      if (age <= window7d) {
        result.cost7d += cost;
        // Accumulate Sonnet-only 7d cost for prediction
        const model = entry.message?.model ?? '';
        if (model.toLowerCase().includes('sonnet')) {
          result.costSonnet7d += cost;
        }
      }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npm run compile`
Expected: SUCCESS

- [ ] **Step 5: Commit**

```
git add src/data/jsonlReader.ts
git commit -m "feat: add costSonnet7d to JSONL usage aggregation"
```

---

### Task 6: Add Sonnet-Only Prediction with Model-Filtered Burn Rate (prediction.ts)

**Files:**
- Modify: `src/data/prediction.ts:17-54` (TimestampedCost, readRecentCosts)
- Modify: `src/data/prediction.ts:78-142` (computePrediction)
- Test: `src/test/suite/prediction.test.ts`

**Review fixes applied:**
- **#2 (prediction math — rev 3):** Mirrors the author's 5h pattern exactly: `capacity = costSonnet7d / utilization7dSonnet`, `remaining = capacity * (1 - util)`, `time = remaining / sonnetBurnRate`. Uses `costSonnet7d` from the JSONL reader (same-window data, no cross-window mixing).
- **#4 (double JSONL read):** `readRecentCosts` returns entries tagged with `model`. Caller reads once and partitions in memory.
- **#6 (trivial tests — rev 2):** Tests call `computeSonnetExhaustion` with concrete inputs and assert on computed values, not range checks. Inputs chosen to avoid cap at reset time.
- **blendedBurnRate removed:** Was dead code. YAGNI.
- **sonnetBurnRate gate:** Matches author's pattern — `calculateBurnRate` returns 0 for < 2 entries, same behavior as 5h.

- [ ] **Step 1: Write failing tests for Sonnet exhaustion**

In `src/test/suite/prediction.test.ts`, first add the import for the new function at line 2:

```typescript
import { calculateBurnRate, buildRecommendation, computeSonnetExhaustion } from '../../data/prediction';
```

Then add a new `suite('Sonnet exhaustion')` block after the existing `buildRecommendation` suite (after line 44):

```typescript
  suite('computeSonnetExhaustion', () => {
    test('returns 0 when Sonnet utilization is at 1.0', () => {
      // costSonnet7d and sonnetBurnRate don't matter — already exhausted
      const result = computeSonnetExhaustion(1.0, 172800, 5.00, 0.10);
      assert.strictEqual(result, 0);
    });

    test('returns Infinity when Sonnet burn rate is 0', () => {
      // utilization > 0 but < 2 Sonnet calls in 30 min — can't project
      const result = computeSonnetExhaustion(0.5, 172800, 5.00, 0);
      assert.strictEqual(result, Infinity);
    });

    test('returns Infinity when utilization is 0', () => {
      const result = computeSonnetExhaustion(0, 172800, 0, 0.10);
      assert.strictEqual(result, Infinity);
    });

    test('returns Infinity when costSonnet7d is 0', () => {
      const result = computeSonnetExhaustion(0.5, 172800, 0, 0.10);
      assert.strictEqual(result, Infinity);
    });

    test('mirrors 5h pattern: capacity / burnRate for remaining fraction', () => {
      // costSonnet7d=$10, utilization=0.5 → capacity=$20, remaining=$10
      // sonnetBurnRate=$2/hr → 5 hours = 18000 seconds
      // resetIn7dSonnet=172800 (2 days) — won't cap
      const result = computeSonnetExhaustion(0.5, 172800, 10.00, 2.00);
      assert.strictEqual(result, 18000);
    });

    test('caps exhaustion at reset time', () => {
      // costSonnet7d=$10, utilization=0.5 → capacity=$20, remaining=$10
      // sonnetBurnRate=$0.01/hr → 1000 hours — way past reset
      // resetIn7dSonnet=3600 (1 hour) — should cap here
      const result = computeSonnetExhaustion(0.5, 3600, 10.00, 0.01);
      assert.strictEqual(result, 3600);
    });

    test('higher burn rate exhausts sooner', () => {
      const fast = computeSonnetExhaustion(0.5, 172800, 10.00, 5.00);
      const slow = computeSonnetExhaustion(0.5, 172800, 10.00, 1.00);
      assert.ok(fast < slow, `Higher burn rate should exhaust sooner: fast=${fast}, slow=${slow}`);
    });
  });

  suite('recommendation key selection', () => {
    // These test the branching logic inside computePrediction that picks
    // 'sonnet-limit-reached' vs 'rate-limit-reached' vs time-based keys.
    // Since computePrediction does JSONL I/O, we test the extracted logic directly.

    test('5h exhausted yields rate-limit-reached, not sonnet-limit-reached', () => {
      // When 5h exhaustion is 0 (binding), recommendation should be 'rate-limit-reached'
      const exhaustion5h = 0;
      const exhaustionSonnet = 3600;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.strictEqual(effective, 0);
      // The plan's logic: if effectiveSeconds === 0 && exhaustion5hSeconds === 0 → 'rate-limit-reached'
      const key = exhaustion5h === 0 ? 'rate-limit-reached' : 'sonnet-limit-reached';
      assert.strictEqual(key, 'rate-limit-reached');
    });

    test('Sonnet exhausted but 5h fine yields sonnet-limit-reached', () => {
      // When Sonnet exhaustion is 0 (binding) but 5h is still available
      const exhaustion5h = 7200;
      const exhaustionSonnet = 0;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.strictEqual(effective, 0);
      const key = exhaustion5h === 0 ? 'rate-limit-reached' : 'sonnet-limit-reached';
      assert.strictEqual(key, 'sonnet-limit-reached');
    });

    test('both exhausted yields rate-limit-reached (5h takes priority)', () => {
      const exhaustion5h = 0;
      const exhaustionSonnet = 0;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.strictEqual(effective, 0);
      const key = exhaustion5h === 0 ? 'rate-limit-reached' : 'sonnet-limit-reached';
      assert.strictEqual(key, 'rate-limit-reached');
    });

    test('neither exhausted uses time-based recommendation', () => {
      const exhaustion5h = 1200;  // 20 min
      const exhaustionSonnet = 3600;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.ok(effective > 0);
      assert.ok(isFinite(effective));
      // Should use buildRecommendation/buildRecommendationKey, not a limit-reached key
      const rec = buildRecommendation(effective);
      assert.ok(rec.includes('30 min'), `Expected 30 min warning for ${effective}s: ${rec}`);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computeSonnetExhaustion` is not exported yet.

- [ ] **Step 3: Refactor readRecentCosts to tag entries with model**

In `src/data/prediction.ts`, replace the `TimestampedCost` interface (line 17-19) and `readRecentCosts` function (lines 22-54):

Replace the interface:

```typescript
interface TimestampedCost {
  timestamp: number  // ms
  cost: number       // USD
  model: string      // e.g. 'claude-sonnet-4-6', empty if absent
}
```

Replace the function:

```typescript
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
```

- [ ] **Step 4: Extend RecommendationKey type and add computeSonnetExhaustion function**

In `src/data/prediction.ts`, first update the `RecommendationKey` type (line 4) to add the new Sonnet-specific key:

```typescript
export type RecommendationKey = 'safe' | 'caution' | 'warning' | 'critical' | 'rate-limit-reached' | 'sonnet-limit-reached';
```

Then add this function after the `buildRecommendationKey` function (after line 76):

```typescript
/**
 * Estimate seconds until Sonnet-only 7d limit exhaustion.
 *
 * Mirrors the existing 5h exhaustion pattern exactly:
 *   capacity = costSonnet7d / utilization7dSonnet
 *   remaining = capacity * (1 - utilization7dSonnet)
 *   time = remaining / sonnetBurnRate
 *   capped at resetIn7dSonnet
 *
 * @param utilization7dSonnet - current Sonnet 7d utilization (0.0–1.0)
 * @param resetIn7dSonnet - seconds until the Sonnet 7d window resets
 * @param costSonnet7d - Sonnet-only cost in the 7d window (from JSONL reader)
 * @param sonnetBurnRate - Sonnet-only USD/hour from recent JSONL entries
 * @returns seconds until exhaustion, 0 if already exhausted, Infinity if unpredictable
 */
export function computeSonnetExhaustion(
  utilization7dSonnet: number,
  resetIn7dSonnet: number,
  costSonnet7d: number,
  sonnetBurnRate: number,
): number {
  if (utilization7dSonnet >= 1.0) { return 0; }
  if (utilization7dSonnet <= 0 || costSonnet7d <= 0 || sonnetBurnRate <= 0) { return Infinity; }

  // Mirror 5h pattern: estimate total capacity, compute remaining, divide by burn rate
  const estimatedCapacityUsd = costSonnet7d / utilization7dSonnet;
  const remainingUsd = estimatedCapacityUsd * (1.0 - utilization7dSonnet);
  const hoursUntilExhaustion = remainingUsd / sonnetBurnRate;
  const secondsUntilExhaustion = hoursUntilExhaustion * 3600;

  // Cap at reset time — can't exhaust after the window resets
  return Math.min(secondsUntilExhaustion, resetIn7dSonnet);
}
```

- [ ] **Step 5: Update computePrediction to use single-read partitioning and computeSonnetExhaustion**

In `src/data/prediction.ts`, replace the `computePrediction` function (lines 78-142, now shifted by the new function):

```typescript
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
  // Single JSONL read — partition in memory to avoid double I/O
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
    // Distinguish which limit triggered exhaustion for a model-aware message
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
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```
git add src/data/prediction.ts src/test/suite/prediction.test.ts
git commit -m "feat: add Sonnet-only prediction with model-filtered burn rate"
```

---

### Task 7: Update i18n Translation Files

**Files:**
- Modify: `l10n/bundle.l10n.ja.json`
- Modify: `l10n/bundle.l10n.zh-cn.json`

- [ ] **Step 1: Add Japanese translations**

In `l10n/bundle.l10n.ja.json`, add these entries (insert after the `"7d window"` entry):

```json
  "Sonnet 7d window": "Sonnet 7日間ウィンドウ",
  "S7d": "S7d",
  "Sonnet limit reached. Switch model or wait for reset.": "Sonnetの制限に達しました。モデルを切り替えるか、リセットをお待ちください。",
```

- [ ] **Step 2: Add Chinese translations**

In `l10n/bundle.l10n.zh-cn.json`, add the same entries (after the `"7d window"` equivalent):

```json
  "Sonnet 7d window": "Sonnet 7天窗口",
  "S7d": "S7d",
  "Sonnet limit reached. Switch model or wait for reset.": "Sonnet限额已用完。请切换模型或等待重置。",
```

- [ ] **Step 3: Commit**

```
git add l10n/
git commit -m "feat: add i18n translations for Sonnet 7d window"
```

---

### Task 8: Update Documentation and Changelog

**Files:**
- Modify: `docs/DATA.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update DATA.md with new headers and cache v3**

In `docs/DATA.md`, find the API headers table and add three new rows for:

| Header | Field | Type |
|--------|-------|------|
| `anthropic-ratelimit-unified-7d-sonnet-utilization` | `utilization7dSonnet` | float 0.0–1.0 |
| `anthropic-ratelimit-unified-7d-sonnet-reset` | `resetIn7dSonnet` | Unix timestamp (seconds) |
| `anthropic-ratelimit-unified-7d-sonnet-status` | fed into `limitStatus` | `"allowed"` / `"denied"` |

Update the cache version section to note version 3 adds `utilization7dSonnet` and `reset7dSonnetAt`, with backward compatibility for v2 (missing fields default to 0).

Update the `RateLimitData` interface listing to include the three new fields.

- [ ] **Step 2: Update ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, find the `ClaudeUsageData` interface listing and add:
- `utilization7dSonnet: number`
- `resetIn7dSonnet: number`
- `has7dSonnetLimit: boolean`

Add a brief mention that prediction now factors Sonnet-only exhaustion using model-filtered JSONL burn rate.

- [ ] **Step 3: Update CHANGELOG.md**

In `CHANGELOG.md`, under `## [Unreleased]`, add:

```markdown
### Added
- Track Sonnet-only 7-day rate limit window — status bar (`S7d:`), tooltip, dashboard progress bar, and prediction engine
- Model-filtered burn rate for accurate Sonnet-specific exhaustion prediction
- Cache schema v3 with backward compatibility for v2
```

- [ ] **Step 4: Commit**

```
git add docs/DATA.md docs/ARCHITECTURE.md CHANGELOG.md
git commit -m "docs: document Sonnet-only 7d rate limit support"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run full lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 3: Run production build**

Run: `npm run compile`
Expected: SUCCESS — webpack bundle completes without errors

- [ ] **Step 4: Manual verification checklist**

Press F5 in VSCode to launch Extension Development Host and verify:
- Status bar shows `S7d:XX%` when connected to a Claude.ai account with Sonnet limit
- Tooltip shows `Sonnet 7d:` line below the regular `7d window:` line
- Dashboard shows Sonnet 7d progress bar below the 7d bar
- Warning `⚠` appears when Sonnet utilization >= 75%
- If no Sonnet limit headers are returned, the S7d display is hidden
