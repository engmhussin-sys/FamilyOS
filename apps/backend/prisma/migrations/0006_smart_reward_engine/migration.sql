-- =============================================================================
-- 0006_smart_reward_engine — Sprint F4 (Smart Learning & Reward Engine).
--
-- ADDITIVE ONLY. Nothing is dropped, nothing is rewritten, no column changes
-- type or nullability. Written to be RE-RUNNABLE and written as if production
-- data already existed, for the same reason 0003/0005 were: the only version of
-- a migration that is safe on the day after the first customer is one that can
-- be run twice.
--
-- WHAT IT ADDS
--   enum values   RewardType   += 6 (ALTER TYPE ... ADD VALUE — no table rewrite)
--                 EventType    += 7
--   columns       reward_rules += program_id, multiplier_bps (both NULLABLE,
--                                 so every existing rule row stays valid)
--   tables        reward_program_categories  (GLOBAL reference, seeded)
--                 quran_surahs               (GLOBAL reference, seeded — 114 rows)
--                 reward_programs            (STRICT)
--                 achievement_requests       (STRICT)
--                 verification_attempts      (STRICT, append-only)
--                 screen_time_reward_grants  (STRICT)
--                 reward_fulfilments         (STRICT)
--
-- TENANCY (F2 / R8): the five STRICT tables carry `family_id uuid NOT NULL`
-- from creation with an ON DELETE CASCADE FK to families — there is no backfill
-- and no orphan case, so this migration needs no equivalent of 0003's step-3
-- abort block. All five are registered STRICT in
-- src/common/tenancy/tenant-model-registry.ts. The two reference tables are
-- GLOBAL with a written reason (a platform catalogue, and the mushaf).
--
-- WHY `ALTER TYPE ... ADD VALUE` AND NOT A NEW ENUM: adding a value to a
-- PostgreSQL enum does not rewrite the table and does not invalidate existing
-- rows or the CHECK constraints migration 0002 put on rewards_ledger_entries.
-- Replacing the type would have done both. Each ADD VALUE is guarded by
-- IF NOT EXISTS (PostgreSQL 12+), which is what makes this file re-runnable.
-- =============================================================================

-- --- 1. enum values (additive) ----------------------------------------------
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'SCREEN_TIME';
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'PHYSICAL_REWARD';
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'DIGITAL_REWARD';
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'PRIVILEGE';
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'PARENT_APPROVAL_REWARD';
ALTER TYPE "RewardType" ADD VALUE IF NOT EXISTS 'CUSTOM_REWARD';

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'REWARD_PROGRAM_CREATED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_REQUESTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_VERIFIED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'ACHIEVEMENT_REJECTED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'QURAN_ACHIEVEMENT_COMPLETED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'LEARNING_GOAL_COMPLETED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BADGE_EARNED';

-- --- 2. reference tables ----------------------------------------------------
CREATE TABLE IF NOT EXISTS "reward_program_categories" (
  "code"        VARCHAR(40)  NOT NULL,
  "label_ar"    TEXT         NOT NULL,
  "streak_kind" VARCHAR(20)  NOT NULL,
  "sort_order"  INTEGER      NOT NULL DEFAULT 0,
  "is_active"   BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_program_categories_pkey" PRIMARY KEY ("code")
);

CREATE TABLE IF NOT EXISTS "quran_surahs" (
  "number"          INTEGER     NOT NULL,
  "name_ar"         TEXT        NOT NULL,
  "transliteration" TEXT        NOT NULL,
  "ayah_count"      INTEGER     NOT NULL,
  "revelation_type" VARCHAR(10) NOT NULL,
  CONSTRAINT "quran_surahs_pkey" PRIMARY KEY ("number"),
  -- The classification is closed. A typo becomes a failed INSERT rather than a
  -- third revelation type nobody validates against.
  CONSTRAINT "quran_surahs_revelation_type_check" CHECK ("revelation_type" IN ('MECCAN', 'MEDINAN'))
);

