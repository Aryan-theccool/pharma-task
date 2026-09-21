/* eslint-disable no-console */
import autocannon, { type Result } from 'autocannon';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../scripts/load-env';

/**
 * Load profile for the stated target: 100k consultations/day.
 *
 * 100k/day is ~1.2 bookings/second averaged, but clinic traffic is not
 * uniform — booking opens in the morning and the evening, so the realistic
 * peak is roughly 10x the mean. Reads dominate at about 20:1 (patients browse
 * many doctors before booking one), which is why the search and slot endpoints
 * are the ones under real pressure.
 *
 * Scenarios:
 *   search   — the hottest read path (full-text + facets, Redis cache-aside)
 *   slots    — availability lookup for a specific doctor
 *   profile  — authenticated read, exercises JWT verification per request
 *   booking  — the full write path: hold → confirm → saga → payment capture
 *
 * Usage:
 *   npm run load:run                       # all scenarios
 *   npm run load:run -- --scenario search  # one scenario
 *   npm run load:run -- --duration 60 --connections 100
 */

interface ScenarioResult {
  name: string;
  description: string;
  requests: { average: number; total: number };
  latency: { p50: number; p95: number; p99: number; max: number };
  throughput: number;
  errors: number;
  statusCounts: Record<string, number>;
  /** Share of responses that were the status this scenario expects. */
  validShare: number;
  slo: { target: string; p95: number; budget: number; met: boolean; note?: string };
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = flag('url', process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3000');
const API = `${BASE}/api/v1`;
const DURATION = Number(flag('duration', '20'));
const CONNECTIONS = Number(flag('connections', '50'));
const ONLY = flag('scenario', '');
const PASSWORD = 'Str0ng!Passphrase2024';

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Log in a seeded patient and grab a doctor + slot ids to hammer. */
async function prepare() {
  const login = await json<{ accessToken: string }>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'patient1@amrutam.test', password: PASSWORD }),
  });

  const search = await json<{ items: Array<{ id: string }> }>('/doctors/search?limit=5');
  const doctorId = search.items[0]?.id;
  if (!doctorId) throw new Error('no doctors found — run `npm run seed` first');

  const from = new Date(Date.now() + 86_400_000).toISOString();
  const to = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const slots = await json<Array<{ id: string }>>(
    `/doctors/${doctorId}/slots?from=${from}&to=${to}&status=available`,
  );

  return { token: login.accessToken, doctorId, slotIds: slots.map((s) => s.id), from, to };
}

function summarise(
  name: string,
  description: string,
  sloTarget: string,
  budgetMs: number,
  acceptable: number[],
  statusCounts: Record<string, number>,
  result: Result,
): ScenarioResult {
  const total = Object.values(statusCounts).reduce((a, b) => a + b, 0) || 1;
  const valid = acceptable.reduce((sum, code) => sum + (statusCounts[String(code)] ?? 0), 0);
  const validShare = valid / total;

  // A latency number measured against rejected requests is worthless: 429s and
  // 5xx are cheap to produce and would flatter every percentile. A scenario
  // only passes if the responses were the ones we actually meant to measure.
  const measuringRealWork = validShare >= 0.99;

  return {
    name,
    description,
    requests: { average: Math.round(result.requests.average), total: result.requests.total },
    latency: {
      p50: result.latency.p50,
      p95: result.latency.p97_5, // autocannon exposes p97.5, the nearest to p95
      p99: result.latency.p99,
      max: result.latency.max,
    },
    throughput: Math.round(result.throughput.average),
    errors: result.errors,
    statusCounts,
    validShare,
    slo: {
      target: sloTarget,
      p95: result.latency.p97_5,
      budget: budgetMs,
      met: measuringRealWork && result.latency.p97_5 <= budgetMs && result.errors === 0,
      note: measuringRealWork
        ? undefined
        : `only ${(validShare * 100).toFixed(1)}% of responses were ${acceptable.join('/')} — ` +
          'the run measured rejections, not real work (raise RATE_LIMIT_* on the target)',
    },
  };
}

