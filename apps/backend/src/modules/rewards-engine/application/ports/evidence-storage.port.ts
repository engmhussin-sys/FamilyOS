/**
 * B5 (PA-B-019) — THE STORAGE BOUNDARY.
 *
 * A child's recitation is the most sensitive object this product will ever
 * hold, and where those bytes live is an operational decision that will change
 * — local disk in development, an S3-compatible bucket in production, possibly
 * a region-pinned one per market. That decision must not be visible to
 * `AchievementEvidenceService`, and it must not be visible to any controller.
 *
 * FOUR VERBS, and no more. Deliberately not a general-purpose filesystem
 * interface: no listing, no renaming, no directory traversal, no signed-URL
 * generation. An S3 adapter implementing exactly this is a small class; an
 * adapter implementing a bigger interface would tempt a caller into
 * bucket-shaped thinking that local disk cannot honour.
 *
 * NO SIGNED URLS, and that is a security decision rather than an omission. A
 * signed URL is a bearer capability that leaves the application's authz
 * entirely — anyone holding the link reads a child's voice recording, with no
 * tenant check, for as long as the signature lives. Evidence is streamed back
 * through an authenticated, tenant-scoped route instead
 * (`GET /reward-programs/achievements/:id/evidence/:evidenceId`), so every
 * read is a decision the application makes with the caller's identity in hand.
 *
 * THE KEY IS TENANT-PREFIXED BY THE SERVICE, not by the adapter
 * (`<familyId>/<childId>/<achievementId>/<id>.<ext>`), so the prefix is
 * identical on every backend and a bucket policy or a filesystem ACL can be
 * written against it once.
 */
export const EVIDENCE_STORAGE = Symbol('EVIDENCE_STORAGE');

export interface IEvidenceStorage {
  /** Writes the bytes. Overwrites are impossible in practice because the key
   * contains a freshly generated uuid, so this never has to answer "what if it
   * exists" — a question local disk and S3 answer differently. */
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;

  /** Reads the bytes back for an authenticated, tenant-checked parent review.
   * Returns `null` for a key that is not there, so a row whose object was
   * swept by retention produces a 404 rather than a 500. */
  get(key: string): Promise<Buffer | null>;

  /** Used by the retention sweep. Deleting an absent key is a success —
   * retention must be re-runnable. */
  delete(key: string): Promise<void>;

  /** Named for the report and for `GET /system/diagnostics`: an operator has
   * to be able to see WHICH backend is live without reading the DI graph. */
  readonly backendName: string;
}
