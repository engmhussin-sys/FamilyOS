import { IsString, Length } from 'class-validator';

/**
 * B8 — the ONLY DTO on the child coach surface that carries free text, and the
 * only one in the whole child surface at all.
 *
 * `Length(1, 500)` is a real bound, not decoration: this string is scanned by a
 * deterministic classifier and then discarded, and an unbounded field is how a
 * request body becomes a denial-of-service on a regex list.
 *
 * WHAT IS NOT HERE: `childId`. It is derived from the DEVICE in the verified
 * token via `PairingOrchestratorService.getChildAndFamilyIdForDevice`, exactly
 * as `ChildAchievementsController` does it — a device that posts another
 * child's id gains nothing because the value is never read.
 */
export class ChildCheckinDto {
  @IsString()
  @Length(1, 500)
  feeling!: string;
}
