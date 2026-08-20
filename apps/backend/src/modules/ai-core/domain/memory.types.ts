/** B8 adds `DISTRESS_SIGNAL` — an EVENT category (use `record`, never
 * `upsert`): each signal is its own occurrence and collapsing them into one
 * overwritten row would erase exactly the history a review queue needs. The
 * stored value is `{ code, businessDate, detectedAt }` and never the child's
 * text (`distress.ts`, §11.4). The schema already declares this column a plain
 * string precisely so a new category costs no migration. */
export type AiMemoryCategory =
  | 'HABIT'
  | 'PREFERENCE'
  | 'VIOLATION'
  | 'RECOMMENDATION'
  | 'CONFIDENCE'
  | 'DISTRESS_SIGNAL';

export interface IAiMemoryRecord {
  id: string;
  childId: string;
  category: AiMemoryCategory;
  key: string;
  value: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const AI_MEMORY_REPOSITORY = Symbol('AI_MEMORY_REPOSITORY');

export interface IAiMemoryRepository {
  /** State categories (HABIT/PREFERENCE/CONFIDENCE) — one current value
   * per (childId, category, key), overwritten on each call. */
  upsert(
    childId: string,
    category: AiMemoryCategory,
    key: string,
    value: Record<string, unknown>,
  ): Promise<void>;

  /** Event categories (VIOLATION/RECOMMENDATION) — always inserts a new
   * row (auto-generated key) so history/counting actually works. Using
   * `upsert` for these would silently collapse repeated violations of
   * the same type into one overwritten row — the exact opposite of
   * "repeated violations" (Sprint 7's own memory example). */
  record(
    childId: string,
    category: AiMemoryCategory,
    value: Record<string, unknown>,
  ): Promise<void>;

  find(childId: string, category: AiMemoryCategory, key: string): Promise<IAiMemoryRecord | null>;
  findAllByCategory(childId: string, category: AiMemoryCategory): Promise<IAiMemoryRecord[]>;
  countByCategorySince(childId: string, category: AiMemoryCategory, since: Date): Promise<number>;
}
