import {
  CONSULTATION_TRANSITIONS,
  canTransition,
} from '../../src/modules/consultations/consultations.service';
import type { ConsultationStatus } from '../../src/modules/consultations/consultations.service';

const ALL: ConsultationStatus[] = ['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show'];

describe('consultation state machine', () => {
  it('allows only the clinically meaningful transitions', () => {
    expect(canTransition('scheduled', 'in_progress')).toBe(true);
    expect(canTransition('scheduled', 'cancelled')).toBe(true);
    expect(canTransition('scheduled', 'no_show')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('refuses to skip the consultation itself', () => {
    // A consultation cannot be completed without ever having started.
    expect(canTransition('scheduled', 'completed')).toBe(false);
  });

  it('treats completed, cancelled and no_show as terminal', () => {
    for (const terminal of ['completed', 'cancelled', 'no_show'] as ConsultationStatus[]) {
      expect(CONSULTATION_TRANSITIONS[terminal]).toEqual([]);
      for (const target of ALL) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('never allows a self-transition', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('has no path back out of a terminal state', () => {
    // Reachability: from any terminal state, the closure of allowed moves is empty.
    const reachable = (from: ConsultationStatus): Set<ConsultationStatus> => {
      const seen = new Set<ConsultationStatus>();
      const stack = [...(CONSULTATION_TRANSITIONS[from] ?? [])];
      while (stack.length) {
        const next = stack.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(...(CONSULTATION_TRANSITIONS[next] ?? []));
      }
      return seen;
    };
    expect(reachable('completed').size).toBe(0);
    expect(reachable('cancelled').size).toBe(0);
    expect([...reachable('scheduled')].sort()).toEqual(
      ['cancelled', 'completed', 'in_progress', 'no_show'].sort(),
    );
  });

  it('rejects unknown states without throwing', () => {
    expect(canTransition('bogus' as ConsultationStatus, 'completed')).toBe(false);
    expect(canTransition('scheduled', 'bogus' as ConsultationStatus)).toBe(false);
  });
});
