/**
 * SPRINT F1 — THE ONE STATEMENT THE STALLED-GOAL PRODUCER ASKS, exported as a
 * constant for the same reason `notification-decision.sql.ts` exports its own:
 * the integration suite executes THIS EXACT STRING against a real PostgreSQL,
 * so a `WHERE` clause cannot be dropped from production without the test that
 * proves the property going red.
 *
 * TENANCY (CI RULE 2). `family_id` is named on BOTH tables and on both
 * sub-queries, and the join carries it too — a `reward_programs` row is reached
 * only through its own family, so a corrupted `program_id` cannot make one
 * household's goal readable from another's sweep. The statement runs inside the
 * `runWithTenant` scope the job runner establishes and STILL names the column,
 * because a statement that relies on ambient context to be correct is a
 * statement that is wrong the first time it is copied.
 *
 * EVERY CLAUSE IS THE CONDITION, AND EACH ONE IS A ROW STATE:
 *
 *   local_date = $2                  the day the FAMILY has just closed. The
 *                                    column is `@db.Date` and was written from
 *                                    `FamilyDateService.toDateColumn`, i.e. it
 *                                    is already a family-local day and must NOT
 *                                    be re-projected through a timezone here.
 *   status IN (REQUESTED,IN_PROGRESS) the attempt was opened and never left the
 *                                    open states. SUBMITTED / PENDING_PARENT /
 *                                    VERIFIED / REJECTED all mean the child did
 *                                    the thing and somebody is judging it.
 *   submitted_at IS NULL             belt and braces with `status`, and the
 *   decided_at   IS NULL             column a partially-migrated row would
 *                                    disagree on. «Nothing was ever handed in»
 *                                    is the fact; the status is the label.
 *   rp.status = 'ACTIVE'             a parent who ARCHIVED the goal has already
 *   rp.archived_at IS NULL           acted. Nudging them about a goal they
 *                                    retired is the monitor behaviour this
 *                                    product exists not to have.
 *   rp.expires_at > $3               an expired program cannot be attempted
 *                                    again, so «maybe he needs a push today»
 *                                    would invite an action the child cannot
 *                                    take (`checkProgramEligibility` answers
 *                                    PROGRAM_EXPIRED). `AT TIME ZONE 'UTC'`
 *                                    because `expires_at` is `timestamp`
 *                                    WITHOUT time zone holding a UTC instant
 *                                    (Prisma's storage convention): comparing
 *                                    it to a `timestamptz` parameter directly
 *                                    would silently use the SESSION's timezone
 *                                    to convert, i.e. the deployment's, which
 *                                    is the class of bug `family-date.ts`
 *                                    exists to have removed.
 *   NOT EXISTS (progress...)         `max_per_day` may allow several attempts:
 *                                    an abandoned attempt beside a VERIFIED one
 *                                    on the same day is a child who FINISHED,
 *                                    and this is the clause that says so.
 *
 * DISTINCT ON (child, program) — one candidate per goal per child per day, so
 * two open attempts on one program cannot ask the engine twice. The ledger's
 * unique key would refuse the second anyway; doing it here means the second
 * never costs a decision, a composition and a round trip.
 *
 * $1 familyId · $2 businessDate (YYYY-MM-DD) · $3 now
 */
export const SQL_LIST_STALLED_GOALS = `
SELECT DISTINCT ON (ar."child_id", ar."program_id")
       ar."child_id"          AS child_id,
       ar."program_id"        AS program_id,
       rp."target_summary_ar" AS goal_title,
       rp."target_spec"       AS target_spec
  FROM "achievement_requests" ar
  JOIN "reward_programs" rp
    ON rp."id" = ar."program_id"
   AND rp."family_id" = ar."family_id"
 WHERE ar."family_id" = $1::uuid
   AND ar."local_date" = $2::date
   AND ar."status" IN ('REQUESTED', 'IN_PROGRESS')
   AND ar."submitted_at" IS NULL
   AND ar."decided_at" IS NULL
   AND rp."status" = 'ACTIVE'
   AND rp."archived_at" IS NULL
   AND (rp."expires_at" IS NULL OR rp."expires_at" > ($3::timestamptz AT TIME ZONE 'UTC'))
   AND NOT EXISTS (
         SELECT 1
           FROM "achievement_requests" progressed
          WHERE progressed."family_id" = ar."family_id"
            AND progressed."program_id" = ar."program_id"
            AND progressed."child_id" = ar."child_id"
            AND progressed."local_date" = ar."local_date"
            AND progressed."status" IN ('SUBMITTED', 'PENDING_PARENT', 'VERIFIED', 'REJECTED')
       )
 ORDER BY ar."child_id", ar."program_id", ar."attempt_no"`;
