-- =============================================================================
-- 0008_notification_idempotency_quiz_bank_evidence — Phase B, steps B9 + B5.
--
-- THREE DEFECTS, ONE MIGRATION, because all three are the same shape: a rule
-- the product depends on that lives in code instead of in the database.
--
--   B9 · PA-B-007 / PA-B-008 — `notifications` had NO causal column and NO
--        unique index. Deduplication was `findFirst` over a five-minute window
--        followed by `create`. The project's own «KNOWN LIMIT» test measured
--        the consequence: delete the `consumed_messages` marker, move past the
--        window, redeliver the outbox message, and ONE reward produced TWO
--        notifications. Every other link in the CONTEXT §5 chain is a UNIQUE
--        index; this one was an `if`.
--
--   B5 · PA-B-017 — no question bank and no answer key existed anywhere in the
--        repository, while `QUIZ` and `CODE_CHALLENGE` carried
--        `canAutoApprove: true` and read the score from the child's device.
--
--   B5 · PA-B-019 — no upload path existed for `RECITATION_SUBMISSION` or
--        `COMPLETION_ARTIFACT`, so every Quran program was unreachable.
--
-- ADDITIVE AND RE-RUNNABLE, for the reason 0003/0005/0006/0007 were: the only
-- version of a migration that is safe the day after the first customer is one
-- that can be run twice.
--
-- TENANCY. `quiz_assignments` and `achievement_evidence` are STRICT
-- (`family_id uuid NOT NULL`, registered in `tenant-model-registry.ts`, RLS
-- below replays 0004's block verbatim). `quiz_questions` is SHARED_NULL — the
-- same class `reward_rules` has used since Sprint 25 and B4 seeded 16 rows
-- through — so a platform question (`family_id IS NULL`) is visible to every
-- family and a family-authored one is not. No new tenancy mechanism.
-- =============================================================================

-- --- 1. notifications.source_event_id ---------------------------------------
--
-- Added NULLABLE, backfilled, then set NOT NULL. Three statements rather than
-- one `ADD COLUMN ... NOT NULL DEFAULT` because a default would be a way for a
-- future writer to omit the value and still succeed, which is precisely the
-- behaviour this column exists to make impossible.
--
-- THE BACKFILL is `legacy:<id>`: every pre-B9 row keeps its identity, is
-- trivially unique (the primary key is), and is visibly distinguishable in
-- production from anything a producer composed. It deliberately does NOT try to
-- reconstruct which domain event caused a historical notification — that
-- information was never recorded, and inventing it would put a fabricated
-- causal chain into an audit trail.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "source_event_id" VARCHAR(200);

UPDATE "notifications"
   SET "source_event_id" = 'legacy:' || "id"::text
 WHERE "source_event_id" IS NULL;

ALTER TABLE "notifications" ALTER COLUMN "source_event_id" SET NOT NULL;

-- THE CONSTRAINT. See the schema.prisma docstring for why `user_id` is in the
-- key and `type` is not.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_family_id_source_event_id_user_id_key"
  ON "notifications" ("family_id", "source_event_id", "user_id");

-- --- 2. child_messages.source_event_id --------------------------------------
--
-- The CHILD half of the notification surface.
-- `SmartNotificationIntegrationService.deliver` routes PARENT candidates to
-- `notifications` and CHILD candidates here, so a child-targeted notification
-- is a `child_messages` row and had the same exposure — with no five-minute
-- window in front of it at all.
--
-- NULLABLE, unlike `notifications`, and that is a stated distinction: this
-- table also holds PARENT-AUTHORED messages, which are caused by no event and
-- must not be deduplicated (a parent may send «أحسنت» twice on purpose). NULL
-- means «a human wrote this», and PostgreSQL treats NULLs as distinct in a
-- unique index, so the index below binds exactly the machine-generated rows.
ALTER TABLE "child_messages" ADD COLUMN IF NOT EXISTS "source_event_id" VARCHAR(200);

CREATE UNIQUE INDEX IF NOT EXISTS "child_messages_family_id_source_event_id_key"
  ON "child_messages" ("family_id", "source_event_id");

-- --- 3. quiz_questions — the bank and the answer key ------------------------
CREATE TABLE IF NOT EXISTS "quiz_questions" (
  "family_id"            UUID,
  "id"                   UUID         NOT NULL,
  "category"             VARCHAR(40)  NOT NULL,
  "subject"              VARCHAR(80),
  "difficulty"           VARCHAR(20)  NOT NULL DEFAULT 'EASY',
  "min_age"              INTEGER,
  "max_age"              INTEGER,
  "prompt_ar"            TEXT         NOT NULL,
  "choices"              JSONB        NOT NULL,
  "correct_choice_index" INTEGER      NOT NULL,
  "explanation_ar"       TEXT,
  "is_active"            BOOLEAN      NOT NULL DEFAULT true,
  "created_by_user_id"   UUID,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "quiz_questions_pkey" PRIMARY KEY ("id")
);

-- The answer key must point INSIDE the choice list, and a one-choice question
-- is not a question. Enforced here rather than only in the DTO, because the
-- seed below and any future admin path bypass the DTO entirely.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_questions_choices_chk') THEN
    ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_choices_chk"
      CHECK (jsonb_typeof("choices") = 'array'
             AND jsonb_array_length("choices") BETWEEN 2 AND 6
             AND "correct_choice_index" >= 0
             AND "correct_choice_index" < jsonb_array_length("choices"));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "quiz_questions_family_id_category_is_active_idx"
  ON "quiz_questions" ("family_id", "category", "is_active");
CREATE INDEX IF NOT EXISTS "quiz_questions_category_is_active_idx"
  ON "quiz_questions" ("category", "is_active");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_questions_family_id_fkey') THEN
    ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- 4. quiz_assignments — what the server served ---------------------------
CREATE TABLE IF NOT EXISTS "quiz_assignments" (
  "family_id"      UUID         NOT NULL,
  "id"             UUID         NOT NULL,
  "achievement_id" UUID         NOT NULL,
  "child_id"       UUID         NOT NULL,
  "attempt_no"     INTEGER      NOT NULL,
  "question_ids"   JSONB        NOT NULL,
  "total_count"    INTEGER      NOT NULL,
  "served_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "graded_at"      TIMESTAMP(3),
  "correct_count"  INTEGER,
  CONSTRAINT "quiz_assignments_pkey" PRIMARY KEY ("id")
);

-- ONE SERVED SET PER ATTEMPT, as a constraint. A second `GET .../quiz` inside
-- the same attempt returns the same questions instead of re-rolling until an
-- easy draw appears; two concurrent serves collide here rather than racing.
CREATE UNIQUE INDEX IF NOT EXISTS "quiz_assignments_achievement_id_attempt_no_key"
  ON "quiz_assignments" ("achievement_id", "attempt_no");
CREATE INDEX IF NOT EXISTS "quiz_assignments_family_id_child_id_idx"
  ON "quiz_assignments" ("family_id", "child_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_assignments_family_id_fkey') THEN
    ALTER TABLE "quiz_assignments" ADD CONSTRAINT "quiz_assignments_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_assignments_achievement_id_fkey') THEN
    ALTER TABLE "quiz_assignments" ADD CONSTRAINT "quiz_assignments_achievement_id_fkey"
      FOREIGN KEY ("achievement_id") REFERENCES "achievement_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quiz_assignments_child_id_fkey') THEN
    ALTER TABLE "quiz_assignments" ADD CONSTRAINT "quiz_assignments_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- 5. achievement_evidence — the upload's metadata ------------------------
CREATE TABLE IF NOT EXISTS "achievement_evidence" (
  "family_id"         UUID         NOT NULL,
  "id"                UUID         NOT NULL,
  "achievement_id"    UUID         NOT NULL,
  "child_id"          UUID         NOT NULL,
  "kind"              VARCHAR(40)  NOT NULL,
  "storage_key"       VARCHAR(400) NOT NULL,
  "mime_type"         VARCHAR(100) NOT NULL,
  "byte_size"         INTEGER      NOT NULL,
  "sha256"            VARCHAR(64)  NOT NULL,
  "original_filename" VARCHAR(255),
  "retain_until"      TIMESTAMP(3) NOT NULL,
  "deleted_at"        TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "achievement_evidence_pkey" PRIMARY KEY ("id")
);

-- Content-addressed idempotency: the same bytes re-uploaded for one attempt (a
-- retry on a flaky mobile connection) is ONE asset, decided by the database.
CREATE UNIQUE INDEX IF NOT EXISTS "achievement_evidence_achievement_id_sha256_key"
  ON "achievement_evidence" ("achievement_id", "sha256");
CREATE INDEX IF NOT EXISTS "achievement_evidence_family_id_achievement_id_idx"
  ON "achievement_evidence" ("family_id", "achievement_id");
CREATE INDEX IF NOT EXISTS "achievement_evidence_retain_until_idx"
  ON "achievement_evidence" ("retain_until");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_evidence_family_id_fkey') THEN
    ALTER TABLE "achievement_evidence" ADD CONSTRAINT "achievement_evidence_family_id_fkey"
      FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_evidence_achievement_id_fkey') THEN
    ALTER TABLE "achievement_evidence" ADD CONSTRAINT "achievement_evidence_achievement_id_fkey"
      FOREIGN KEY ("achievement_id") REFERENCES "achievement_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'achievement_evidence_child_id_fkey') THEN
    ALTER TABLE "achievement_evidence" ADD CONSTRAINT "achievement_evidence_child_id_fkey"
      FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- --- 6. RLS, replaying 0004's block verbatim --------------------------------
-- Same policy names, same setting name (`app.current_family_id`), the same
-- NULLIF(...) guard, the same explicit owner bypass. `quiz_questions` gets the
-- OR-NULL shape `reward_rules` already uses, so a platform question stays
-- readable to every family while a family-authored one does not leak.
DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'abny_app') THEN
    FOREACH t IN ARRAY ARRAY['quiz_assignments', 'achievement_evidence'] LOOP
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

    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "quiz_questions" TO abny_app';
    EXECUTE 'ALTER TABLE "quiz_questions" ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE "quiz_questions" FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "quiz_questions"';
    EXECUTE
      'CREATE POLICY tenant_isolation ON "quiz_questions" '
      'USING (family_id IS NULL OR family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid) '
      'WITH CHECK (family_id = NULLIF(current_setting(''app.current_family_id'', true), '''')::uuid)';
    EXECUTE 'DROP POLICY IF EXISTS tenant_bypass_owner ON "quiz_questions"';
    EXECUTE format(
      'CREATE POLICY tenant_bypass_owner ON "quiz_questions" TO %I USING (true) WITH CHECK (true)',
      current_user);
  END IF;
END
$$;

-- --- 7. THE SAMPLE BANK — explicitly a sample, not a curriculum -------------
--
-- Twelve platform questions (`family_id IS NULL`) across three categories, so
-- the server-side scoring path is provable end to end the moment the migration
-- runs. THIS IS NOT EDUCATIONAL CONTENT AND IS NOT PRESENTED AS ANY. Authoring
-- a real, age-graded, reviewed bank is a business decision and is flagged for
-- the client in `PHASE-B5-B9-Report.md §افتراضات ومخاطر مفتوحة`.
--
-- Fixed UUIDs so a replay updates rather than duplicates; `DO UPDATE` rather
-- than `DO NOTHING` so a correction reaches an existing database, matching
-- 0006's own seed convention.
INSERT INTO "quiz_questions"
  ("id", "family_id", "category", "subject", "difficulty", "min_age", "max_age",
   "prompt_ar", "choices", "correct_choice_index", "explanation_ar", "is_active")
VALUES
  ('11111111-0000-4000-8000-000000000001', NULL, 'MATH', 'حساب', 'EASY', 6, 10,
   'كم يساوي ٧ + ٥ ؟', '["10","11","12","13"]'::jsonb, 2, 'سبعة زائد خمسة تساوي اثني عشر.', true),
  ('11111111-0000-4000-8000-000000000002', NULL, 'MATH', 'حساب', 'EASY', 6, 10,
   'كم يساوي ٩ × ٣ ؟', '["21","24","27","30"]'::jsonb, 2, 'تسعة في ثلاثة تساوي سبعة وعشرين.', true),
  ('11111111-0000-4000-8000-000000000003', NULL, 'MATH', 'حساب', 'EASY', 7, 12,
   'كم يساوي ١٠٠ ÷ ٤ ؟', '["20","25","30","40"]'::jsonb, 1, 'مئة على أربعة تساوي خمسة وعشرين.', true),
  ('11111111-0000-4000-8000-000000000004', NULL, 'MATH', 'هندسة', 'EASY', 7, 12,
   'كم ضلعًا للمثلث؟', '["2","3","4","5"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-000000000005', NULL, 'SCIENCE', 'علوم عامة', 'EASY', 6, 11,
   'ما الكوكب الذي نعيش عليه؟', '["المريخ","الأرض","الزهرة","المشتري"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-000000000006', NULL, 'SCIENCE', 'علوم عامة', 'EASY', 6, 11,
   'ما الحالة التي يكون عليها الماء عند درجة حرارة أقل من الصفر؟', '["سائل","غاز","صلب","بلازما"]'::jsonb, 2, NULL, true),
  ('11111111-0000-4000-8000-000000000007', NULL, 'SCIENCE', 'علوم عامة', 'EASY', 7, 12,
   'أي هذه الحواس نستخدمها للشمّ؟', '["العين","الأنف","الأذن","اليد"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-000000000008', NULL, 'SCIENCE', 'أحياء', 'EASY', 8, 13,
   'ما العضو الذي يضخّ الدم في الجسم؟', '["الكبد","الرئة","القلب","المعدة"]'::jsonb, 2, NULL, true),
  ('11111111-0000-4000-8000-000000000009', NULL, 'ARABIC', 'نحو', 'EASY', 8, 13,
   'ما نوع كلمة «كتب» في جملة «كتب الولدُ الدرسَ»؟', '["اسم","فعل","حرف","ضمير"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-00000000000a', NULL, 'ARABIC', 'نحو', 'EASY', 8, 13,
   'كم عدد حروف الهجاء العربية؟', '["26","28","29","30"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-00000000000b', NULL, 'ARABIC', 'إملاء', 'EASY', 7, 12,
   'أي الكلمات مكتوبة كتابةً صحيحة؟', '["هاذا","هذا","هذاء","هزا"]'::jsonb, 1, NULL, true),
  ('11111111-0000-4000-8000-00000000000c', NULL, 'ARABIC', 'مفردات', 'EASY', 7, 12,
   'ما مرادف كلمة «سعيد»؟', '["حزين","فرِح","غاضب","خائف"]'::jsonb, 1, NULL, true)
ON CONFLICT ("id") DO UPDATE SET
  "category"             = EXCLUDED."category",
  "subject"              = EXCLUDED."subject",
  "difficulty"           = EXCLUDED."difficulty",
  "min_age"              = EXCLUDED."min_age",
  "max_age"              = EXCLUDED."max_age",
  "prompt_ar"            = EXCLUDED."prompt_ar",
  "choices"              = EXCLUDED."choices",
  "correct_choice_index" = EXCLUDED."correct_choice_index",
  "explanation_ar"       = EXCLUDED."explanation_ar",
  "updated_at"           = CURRENT_TIMESTAMP;
