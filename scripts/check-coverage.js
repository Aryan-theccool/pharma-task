#!/usr/bin/env node
/**
 * Coverage gate.
 *
 * Jest's own `coverageThreshold` fails the *test* command, which makes a
 * coverage regression look identical to a broken test in CI logs. Running the
 * check as a separate step keeps the two signals distinct, and lets us print
 * the shortfall in a form that is actually actionable.
 *
 * Thresholds are set just under the current numbers: high enough to catch a
 * real regression, not so high that adding a defensive branch fails the build.
 */
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const THRESHOLDS = {
  statements: 73,
  branches: 58,
  functions: 65,
  lines: 75,
};

const summaryPath = join(process.cwd(), 'coverage', 'coverage-summary.json');

if (!existsSync(summaryPath)) {
  console.error(`✗ ${summaryPath} not found — run \`npm run test:cov\` first.`);
  process.exit(1);
}

const { total } = JSON.parse(readFileSync(summaryPath, 'utf8'));
const failures = [];

console.log('Coverage summary');
console.log('─'.repeat(52));

for (const [metric, floor] of Object.entries(THRESHOLDS)) {
  const actual = total[metric].pct;
  const ok = actual >= floor;
  if (!ok) failures.push({ metric, actual, floor });
  console.log(
    `  ${ok ? '✓' : '✗'} ${metric.padEnd(12)} ${String(actual).padStart(6)}%  (floor ${floor}%)`,
  );
}

console.log('─'.repeat(52));

if (failures.length) {
  console.error('\nCoverage below the agreed floor:');
  for (const { metric, actual, floor } of failures) {
    console.error(`  ${metric}: ${actual}% < ${floor}% (short by ${(floor - actual).toFixed(2)} points)`);
  }
  process.exit(1);
}

console.log('All coverage thresholds met.\n');
