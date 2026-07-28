/** Calculates age in whole years from a Date of birth, as of `now` (injectable for tests). */
export function calculateAge(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getFullYear() - dateOfBirth.getFullYear();

  const hasHadBirthdayThisYear =
    now.getMonth() > dateOfBirth.getMonth() ||
    (now.getMonth() === dateOfBirth.getMonth() && now.getDate() >= dateOfBirth.getDate());

  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}
