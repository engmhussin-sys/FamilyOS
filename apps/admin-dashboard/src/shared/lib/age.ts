/**
 * Calculates age in whole years from an ISO date string, as of `now`
 * (defaults to the real current date — injectable for deterministic tests).
 */
export function calculateAge(dateOfBirth: string, now: Date = new Date()): number {
  const birth = new Date(dateOfBirth);
  let age = now.getFullYear() - birth.getFullYear();

  const hasHadBirthdayThisYear =
    now.getMonth() > birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() >= birth.getDate());

  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}
