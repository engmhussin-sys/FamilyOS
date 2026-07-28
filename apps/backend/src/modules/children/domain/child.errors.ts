import { NotFoundException } from '@nestjs/common';

/**
 * Thrown whenever a childId does not resolve to an active child within the
 * caller's OWN family. Deliberately identical whether the child truly does
 * not exist or simply belongs to a different family — a 404 (not 403)
 * that also encodes "and it's not yours" would leak which child IDs are
 * valid to an attacker probing IDs across families.
 */
export class ChildNotFoundException extends NotFoundException {
  constructor(childId: string) {
    super(`Child "${childId}" was not found in your family.`);
  }
}
