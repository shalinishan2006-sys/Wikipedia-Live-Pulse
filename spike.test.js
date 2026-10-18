const test = require("node:test");
const assert = require("node:assert");
const { analyzeSpike, SPIKE_Z, MIN_BASELINE_POINTS } = require("./spike.js");

// Helper: turns a list of numbers into chart points like the dashboard makes
function makePoints(values) {
  return values.map((value, i) => ({ time: i * 10000, value }));
}

// 18 baseline numbers that wobble between 290 and 310 (average 300)
const wobbly = Array.from({ length: MIN_BASELINE_POINTS }, (_, i) => (i % 2 === 0 ? 290 : 310));

test("not ready when there are too few points", () => {
  const result = analyzeSpike(makePoints([300, 300, 300]));
  assert.strictEqual(result.ready, false);
  assert.ok(result.progress > 0 && result.progress < 1);
});

test("ready as soon as there is a full baseline plus the newest point", () => {
  const justEnough = makePoints([...wobbly, 300]);
  assert.strictEqual(analyzeSpike(justEnough).ready, true);

  const oneShort = makePoints([...wobbly.slice(1), 300]);
  assert.strictEqual(analyzeSpike(oneShort).ready, false);
});

test("a normal wobble is not a spike", () => {
  const result = analyzeSpike(makePoints([...wobbly, 310]));
  assert.strictEqual(result.isSpike, false);
  assert.ok(Math.abs(result.z) < SPIKE_Z);
});

test("a big jump is a spike", () => {
  const result = analyzeSpike(makePoints([...wobbly, 400]));
  assert.strictEqual(result.isSpike, true);
  assert.ok(result.z >= SPIKE_Z);
});

test("flat traffic: a small change is not a spike, a big one is", () => {
  const flat = Array(MIN_BASELINE_POINTS).fill(300);

  // z = (330 - 300) / 15 = 2, because the safety rule gives a minimum wobble of 5% of the average
  const small = analyzeSpike(makePoints([...flat, 330]));
  assert.strictEqual(small.isSpike, false);

  // z = (360 - 300) / 15 = 4
  const big = analyzeSpike(makePoints([...flat, 360]));
  assert.strictEqual(big.isSpike, true);
});

test("a sudden drop is not a spike", () => {
  const result = analyzeSpike(makePoints([...wobbly, 100]));
  assert.ok(result.z < 0);
  assert.strictEqual(result.isSpike, false);
});

test("the average does not include the newest point", () => {
  const quiet = Array(MIN_BASELINE_POINTS).fill(100);
  const result = analyzeSpike(makePoints([...quiet, 1000]));
  assert.strictEqual(result.mean, 100);
  assert.strictEqual(result.current, 1000);
});

test("a completely quiet baseline never divides by zero", () => {
  const zeros = Array(MIN_BASELINE_POINTS).fill(0);
  const result = analyzeSpike(makePoints([...zeros, 0]));
  assert.ok(Number.isFinite(result.z));
  assert.strictEqual(result.isSpike, false);
});