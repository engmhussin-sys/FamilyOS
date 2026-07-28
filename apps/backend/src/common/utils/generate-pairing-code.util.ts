import { randomBytes } from 'crypto';

/**
 * Generates a short, human-typeable pairing code, e.g. "K7QF-3ZDP".
 * Deliberately duplicated (not imported) from
 * apps/backend/src/modules/auth/application/services/password.service.ts's
 * identical method — AuthModule doesn't export PasswordService, and
 * widening its export surface for one trivial utility function would
 * conflict with pairing-module-boundary.md's "Pairing doesn't pull Auth
 * internals it doesn't need" spirit. This is one small, stable function;
 * the duplication cost is lower than the coupling cost here.
 */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length];
    if (i === 3) code += '-';
  }
  return code;
}
