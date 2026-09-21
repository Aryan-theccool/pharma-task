/**
 * Deterministic JSON serialisation (RFC 8785-style key ordering).
 *
 * Anything we hash or sign must serialise to the *same bytes* on the way in and
 * on the way out. `JSON.stringify` preserves insertion order, which is not
 * stable across a round-trip: Postgres `jsonb` normalises objects (keys stored
 * by length then bytewise), so a value written as `{"b":1,"a":2}` reads back as
 * `{"a":2,"b":1}`. Hashing the raw stringify output therefore produced a
 * different digest at verification time than at write time and broke the audit
 * hash chain.
 *
 * Rules:
 *  - object keys are emitted in ascending code-unit order, recursively;
 *  - arrays keep their order (it is semantically meaningful);
 *  - `undefined` and functions collapse to `null` instead of vanishing, so the
 *    shape of the document is preserved;
 *  - non-finite numbers become `null`, matching JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      return `"${value.toString()}"`;
    case 'string':
      return JSON.stringify(value);
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }

  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString('base64'));
  if (Array.isArray(value)) return `[${value.map(serialise).join(',')}]`;

  // Respect a custom toJSON (e.g. class wrappers) before walking own keys.
  const maybe = value as { toJSON?: () => unknown };
  if (typeof maybe.toJSON === 'function') return serialise(maybe.toJSON());

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v !== 'undefined')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v)}`).join(',')}}`;
}
