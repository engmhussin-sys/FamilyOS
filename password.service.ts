import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

/**
 * All password/secret hashing in the system goes through this service.
 * Argon2id is used (not bcrypt) — it's the current OWASP recommendation
 * and is resistant to GPU-cracking in a way bcrypt is not.
 */
@Injectable()
export class PasswordService {
  private readonly argon2Options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19456, // ~19 MB, OWASP-recommended minimum for argon2id
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plainText: string): Promise<string> {
    return argon2.hash(plainText, this.argon2Options);
  }

  async verify(hash: string, plainText: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plainText);
    } catch {
      // argon2.verify throws on a malformed hash rather than returning
      // false — normalize that to a boolean so callers never need a
      // try/catch of their own.
      return false;
    }
  }

  /** Generates a short, human-typeable pairing code, e.g. "K7QF-3ZDP". */
  generatePairingCode(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
    const bytes = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += alphabet[bytes[i] % alphabet.length];
      if (i === 3) code += '-';
    }
    return code;
  }
}
