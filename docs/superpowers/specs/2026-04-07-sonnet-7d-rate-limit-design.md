# Design: Sonnet-Only 7-Day Rate Limit Window

**Date**: 2026-04-07
**Status**: Draft
**Approach**: Mirror existing 7d pattern (Approach 1)

---

## Problem

Claude subscriptions now track three rate limit windows:

1. **5-hour unified** (all models) — already tracked
2. **7-day unified** (all models) — already tracked
3. **7-day Sonnet-only** — **not tracked**

When the Sonnet-only 7d limit is exhausted, the user must pay to continue using Sonnet. Without tracking this, the extension could show low unified usage while the user is actually blocked from Sonnet, creating a misleading status display.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Status bar display | Third segment `S7d: XX%` | Matches existing terse label pattern (`7d: XX%`) |
| Limit status escalation | `allowed_warning` at >= 0.75, never `denied` | Sonnet denial doesn't block other models — only warn |
| Prediction | Sonnet-specific burn rate via model-filtered JSONL | Blended rate misleading when mixing models |
| Pricing | Single pricing (no per-model rates) | Out of scope; respects original author's design |
| Cache | Version bump 2 -> 3, backward compat | v2 caches read with Sonnet fields defaulted to 0 |
| Approach | Mirror existing 7d field pattern | Consistent with codebase, minimal architectural change |

---

## New API Headers

The Sonnet-only 7-day rate limit is exposed via three HTTP response headers returned alongside the existing unified headers on every API response:

| Header | Maps to | Type |
|--------|---------|------|
| `anthropic-ratelimit-unified-7d-sonnet-utilization` | `utilization7dSonnet` | float 0.0–1.0 |
| `anthropic-ratelimit-unified-7d-sonnet-reset` | `resetIn7dSonnet` | Unix timestamp (seconds) |
| `anthropic-ratelimit-unified-7d-sonnet-status` | fed into `limitStatus` | `"allowed"` / `"denied"` |

These headers are present only for Claude.ai subscribers on plans with a Sonnet-specific limit. Absence means no Sonnet-only limit applies.

---

## Section 1: Data Layer — Interfaces & Header Parsing

### RateLimitData (apiClient.ts)

Three new fields mirroring the existing 7d pattern:

```
utilization7dSonnet: number      // 0.0–1.0
resetIn7dSonnet: number          // seconds until reset (relative)
has7dSonnetLimit: boolean        // true when header is present
```

### fetchRateLimitData (apiClient.ts)

Parse the three new headers using the same logic as the existing 7d headers:

- `anthropic-ratelimit-unified-7d-sonnet-utilization` -> `parseFloat(... ?? '0')`
- `anthropic-ratelimit-unified-7d-sonnet-reset` -> presence check for `has7dSonnetLimit`, then `parseInt` and subtract `nowSec` for relative seconds
- `anthropic-ratelimit-unified-7d-sonnet-status` -> fed into limit status

### limitStatus derivation

Updated logic:

- `'denied'`: if 5h status is `"denied"` (unchanged — only unified denial blocks everything)
- `'allowed_warning'`: if 5h >= 0.75 OR (7d exists AND 7d >= 0.75) OR **(7dSonnet exists AND (7dSonnet >= 0.75 OR 7dSonnet status === "denied"))**
- `'allowed'`: otherwise

Sonnet-only `denied` status does NOT escalate to global `denied`. It contributes to `allowed_warning` only — both via utilization threshold (>= 0.75) and via explicit `status7dSonnet === 'denied'` check (covers edge cases where API reports denial at lower utilization). The user sees the Sonnet-specific state in the status bar segment and dashboard row and can decide whether to switch models.

---

## Section 2: Cache Schema (cache.ts)

### CacheFile version bump: 2 -> 3

The `usageData` object gains two fields:

```
utilization7dSonnet: number
reset7dSonnetAt: number          // absolute Unix timestamp (seconds)
```

`limitStatus` is already stored and now reflects Sonnet-only in its derivation — no schema change needed for that field.

### Backward compatibility

**Upgrade (v2 cache read by new extension):** When reading a version 2 cache file, default missing Sonnet fields to `utilization7dSonnet: 0`, `reset7dSonnetAt: 0`. This matches how `has7dLimit` is derived from `reset7dAt > 0`. Same logic: `has7dSonnetLimit = reset7dSonnetAt > 0`.

