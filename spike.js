// Spike detection logic. No page code here, so Node can test it.

const SPIKE_Z = 3;               // z-score at or above this = spike
const MIN_BASELINE_POINTS = 18;  // 18 points x 10 seconds = 3 minutes of "normal" needed first

// The OLDER points are the "normal" baseline.
// The NEWEST point is compared to that baseline using a z-score.
function analyzeSpike(points) {
  if (points.length < MIN_BASELINE_POINTS + 1) {
    return { ready: false, progress: points.length / (MIN_BASELINE_POINTS + 1) };
  }

  const current = points[points.length - 1].value;
  const baseline = points.slice(0, -1).map((p) => p.value);

  // Rolling average
  let sum = 0;
  for (const v of baseline) sum += v;
  const mean = sum / baseline.length;

  // Standard deviation = the typical "wobble" around the average
  let squares = 0;
  for (const v of baseline) squares += (v - mean) * (v - mean);
  const std = Math.sqrt(squares / baseline.length);

  // Safety: never let the wobble be tiny, or a calm period would
  // turn small changes into huge z-scores.
  const safeStd = Math.max(std, mean * 0.05, 1);

  const z = (current - mean) / safeStd;

  return { ready: true, current, mean, z, isSpike: z >= SPIKE_Z };
}

// In the browser "module" does not exist, so this line is skipped.
// In Node it lets the test file import the code.
if (typeof module !== "undefined") {
  module.exports = { analyzeSpike, SPIKE_Z, MIN_BASELINE_POINTS };
}