-- Re-runnability on a database created by an earlier draft of this file, which
-- had only (number, name_ar, ayah_count). Both columns are added NOT NULL with
-- a DEFAULT and then the default is dropped, so no row is ever left invalid.
ALTER TABLE "quran_surahs" ADD COLUMN IF NOT EXISTS "transliteration" TEXT NOT NULL DEFAULT '';
ALTER TABLE "quran_surahs" ADD COLUMN IF NOT EXISTS "revelation_type" VARCHAR(10) NOT NULL DEFAULT 'MECCAN';
ALTER TABLE "quran_surahs" ALTER COLUMN "transliteration" DROP DEFAULT;
ALTER TABLE "quran_surahs" ALTER COLUMN "revelation_type" DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quran_surahs_revelation_type_check') THEN
    ALTER TABLE "quran_surahs" ADD CONSTRAINT "quran_surahs_revelation_type_check"
      CHECK ("revelation_type" IN ('MECCAN', 'MEDINAN'));
  END IF;
END
$$;

-- --- 3. programs ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "reward_programs" (
  "family_id"                UUID         NOT NULL,
  "id"                       UUID         NOT NULL,
  "child_id"                 UUID,
  "category"                 VARCHAR(40)  NOT NULL,
  "activity"                 VARCHAR(40)  NOT NULL,
  "target_spec"              JSONB        NOT NULL,
  "target_summary_ar"        TEXT         NOT NULL,
  "duration_minutes"         INTEGER      NOT NULL,
  "verification_level"       VARCHAR(40)  NOT NULL,
  "verification_config"      JSONB        NOT NULL DEFAULT '{}',
  "reward_spec"              JSONB        NOT NULL,
  "frequency"                VARCHAR(20)  NOT NULL DEFAULT 'DAILY',
  "max_per_day"              INTEGER      NOT NULL DEFAULT 1,
  "max_per_week"             INTEGER      NOT NULL DEFAULT 7,
  "min_age"                  INTEGER      NOT NULL DEFAULT 0,
  "difficulty"               VARCHAR(20)  NOT NULL DEFAULT 'MEDIUM',
  "requires_parent_approval" BOOLEAN      NOT NULL DEFAULT false,
  "expires_at"               TIMESTAMP(3),
  "streak_multiplier_bps"    INTEGER      NOT NULL DEFAULT 30000,
  "status"                   VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  "created_by_user_id"       UUID         NOT NULL,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  "archived_at"              TIMESTAMP(3),
  CONSTRAINT "reward_programs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reward_programs_family_id_status_idx"   ON "reward_programs" ("family_id", "status");
CREATE INDEX IF NOT EXISTS "reward_programs_child_id_status_idx"    ON "reward_programs" ("child_id", "status");
CREATE INDEX IF NOT EXISTS "reward_programs_family_id_category_idx" ON "reward_programs" ("family_id", "category");

-- --- 4. achievements --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "achievement_requests" (
  "family_id"                   UUID         NOT NULL,
  "id"                          UUID         NOT NULL,
  "program_id"                  UUID         NOT NULL,
  "child_id"                    UUID         NOT NULL,
  "status"                      VARCHAR(20)  NOT NULL DEFAULT 'REQUESTED',
  "local_date"                  DATE         NOT NULL,
  "attempt_no"                  INTEGER      NOT NULL DEFAULT 1,
  "started_at"                  TIMESTAMP(3),
  "submitted_at"                TIMESTAMP(3),
  "decided_at"                  TIMESTAMP(3),
  "decided_by_user_id"          UUID,
  "elapsed_minutes"             INTEGER,
  "applied_multiplier_bps"      INTEGER,
  "streak_days_at_verification" INTEGER,
  "granted_amount"              INTEGER,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "achievement_requests_pkey" PRIMARY KEY ("id")
);

-- The quota primitive. `maxPerDay` is COUNTED against this table, and this
-- unique index is what makes "start today's attempt" idempotent: a retried
-- start collides instead of opening a second attempt.
CREATE UNIQUE INDEX IF NOT EXISTS "achievement_requests_program_id_child_id_local_date_attempt_key"
  ON "achievement_requests" ("program_id", "child_id", "local_date", "attempt_no");
CREATE INDEX IF NOT EXISTS "achievement_requests_family_id_status_idx"
  ON "achievement_requests" ("family_id", "status");
CREATE INDEX IF NOT EXISTS "achievement_requests_child_id_local_date_idx"
  ON "achievement_requests" ("child_id", "local_date");
CREATE INDEX IF NOT EXISTS "achievement_requests_program_id_child_id_local_date_idx"
  ON "achievement_requests" ("program_id", "child_id", "local_date");

-- --- 5. verification attempts (append-only) ---------------------------------
CREATE TABLE IF NOT EXISTS "verification_attempts" (
  "family_id"        UUID         NOT NULL,
  "id"               UUID         NOT NULL,
  "achievement_id"   UUID         NOT NULL,
  "child_id"         UUID         NOT NULL,
  "method"           VARCHAR(40)  NOT NULL,
  "result"           VARCHAR(20)  NOT NULL,
  "score_percent"    INTEGER,
  "reason_code"      VARCHAR(60)  NOT NULL,
  "evidence_ref"     TEXT,
  "attempt_number"   INTEGER      NOT NULL,
  "verifier_type"    VARCHAR(20)  NOT NULL,
  "verifier_user_id" UUID,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "verification_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "verification_attempts_achievement_id_attempt_number_key"
  ON "verification_attempts" ("achievement_id", "attempt_number");
CREATE INDEX IF NOT EXISTS "verification_attempts_family_id_created_at_idx"
  ON "verification_attempts" ("family_id", "created_at");
CREATE INDEX IF NOT EXISTS "verification_attempts_child_id_created_at_idx"
  ON "verification_attempts" ("child_id", "created_at");

-- --- 6. screen-time reward grants -------------------------------------------
CREATE TABLE IF NOT EXISTS "screen_time_reward_grants" (
  "family_id"          UUID         NOT NULL,
  "id"                 UUID         NOT NULL,
  "child_id"           UUID         NOT NULL,
  "achievement_id"     UUID,
  "ledger_entry_id"    UUID         NOT NULL,
  "minutes"            INTEGER      NOT NULL,
  "granted_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"         TIMESTAMP(3) NOT NULL,
  "revoked_at"         TIMESTAMP(3),
  "revoked_by_user_id" UUID,
  "revoke_reason"      TEXT,
  CONSTRAINT "screen_time_reward_grants_pkey" PRIMARY KEY ("id")
);

-- ONE grant per ledger entry, enforced by PostgreSQL. This is what makes a
-- redelivered REWARD_GRANTED unable to mint a second block of minutes —
-- CONTEXT §3 principle 6, applied to a side effect rather than to points.
CREATE UNIQUE INDEX IF NOT EXISTS "screen_time_reward_grants_ledger_entry_id_key"
  ON "screen_time_reward_grants" ("ledger_entry_id");
CREATE INDEX IF NOT EXISTS "screen_time_reward_grants_child_id_expires_at_idx"
  ON "screen_time_reward_grants" ("child_id", "expires_at");
CREATE INDEX IF NOT EXISTS "screen_time_reward_grants_family_id_idx"
  ON "screen_time_reward_grants" ("family_id");

-- --- 7. fulfilment state machine --------------------------------------------
CREATE TABLE IF NOT EXISTS "reward_fulfilments" (
  "family_id"          UUID         NOT NULL,
  "id"                 UUID         NOT NULL,
  "child_id"           UUID         NOT NULL,
  "achievement_id"     UUID,
  "ledger_entry_id"    UUID         NOT NULL,
  "reward_type"        VARCHAR(40)  NOT NULL,
  "description"        TEXT         NOT NULL,
  "quantity"           INTEGER      NOT NULL DEFAULT 1,
  "status"             VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  "decided_at"         TIMESTAMP(3),
  "decided_by_user_id" UUID,
  "fulfilled_at"       TIMESTAMP(3),
  "note"               TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reward_fulfilments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reward_fulfilments_ledger_entry_id_key"
  ON "reward_fulfilments" ("ledger_entry_id");
CREATE INDEX IF NOT EXISTS "reward_fulfilments_family_id_status_idx"
  ON "reward_fulfilments" ("family_id", "status");
CREATE INDEX IF NOT EXISTS "reward_fulfilments_child_id_status_idx"
  ON "reward_fulfilments" ("child_id", "status");

-- --- 8. reward_rules: the EXTENSION, not a parallel table -------------------
-- Both columns are NULLABLE with no DEFAULT, deliberately: every rule that
-- exists today (hand-authored family rules and NULL-family platform rules) is
-- still valid with both columns NULL, and NULL is what excludes them from the
-- partial unique index below.
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "program_id"     UUID;
ALTER TABLE "reward_rules" ADD COLUMN IF NOT EXISTS "multiplier_bps" INTEGER;

CREATE INDEX IF NOT EXISTS "reward_rules_program_id_idx" ON "reward_rules" ("program_id");

-- One companion rule per (program, multiplier tier). PARTIAL, so it constrains
-- only the rows F4 materialises and never touches a pre-existing rule. This is
-- what lets materialisation be an `ON CONFLICT DO NOTHING` insert — idempotent
-- by constraint, not by a check-then-insert race.
CREATE UNIQUE INDEX IF NOT EXISTS "reward_rules_program_id_multiplier_bps_key"
  ON "reward_rules" ("program_id", "multiplier_bps")
  WHERE "program_id" IS NOT NULL;

-- --- 9. foreign keys (last, per 0003's ordering rationale) ------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_programs_family_id_fkey') THEN
    ALTER TABLE "reward_programs" ADD CONSTRAINT "reward_programs_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_programs_child_id_fkey') THEN
    ALTER TABLE "reward_programs" ADD CONSTRAINT "reward_programs_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_programs_category_fkey') THEN
    ALTER TABLE "reward_programs" ADD CONSTRAINT "reward_programs_category_fkey"
      FOREIGN KEY ("category") REFERENCES "reward_program_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_programs_created_by_user_id_fkey') THEN
    ALTER TABLE "reward_programs" ADD CONSTRAINT "reward_programs_created_by_user_id_fkey"
      FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_requests_family_id_fkey') THEN
    ALTER TABLE "achievement_requests" ADD CONSTRAINT "achievement_requests_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_requests_program_id_fkey') THEN
    ALTER TABLE "achievement_requests" ADD CONSTRAINT "achievement_requests_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "reward_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_requests_child_id_fkey') THEN
    ALTER TABLE "achievement_requests" ADD CONSTRAINT "achievement_requests_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_attempts_family_id_fkey') THEN
    ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_attempts_achievement_id_fkey') THEN
    ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_achievement_id_fkey"
      FOREIGN KEY ("achievement_id") REFERENCES "achievement_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_attempts_child_id_fkey') THEN
    ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_time_reward_grants_family_id_fkey') THEN
    ALTER TABLE "screen_time_reward_grants" ADD CONSTRAINT "screen_time_reward_grants_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_time_reward_grants_child_id_fkey') THEN
    ALTER TABLE "screen_time_reward_grants" ADD CONSTRAINT "screen_time_reward_grants_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_time_reward_grants_achievement_id_fkey') THEN
    ALTER TABLE "screen_time_reward_grants" ADD CONSTRAINT "screen_time_reward_grants_achievement_id_fkey"
      FOREIGN KEY ("achievement_id") REFERENCES "achievement_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_fulfilments_family_id_fkey') THEN
    ALTER TABLE "reward_fulfilments" ADD CONSTRAINT "reward_fulfilments_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_fulfilments_child_id_fkey') THEN
    ALTER TABLE "reward_fulfilments" ADD CONSTRAINT "reward_fulfilments_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_fulfilments_achievement_id_fkey') THEN
    ALTER TABLE "reward_fulfilments" ADD CONSTRAINT "reward_fulfilments_achievement_id_fkey"
      FOREIGN KEY ("achievement_id") REFERENCES "achievement_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reward_rules_program_id_fkey') THEN
    ALTER TABLE "reward_rules" ADD CONSTRAINT "reward_rules_program_id_fkey"
      FOREIGN KEY ("program_id") REFERENCES "reward_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- 10. RLS, replaying 0004's block verbatim for the five STRICT tables ----
-- Same policy names, same setting name (`app.current_family_id`), the same
-- NULLIF(...) guard 0004 had to introduce (F2 §7: set_config with is_local
-- returns '' and not NULL after COMMIT), and the same explicit owner bypass.
-- The two reference tables are deliberately NOT included: they are GLOBAL, and
-- a tenant policy on them would hide the mushaf from every family.
DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    FOREACH t IN ARRAY ARRAY['reward_programs', 'achievement_requests', 'verification_attempts',
                             'screen_time_reward_grants', 'reward_fulfilments'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO abny_app', t);
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I '
        'USING (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid) '
        'WITH CHECK (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid)',
        t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_bypass_owner ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_bypass_owner ON %I TO %I USING (true) WITH CHECK (true)',
        t, current_user);
    END LOOP;

    -- APPEND-ONLY BY PRIVILEGE, not by convention — the same treatment 0004
    -- gave rewards_ledger_entries and audit_logs. A verification decision that
    -- can be edited afterwards is not evidence (CONTEXT §3 principle 9).
    EXECUTE 'REVOKE UPDATE, DELETE ON "verification_attempts" FROM abny_app';

    -- The reference catalogues are readable by everyone and writable by nobody
    -- except the migration owner.
    EXECUTE 'GRANT SELECT ON "reward_program_categories" TO abny_app';
    EXECUTE 'GRANT SELECT ON "quran_surahs" TO abny_app';
  END IF;
END
$$;

-- --- 11. SEED DATA ----------------------------------------------------------
-- Generated FROM src/shared/rewards/program-taxonomy.ts and
-- src/shared/rewards/quran.ts, and asserted equal to them at runtime by
-- test/rewards/quran-reference.spec.ts. Two copies of a constant only stay in
-- agreement if something FAILS when they diverge.
--
-- `ON CONFLICT DO UPDATE` rather than DO NOTHING: a label correction in a later
-- release should reach an existing database when this file is replayed, while
-- an operator-added nineteenth category is left alone.
INSERT INTO "reward_program_categories" ("code", "label_ar", "streak_kind", "sort_order") VALUES
('QURAN', 'قرآن', 'quran', 10),
  ('HADITH', 'حديث', 'quran', 20),
  ('FIQH', 'فقه', 'learning', 30),
  ('MANNERS', 'أدب وسلوك', 'behaviour', 40),
  ('STUDY', 'دراسة', 'learning', 50),
  ('SCIENCE', 'علوم', 'learning', 60),
  ('MATH', 'رياضيات', 'learning', 70),
  ('PROGRAMMING', 'برمجة', 'learning', 80),
  ('READING', 'قراءة', 'reading', 90),
  ('SPORT', 'رياضة', 'exercise', 100),
  ('ENGLISH', 'إنجليزي', 'learning', 110),
  ('ARABIC', 'عربي', 'learning', 120),
  ('SKILLS', 'مهارات', 'learning', 130),
  ('HOUSEWORK', 'أعمال منزلية', 'behaviour', 140),
  ('HEALTH', 'صحة', 'exercise', 150),
  ('HABITS', 'عادات', 'behaviour', 160),
  ('VOLUNTEERING', 'تطوع', 'behaviour', 170),
  ('CREATIVITY', 'إبداع', 'learning', 180)
ON CONFLICT ("code") DO UPDATE
  SET "label_ar" = EXCLUDED."label_ar",
      "streak_kind" = EXCLUDED."streak_kind",
      "sort_order" = EXCLUDED."sort_order";

-- The 114 surahs: Arabic name, transliteration, Hafs ayah count, revelation
-- type. Two checksums the test suite asserts against THIS TABLE (not only
-- against the TypeScript constant): SUM(ayah_count) = 6236, and
-- COUNT(*) FILTER (WHERE revelation_type = 'MEDINAN') = 28.
INSERT INTO "quran_surahs" ("number", "name_ar", "transliteration", "ayah_count", "revelation_type") VALUES
  (1, 'الفاتحة', 'Al-Fatihah', 7, 'MECCAN'),
  (2, 'البقرة', 'Al-Baqarah', 286, 'MEDINAN'),
  (3, 'آل عمران', 'Ali Imran', 200, 'MEDINAN'),
  (4, 'النساء', 'An-Nisa', 176, 'MEDINAN'),
  (5, 'المائدة', 'Al-Maidah', 120, 'MEDINAN'),
  (6, 'الأنعام', 'Al-Anam', 165, 'MECCAN'),
  (7, 'الأعراف', 'Al-Araf', 206, 'MECCAN'),
  (8, 'الأنفال', 'Al-Anfal', 75, 'MEDINAN'),
  (9, 'التوبة', 'At-Tawbah', 129, 'MEDINAN'),
  (10, 'يونس', 'Yunus', 109, 'MECCAN'),
  (11, 'هود', 'Hud', 123, 'MECCAN'),
  (12, 'يوسف', 'Yusuf', 111, 'MECCAN'),
  (13, 'الرعد', 'Ar-Rad', 43, 'MEDINAN'),
  (14, 'إبراهيم', 'Ibrahim', 52, 'MECCAN'),
  (15, 'الحجر', 'Al-Hijr', 99, 'MECCAN'),
  (16, 'النحل', 'An-Nahl', 128, 'MECCAN'),
  (17, 'الإسراء', 'Al-Isra', 111, 'MECCAN'),
  (18, 'الكهف', 'Al-Kahf', 110, 'MECCAN'),
  (19, 'مريم', 'Maryam', 98, 'MECCAN'),
  (20, 'طه', 'Ta-Ha', 135, 'MECCAN'),
  (21, 'الأنبياء', 'Al-Anbiya', 112, 'MECCAN'),
  (22, 'الحج', 'Al-Hajj', 78, 'MEDINAN'),
  (23, 'المؤمنون', 'Al-Muminun', 118, 'MECCAN'),
  (24, 'النور', 'An-Nur', 64, 'MEDINAN'),
  (25, 'الفرقان', 'Al-Furqan', 77, 'MECCAN'),
  (26, 'الشعراء', 'Ash-Shuara', 227, 'MECCAN'),
  (27, 'النمل', 'An-Naml', 93, 'MECCAN'),
  (28, 'القصص', 'Al-Qasas', 88, 'MECCAN'),
  (29, 'العنكبوت', 'Al-Ankabut', 69, 'MECCAN'),
  (30, 'الروم', 'Ar-Rum', 60, 'MECCAN'),
  (31, 'لقمان', 'Luqman', 34, 'MECCAN'),
  (32, 'السجدة', 'As-Sajdah', 30, 'MECCAN'),
  (33, 'الأحزاب', 'Al-Ahzab', 73, 'MEDINAN'),
  (34, 'سبأ', 'Saba', 54, 'MECCAN'),
  (35, 'فاطر', 'Fatir', 45, 'MECCAN'),
  (36, 'يس', 'Ya-Sin', 83, 'MECCAN'),
  (37, 'الصافات', 'As-Saffat', 182, 'MECCAN'),
  (38, 'ص', 'Sad', 88, 'MECCAN'),
  (39, 'الزمر', 'Az-Zumar', 75, 'MECCAN'),
  (40, 'غافر', 'Ghafir', 85, 'MECCAN'),
  (41, 'فصلت', 'Fussilat', 54, 'MECCAN'),
  (42, 'الشورى', 'Ash-Shura', 53, 'MECCAN'),
  (43, 'الزخرف', 'Az-Zukhruf', 89, 'MECCAN'),
  (44, 'الدخان', 'Ad-Dukhan', 59, 'MECCAN'),
  (45, 'الجاثية', 'Al-Jathiyah', 37, 'MECCAN'),
  (46, 'الأحقاف', 'Al-Ahqaf', 35, 'MECCAN'),
  (47, 'محمد', 'Muhammad', 38, 'MEDINAN'),
  (48, 'الفتح', 'Al-Fath', 29, 'MEDINAN'),
  (49, 'الحجرات', 'Al-Hujurat', 18, 'MEDINAN'),
  (50, 'ق', 'Qaf', 45, 'MECCAN'),
  (51, 'الذاريات', 'Adh-Dhariyat', 60, 'MECCAN'),
  (52, 'الطور', 'At-Tur', 49, 'MECCAN'),
  (53, 'النجم', 'An-Najm', 62, 'MECCAN'),
  (54, 'القمر', 'Al-Qamar', 55, 'MECCAN'),
  (55, 'الرحمن', 'Ar-Rahman', 78, 'MEDINAN'),
  (56, 'الواقعة', 'Al-Waqiah', 96, 'MECCAN'),
  (57, 'الحديد', 'Al-Hadid', 29, 'MEDINAN'),
  (58, 'المجادلة', 'Al-Mujadilah', 22, 'MEDINAN'),
  (59, 'الحشر', 'Al-Hashr', 24, 'MEDINAN'),
  (60, 'الممتحنة', 'Al-Mumtahanah', 13, 'MEDINAN'),
  (61, 'الصف', 'As-Saff', 14, 'MEDINAN'),
  (62, 'الجمعة', 'Al-Jumuah', 11, 'MEDINAN'),
  (63, 'المنافقون', 'Al-Munafiqun', 11, 'MEDINAN'),
  (64, 'التغابن', 'At-Taghabun', 18, 'MEDINAN'),
  (65, 'الطلاق', 'At-Talaq', 12, 'MEDINAN'),
  (66, 'التحريم', 'At-Tahrim', 12, 'MEDINAN'),
  (67, 'الملك', 'Al-Mulk', 30, 'MECCAN'),
  (68, 'القلم', 'Al-Qalam', 52, 'MECCAN'),
  (69, 'الحاقة', 'Al-Haqqah', 52, 'MECCAN'),
  (70, 'المعارج', 'Al-Maarij', 44, 'MECCAN'),
  (71, 'نوح', 'Nuh', 28, 'MECCAN'),
  (72, 'الجن', 'Al-Jinn', 28, 'MECCAN'),
  (73, 'المزمل', 'Al-Muzzammil', 20, 'MECCAN'),
  (74, 'المدثر', 'Al-Muddaththir', 56, 'MECCAN'),
  (75, 'القيامة', 'Al-Qiyamah', 40, 'MECCAN'),
  (76, 'الإنسان', 'Al-Insan', 31, 'MEDINAN'),
  (77, 'المرسلات', 'Al-Mursalat', 50, 'MECCAN'),
  (78, 'النبأ', 'An-Naba', 40, 'MECCAN'),
  (79, 'النازعات', 'An-Naziat', 46, 'MECCAN'),
  (80, 'عبس', 'Abasa', 42, 'MECCAN'),
  (81, 'التكوير', 'At-Takwir', 29, 'MECCAN'),
  (82, 'الانفطار', 'Al-Infitar', 19, 'MECCAN'),
  (83, 'المطففين', 'Al-Mutaffifin', 36, 'MECCAN'),
  (84, 'الانشقاق', 'Al-Inshiqaq', 25, 'MECCAN'),
  (85, 'البروج', 'Al-Buruj', 22, 'MECCAN'),
  (86, 'الطارق', 'At-Tariq', 17, 'MECCAN'),
  (87, 'الأعلى', 'Al-Ala', 19, 'MECCAN'),
  (88, 'الغاشية', 'Al-Ghashiyah', 26, 'MECCAN'),
  (89, 'الفجر', 'Al-Fajr', 30, 'MECCAN'),
  (90, 'البلد', 'Al-Balad', 20, 'MECCAN'),
  (91, 'الشمس', 'Ash-Shams', 15, 'MECCAN'),
  (92, 'الليل', 'Al-Layl', 21, 'MECCAN'),
  (93, 'الضحى', 'Ad-Duha', 11, 'MECCAN'),
  (94, 'الشرح', 'Ash-Sharh', 8, 'MECCAN'),
  (95, 'التين', 'At-Tin', 8, 'MECCAN'),
  (96, 'العلق', 'Al-Alaq', 19, 'MECCAN'),
  (97, 'القدر', 'Al-Qadr', 5, 'MECCAN'),
  (98, 'البينة', 'Al-Bayyinah', 8, 'MEDINAN'),
  (99, 'الزلزلة', 'Az-Zalzalah', 8, 'MEDINAN'),
  (100, 'العاديات', 'Al-Adiyat', 11, 'MECCAN'),
  (101, 'القارعة', 'Al-Qariah', 11, 'MECCAN'),
  (102, 'التكاثر', 'At-Takathur', 8, 'MECCAN'),
  (103, 'العصر', 'Al-Asr', 3, 'MECCAN'),
  (104, 'الهمزة', 'Al-Humazah', 9, 'MECCAN'),
  (105, 'الفيل', 'Al-Fil', 5, 'MECCAN'),
  (106, 'قريش', 'Quraysh', 4, 'MECCAN'),
  (107, 'الماعون', 'Al-Maun', 7, 'MECCAN'),
  (108, 'الكوثر', 'Al-Kawthar', 3, 'MECCAN'),
  (109, 'الكافرون', 'Al-Kafirun', 6, 'MECCAN'),
  (110, 'النصر', 'An-Nasr', 3, 'MEDINAN'),
  (111, 'المسد', 'Al-Masad', 5, 'MECCAN'),
  (112, 'الإخلاص', 'Al-Ikhlas', 4, 'MECCAN'),
  (113, 'الفلق', 'Al-Falaq', 5, 'MECCAN'),
  (114, 'الناس', 'An-Nas', 6, 'MECCAN')
ON CONFLICT ("number") DO UPDATE
  SET "name_ar"         = EXCLUDED."name_ar",
      "transliteration" = EXCLUDED."transliteration",
      "ayah_count"      = EXCLUDED."ayah_count",
      "revelation_type" = EXCLUDED."revelation_type";
