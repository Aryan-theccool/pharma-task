import { PasswordService } from '../../src/common/crypto/password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();

  it('verifies a correct password', async () => {
    const stored = await svc.hash('Str0ng!Passphrase2024');
    await expect(svc.verify('Str0ng!Passphrase2024', stored)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await svc.hash('Str0ng!Passphrase2024');
    await expect(svc.verify('Str0ng!Passphrase2025', stored)).resolves.toBe(false);
  });

  it('salts every hash, so identical passwords store differently', async () => {
    const [a, b] = await Promise.all([svc.hash('Same!Password123'), svc.hash('Same!Password123')]);
    expect(a).not.toBe(b);
    await expect(svc.verify('Same!Password123', a)).resolves.toBe(true);
    await expect(svc.verify('Same!Password123', b)).resolves.toBe(true);
  });

  it('stores a self-describing record so parameters can be migrated later', async () => {
    const [scheme, n, r, p] = (await svc.hash('Str0ng!Passphrase2024')).split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBe(32_768); // memory-hard
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('never throws on a malformed or hostile stored value', async () => {
    for (const stored of ['', 'garbage', 'scrypt$notanumber$8$1$aaaa$bbbb', 'bcrypt$12$xyz']) {
      await expect(svc.verify('anything', stored)).resolves.toBe(false);
    }
  });

  describe('strength policy', () => {
    it('accepts a strong passphrase', () => {
      expect(PasswordService.validateStrength('Str0ng!Passphrase2024')).toEqual([]);
    });

    it.each([
      ['Sh0rt!1', 'must be at least 12 characters'],
      ['alllowercase1!', 'must contain an uppercase letter'],
      ['ALLUPPERCASE1!', 'must contain a lowercase letter'],
      ['NoDigitsHere!!', 'must contain a digit'],
      ['NoSymbolsHere1', 'must contain a symbol'],
    ])('rejects %s', (candidate, reason) => {
      expect(PasswordService.validateStrength(candidate)).toContain(reason);
    });

    it('rejects passwords containing well-known breached words', () => {
      for (const weak of ['MyPassword123!', 'Qwerty!12345678', 'Amrutam!2024ab']) {
        expect(PasswordService.validateStrength(weak)).toContain(
          'must not contain a common breached word',
        );
      }
    });

    it('reports every violation at once rather than one at a time', () => {
      expect(PasswordService.validateStrength('short').length).toBeGreaterThan(2);
    });
  });
});
