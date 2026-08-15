import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

import { isValidTimeZone } from './family-date';

/**
 * B2 (PA-B-001). `Family.timezone` is the input to every business-date
 * decision in the backend. Before this decorator it was validated as
 * `@IsString() @MaxLength(50)` — so `"Cairo"`, `"GMT+2"`, `"UTC+2"` and
 * `"asdf"` were all accepted, stored, and then silently resolved to something
 * else (or nothing) by whatever eventually read them.
 *
 * A garbage timezone is worse here than a rejected one: `FamilyDateService`
 * degrades to UTC rather than crash a reward path, so a typo would not fail
 * loudly, it would move the whole family's calendar by two or three hours and
 * nobody would find out until a streak broke.
 *
 * Two things are rejected that `Intl` itself would accept:
 *   - FIXED OFFSETS (`"+03:00"`). Accepting one would let a family opt out of
 *     DST permanently. Egypt reintroduced DST in 2023 and this runtime's tzdata
 *     has the 2026 transitions; a pinned `+02:00` would be wrong for half the
 *     year, every year.
 *   - anything that is not a zone NAME.
 */
export function IsIanaTimeZone(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isValidTimeZone(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a real IANA timezone name such as "Africa/Cairo", "Asia/Riyadh" or "UTC". A fixed UTC offset is not accepted, because it cannot follow daylight-saving changes.`;
        },
      },
    });
  };
}