**Downgrade (v3 cache read by old extension):** The old extension's `readCache` rejects any cache where `version !== 2`, so a v3 cache is discarded and the old extension falls back to a fresh API call. This is safe — no data corruption, just one extra API call on first run after downgrade.

### cacheToRateLimitData (dataManager.ts)

Derives the new fields identically to the existing 7d pattern:
- `utilization7dSonnet: usageData.utilization7dSonnet`
- `resetIn7dSonnet: Math.max(0, usageData.reset7dSonnetAt - nowSec)`
- `has7dSonnetLimit: usageData.reset7dSonnetAt > 0`

---

## Section 3: DataManager & ClaudeUsageData

### ClaudeUsageData (dataManager.ts)

Three new fields:

```
utilization7dSonnet: number
resetIn7dSonnet: number
has7dSonnetLimit: boolean
```

### getUsageData

Threads the new fields through with the same nullish coalescing pattern:
- `utilization7dSonnet: rateLimitData?.utilization7dSonnet ?? 0`
- `resetIn7dSonnet: rateLimitData?.resetIn7dSonnet ?? 0`
- `has7dSonnetLimit: rateLimitData?.has7dSonnetLimit ?? false`

No changes to `dataSource` logic, `providerType` detection, or the refresh/watch cycle. The new data rides the same API call.

---

## Section 4: Status Bar Display (statusBar.ts)

### buildLabel (percent mode)

Adds a third segment when `has7dSonnetLimit` is true:

```
Claude: 23% | 7d: 41% | S7d: 65%
```

- `S7d` label — "S" for Sonnet, "7d" for the window, matches existing terse style
- Warning `⚠` appended when `utilization7dSonnet >= 0.75`
- Hidden when `has7dSonnetLimit` is false

### buildTooltip

Adds a line below the existing 7d window line:

```
Sonnet 7d window: 65.0% [████████░░] resets in 3d 12h
```

Same format as the existing `7d window:` tooltip line.

---

## Section 5: WebView Dashboard (panel.ts)

### New progress row

Added below the existing `usage-7d-row`, identical HTML structure:

```html
<div class="progress-row" id="usage-7d-sonnet-row">
  <div class="progress-labels">
    <span>${i18n.window7dSonnet}</span>
    <span id="usage-7d-sonnet-label">---</span>
  </div>
  <div class="progress-track">
    <div class="progress-fill" id="usage-7d-sonnet-fill" style="width:0%"></div>
  </div>
</div>
```

### Visibility

`show7dSonnet = usage.has7dSonnetLimit && isClaudeAi` — same gating pattern as 7d row.

### updateUsage function

New block mirroring the 7d logic:
- Cost mode: shows utilization as percent with reset countdown
- Percent mode: shows utilization with `⚠` at >= 0.75
- Progress bar: `Math.min(100, usage.utilization7dSonnet * 100)`, warning class at 0.75

### i18n labels

- `window7dSonnet: t('Sonnet 7d window')`
- `days7dSonnetShort: t('S7d')`
- `recSonnetLimitReached: t('Sonnet limit reached. Switch model or wait for reset.')`

### Budget calculation

No change. Weekly budget still uses `cost7d` (total spend). Sonnet-only is a rate limit, not a cost bucket.

---

## Section 6: Prediction Engine (prediction.ts)

### JSONL reader: costSonnet7d

`readAllUsage` in `jsonlReader.ts` gains a `costSonnet7d` field in `AggregatedUsage`. Within the existing 7d window loop, entries where `message.model` contains `'sonnet'` (case-insensitive) accumulate into this field. The `JsonlEntry` interface gains `model?: string` on the `message` object (verified present in real JSONL data).

### Prediction: model-filtered burn rate

`readRecentCosts` in `prediction.ts` tags each entry with `model: string` from `message.model`. The caller reads once and partitions into all/Sonnet entries in memory (no second disk read).

### computePrediction signature

Gains three new parameters:

```
utilization7dSonnet: number
resetIn7dSonnet: number
costSonnet7d: number
```

### Sonnet exhaustion calculation

Mirrors the existing 5h pattern exactly:

