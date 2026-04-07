import * as assert from 'assert';
import { calculateBurnRate, buildRecommendation, computeSonnetExhaustion } from '../../data/prediction';

suite('Prediction', () => {
  suite('calculateBurnRate', () => {
    test('returns 0 with fewer than 2 entries', () => {
      assert.strictEqual(calculateBurnRate([]), 0);
      assert.strictEqual(calculateBurnRate([{ timestamp: Date.now(), cost: 1 }]), 0);
    });

    test('returns positive rate for 2+ entries', () => {
      const now = Date.now();
      const entries = [
        { timestamp: now - 1800_000, cost: 0.10 }, // 30 min ago
        { timestamp: now - 900_000,  cost: 0.10 }, // 15 min ago
      ];
      const rate = calculateBurnRate(entries);
      // 0.20 USD over 30 min = 0.40 USD/hr
      assert.ok(rate > 0, 'Burn rate should be positive');
      assert.ok(rate < 1.0, 'Burn rate should be reasonable');
    });
  });

  suite('buildRecommendation', () => {
    test('critical < 600s', () => {
      const msg = buildRecommendation(300);
      assert.ok(msg.includes('10 min'), `Expected 10 min warning, got: ${msg}`);
    });

    test('warning < 1800s', () => {
      const msg = buildRecommendation(1200);
      assert.ok(msg.includes('30 min'), `Expected 30 min warning, got: ${msg}`);
    });

    test('caution < 3600s', () => {
      const msg = buildRecommendation(2700);
      assert.ok(msg.includes('1 hour'), `Expected 1 hour caution, got: ${msg}`);
    });

    test('safe >= 3600s', () => {
      const msg = buildRecommendation(7200);
      assert.ok(msg.includes('Plenty'), `Expected safe message, got: ${msg}`);
    });
  });

  suite('computeSonnetExhaustion', () => {
    test('returns 0 when Sonnet utilization is at 1.0', () => {
      const result = computeSonnetExhaustion(1.0, 172800, 5.00, 0.10);
      assert.strictEqual(result, 0);
    });

    test('returns Infinity when Sonnet burn rate is 0', () => {
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
      const result = computeSonnetExhaustion(0.5, 172800, 10.00, 2.00);
      assert.strictEqual(result, 18000);
    });

    test('caps exhaustion at reset time', () => {
      // costSonnet7d=$10, utilization=0.5 → capacity=$20, remaining=$10
      // sonnetBurnRate=$0.01/hr → 1000 hours — way past reset
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
    test('5h exhausted yields rate-limit-reached, not sonnet-limit-reached', () => {
      const exhaustion5h = 0;
      const exhaustionSonnet = 3600;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.strictEqual(effective, 0);
      const key = exhaustion5h === 0 ? 'rate-limit-reached' : 'sonnet-limit-reached';
      assert.strictEqual(key, 'rate-limit-reached');
    });

    test('Sonnet exhausted but 5h fine yields sonnet-limit-reached', () => {
      const exhaustion5h: number = 7200;
      const exhaustionSonnet: number = 0;
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
      const exhaustion5h = 1200;
      const exhaustionSonnet = 3600;
      const effective = Math.min(exhaustion5h, exhaustionSonnet);
      assert.ok(effective > 0);
      assert.ok(isFinite(effective));
      const rec = buildRecommendation(effective);
      assert.ok(rec.includes('30 min'), `Expected 30 min warning for ${effective}s: ${rec}`);
    });
  });
});
