import { canonicalJson } from '../../src/common/utils/canonical-json';

/**
 * These properties are load-bearing: the audit hash chain, prescription
 * signatures and idempotency fingerprints all assume that logically equal
 * documents serialise to identical bytes.
 */
describe('canonicalJson', () => {
  it('is insensitive to object key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively', () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const right = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it('preserves array order, which is semantically meaningful', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('survives a JSON round-trip (the jsonb normalisation case)', () => {
    const original = { zeta: 'z', alpha: { nested: true, count: 2 }, list: [{ b: 1, a: 2 }] };
    const roundTripped = JSON.parse(JSON.stringify(original));
    expect(canonicalJson(roundTripped)).toBe(canonicalJson(original));
  });

  it('distinguishes genuinely different documents', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('normalises null-ish and non-finite values instead of dropping them', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(Number.NaN)).toBe('null');
    expect(canonicalJson(Number.POSITIVE_INFINITY)).toBe('null');
    // `undefined` members keep their slot in an array…
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
    // …but an undefined *property* is omitted, matching JSON.stringify.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('serialises dates and buffers deterministically', () => {
    const when = new Date('2026-09-19T06:00:00.000Z');
    expect(canonicalJson({ when })).toBe('{"when":"2026-09-19T06:00:00.000Z"}');
    expect(canonicalJson(Buffer.from('hi'))).toBe('"aGk="');
  });

  it('escapes strings exactly like JSON.stringify', () => {
    const tricky = 'quote " backslash \\ newline \n unicode ☃';
    expect(canonicalJson(tricky)).toBe(JSON.stringify(tricky));
    expect(canonicalJson({ 'key"with"quotes': 1 })).toBe('{"key\\"with\\"quotes":1}');
  });

  it('honours a custom toJSON implementation', () => {
    class Money {
      constructor(private readonly amount: number) {}
      toJSON() {
        return { amount: this.amount, currency: 'INR' };
      }
    }
    expect(canonicalJson({ fee: new Money(950) })).toBe('{"fee":{"amount":950,"currency":"INR"}}');
  });
});