async function main(): Promise<void> {
  loadEnv();
  console.log(`\x1b[1mAmrutam load test\x1b[0m`);
  console.log(`  target      ${BASE}`);
  console.log(`  duration    ${DURATION}s per scenario`);
  console.log(`  connections ${CONNECTIONS}\n`);

  const ctx = await prepare();
  console.log(`  fixtures    doctor ${ctx.doctorId}, ${ctx.slotIds.length} free slots\n`);

  const results: ScenarioResult[] = [];

  const scenarios: Array<{
    name: string;
    description: string;
    sloTarget: string;
    budgetMs: number;
    /** Status codes that represent the work this scenario intends to measure. */
    acceptable: number[];
    opts: autocannon.Options;
  }> = [
    {
      name: 'search',
      description: 'Doctor search — full-text + facets, Redis cache-aside (hottest read path)',
      sloTarget: 'p95 < 200ms (read)',
      budgetMs: 200,
      acceptable: [200],
      opts: {
        url: `${API}/doctors/search?limit=20`,
        method: 'GET',
        connections: CONNECTIONS,
        duration: DURATION,
      },
    },
    {
      name: 'slots',
      description: 'Availability lookup for one doctor over a 10-day window (30s cache)',
      sloTarget: 'p95 < 200ms (read)',
      budgetMs: 200,
      acceptable: [200],
      opts: {
        url: `${API}/doctors/${ctx.doctorId}/slots?from=${ctx.from}&to=${ctx.to}&status=available`,
        method: 'GET',
        connections: CONNECTIONS,
        duration: DURATION,
      },
    },
    {
      name: 'profile',
      description: 'Authenticated profile read — JWT verify + field decryption per request',
      sloTarget: 'p95 < 200ms (read)',
      budgetMs: 200,
      acceptable: [200],
      opts: {
        url: `${API}/me`,
        method: 'GET',
        headers: { Authorization: `Bearer ${ctx.token}` },
        connections: CONNECTIONS,
        duration: DURATION,
      },
    },
    {
      name: 'booking-hold',
      description: 'Write path under maximum contention — every request targets the same slot',
      sloTarget: 'p95 < 500ms (write)',
      budgetMs: 500,
      // 201 for the one winner, 409 for everyone else: both are correct
      // outcomes of a contended write and both exercise the full defence stack.
      acceptable: [201, 409],
      opts: {
        url: `${API}/bookings/hold`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.token}`,
          'Content-Type': 'application/json',
        },
        // Deliberate worst case: one slot, many writers. Almost all of these
        // return 409 by design, which is exactly what we want to measure —
        // conflict detection must be fast, not just correct.
        body: JSON.stringify({ slotId: ctx.slotIds[0] }),
        connections: Math.min(CONNECTIONS, 20),
        duration: DURATION,
        // Each request needs a unique idempotency key.
        setupClient: (client: autocannon.Client) => {
          client.setHeaders({
            Authorization: `Bearer ${ctx.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': randomUUID(),
          });
          client.on('response', () => {
            client.setHeaders({
              Authorization: `Bearer ${ctx.token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': randomUUID(),
            });
          });
        },
        // 409 is the correct answer here, so do not count it as an error.
        expectBody: undefined,
      },
    },
  ];

  for (const scenario of scenarios) {
    if (ONLY && scenario.name !== ONLY) continue;

    console.log(`\x1b[1m▶ ${scenario.name}\x1b[0m — ${scenario.description}`);

    // autocannon() returns a thenable that is also an EventEmitter; the typings
    // only describe the promise half, hence the narrow cast.
    const statusCounts: Record<string, number> = {};
    const instance = autocannon(scenario.opts) as unknown as Promise<Result> & autocannon.Instance;
    // `.on()` returns the emitter (a thenable), not a promise we intend to await.
    void instance.on('response', (_client: unknown, statusCode: number) => {
      statusCounts[String(statusCode)] = (statusCounts[String(statusCode)] ?? 0) + 1;
    });
    const result = await instance;

    const summary = summarise(
      scenario.name,
      scenario.description,
      scenario.sloTarget,
      scenario.budgetMs,
      scenario.acceptable,
      statusCounts,
      result,
    );
    results.push(summary);

    const verdict = summary.slo.met ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`   rps       ${summary.requests.average}`);
    console.log(
      `   latency   p50 ${summary.latency.p50}ms · p95 ${summary.latency.p95}ms · p99 ${summary.latency.p99}ms · max ${summary.latency.max}ms`,
    );
    const statusLine = Object.entries(summary.statusCounts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([code, n]) => `${code}×${n}`)
      .join(' · ');
    console.log(`   statuses  ${statusLine}`);
    console.log(`   errors    ${summary.errors} (socket/timeout)`);
    console.log(`   SLO       ${scenario.sloTarget} → ${verdict}`);
    if (summary.slo.note) console.log(`   \x1b[33mnote      ${summary.slo.note}\x1b[0m`);
    console.log();
  }

  const outDir = join(process.cwd(), 'load', 'results');
  mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    target: BASE,
    config: { durationSeconds: DURATION, connections: CONNECTIONS },
    node: process.version,
    scenarios: results,
    verdict: results.every((r) => r.slo.met) ? 'all SLOs met' : 'one or more SLOs missed',
  };
  const outFile = join(outDir, 'latest.json');
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\x1b[1mSummary\x1b[0m  ${report.verdict}`);
  console.log(`Report written to ${outFile}`);

  if (!results.every((r) => r.slo.met)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