1. Filter recent entries to Sonnet, compute `sonnetBurnRate` ($/hr)
2. If `utilization7dSonnet >= 1.0` → exhausted now
3. Estimate capacity: `costSonnet7d / utilization7dSonnet`
4. Remaining: `capacity * (1 - utilization7dSonnet)`
5. Time: `remaining / sonnetBurnRate`, capped at `resetIn7dSonnet`
6. If `sonnetBurnRate` is 0 (fewer than 2 Sonnet entries in 30 min) or `costSonnet7d` is 0 → skip (matches author's gate pattern)

### Most restrictive wins

The function takes the **minimum** of the 5h exhaustion time and Sonnet-only exhaustion time. Whichever is sooner becomes `estimatedExhaustionTime`. The `recommendation` text and `safeToStartHeavyTask` are driven by that minimum.

### Model-aware recommendation text

When the binding constraint is the Sonnet-only limit (exhausted or near-exhausted), but the 5h unified limit is fine, the recommendation must reflect that other models still work:

- **5h exhausted** → `'rate-limit-reached'`: "Rate limit reached. Wait for reset." (all models blocked)
- **Sonnet-only exhausted** → `'sonnet-limit-reached'`: "Sonnet limit reached. Switch model or wait for reset." (only Sonnet blocked)

`RecommendationKey` gains `'sonnet-limit-reached'`. The i18n mapping and l10n translations cover both English and all supported languages.

### PredictionData interface

No new fields. `estimatedExhaustionTime/In` already represent "the most binding constraint." `recommendationKey` now includes `'sonnet-limit-reached'` as a possible value.

---

## Section 7: Tests

All additions go into existing test suites — no new test files.

### cache.test.ts

- Update `TestCacheFile` to version 3 with Sonnet fields
- Round-trip write/read with Sonnet data present
- Backward compat: reading a version 2 cache defaults Sonnet fields to 0

### prediction.test.ts

- Sonnet exhaustion sooner than 5h -> Sonnet exhaustion wins
- 5h exhaustion sooner than Sonnet -> 5h wins
- Sonnet burn rate is 0 -> falls back to 5h prediction only
- Sonnet utilization at 1.0 -> immediate exhaustion

### statusBar.test.ts

- `buildLabel` includes `S7d: XX%` when `has7dSonnetLimit` is true
- `buildLabel` omits `S7d` when `has7dSonnetLimit` is false
- `buildTooltip` shows Sonnet 7d line when present
- Warning `⚠` appears at >= 0.75 threshold

---

## Section 8: Documentation Updates

### docs/DATA.md

- Add three new headers to the API headers table
- Document Sonnet-only fields in `RateLimitData` and `CacheFile` sections
- Note cache version bump to 3 with backward compat behavior

### docs/ARCHITECTURE.md

- Update `ClaudeUsageData` type definition if listed
- Mention Sonnet-only in data flow description

### CHANGELOG.md

Under `## [Unreleased]`:

```
### Added
- Track Sonnet-only 7-day rate limit window (status bar, dashboard, prediction)
```

No new feature spec file — this extends existing features.

---

## Files Modified

| File | Change |
|------|--------|
| `src/data/apiClient.ts` | Parse 3 new headers, extend `RateLimitData`, update `limitStatus` logic |
| `src/data/cache.ts` | Version 3 schema, 2 new fields, backward compat |
| `src/data/dataManager.ts` | Extend `ClaudeUsageData`, thread fields + `costSonnet7d` through, update `cacheToRateLimitData` |
| `src/data/jsonlReader.ts` | Add `costSonnet7d` to `AggregatedUsage`, add `model` to `JsonlEntry` |
| `src/statusBar.ts` | `S7d` label segment, tooltip line |
| `src/webview/panel.ts` | Progress row, visibility gate, updateUsage block, i18n labels |
| `src/data/prediction.ts` | Model-tagged entries, Sonnet-filtered burn rate, exhaustion mirroring 5h pattern |
| `src/test/suite/cache.test.ts` | Version 3 tests, backward compat test |
| `src/test/suite/prediction.test.ts` | Sonnet exhaustion scenarios |
| `src/test/suite/statusBar.test.ts` | Sonnet label and tooltip tests |
| `docs/DATA.md` | New headers, fields, cache v3 |
| `docs/ARCHITECTURE.md` | Updated type definitions |
| `CHANGELOG.md` | Unreleased entry |
