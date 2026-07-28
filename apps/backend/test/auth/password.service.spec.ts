import { PasswordService } from '../../src/modules/auth/application/services/password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes a password and successfully verifies the same plaintext', async () => {
    const hash = await service.hash('Sup3rSecret!');
    expect(hash).not.toBe('Sup3rSecret!');
    await expect(service.verify(hash, 'Sup3rSecret!')).resolves.toBe(true);
  });

  it('rejects an incorrect plaintext against a valid hash', async () => {
    const hash = await service.hash('Sup3rSecret!');
    await expect(service.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false (not a thrown error) for a malformed stored hash', async () => {
    await expect(service.verify('not-a-real-argon2-hash', 'anything')).resolves.toBe(false);
  });

  it('generates pairing codes in the XXXX-XXXX format with no ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = service.generatePairingCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01OI]/);
    }
  });
});
