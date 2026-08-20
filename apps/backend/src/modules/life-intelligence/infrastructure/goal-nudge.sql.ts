/**
 * SPRINT F1 — THE THREE STATEMENTS THE GOAL-NUDGE PRODUCER ASKS, exported as
 * constants for the same reason `stalled-goal.sql.ts` exports its own: the
 * integration suite executes THESE EXACT STRINGS against a real PostgreSQL, so a
 * `WHERE` clause cannot be dropped from production without the test that proves
 * the property going red.
 *
 * TENANCY (CI RULE 2). `family_id` is named on EVERY table and in EVERY
 * sub-query, and every join carries it — a `reward_programs` row is reached only
 * through its own family, so a corrupted `program_id` cannot make one
 * household's goal readable from another's sweep. The two per-family statements
 * run inside the `runWithTenant` scope the service establishes and STILL name
 * the column, because a statement that relies on ambient context to be correct
 * is a statement that is wrong the first time it is copied.
 *
 * THE FAN-OUT STATEMENT IS THE ONE EXCEPTION AND IT IS DELIBERATE: it reads
 * TENANT IDS ONLY, under `runAsSystemAsync` with a written justification, and
 * the service re-enters `runWithTenant` for each id before touching one row of
 * content. That is the shape `PrismaNotificationDeliveryRepository.familiesWithDueDeliveries`
 * already uses for the release sweep.
 */

/**
 * WHICH HOUSEHOLDS ARE WORTH LOOKING AT, AND NOTHING ELSE ABOUT THEM — ONE PAGE
 * OF THEM, FROM A KEYSET CURSOR.
 *
 * A DELIBERATE SUPERSET. The exact conditions are family-LOCAL — «today» is a
 * different calendar day in Cairo and in Auckland at the same instant — and a
 * cross-tenant statement has no family timezone to evaluate them against. So
 * this asks the widest question that is still cheap: «did any child in this
 * household touch a live reward program on a day within one of the UTC date?».
 * Every IANA zone is inside ±1 day of UTC, so no candidate household can be
 * missed, and the per-family statements below then decide the truth on the
 * family's own calendar.
 *
 * WHAT THIS STATEMENT USED TO BE, AND WHY IT WAS A SILENT CEILING. It was the
 * same query without `$3`, called ONCE by `GoalNudgeService.sweep` with a limit
 * of 500 and no loop. That is the daily-rollover defect
 * (`SQL_LIST_ACTIVE_FAMILIES`, `LIMIT 200 OFFSET 0`, called once) in a second
 * place, and worse in one respect: the candidate set here is a ±1-day window on
 * `achievement_requests` and a household refused for quiet hours STAYS a
 * candidate for that window, so past the 500th candidate household in uuid
 * order the tail was not deferred to the next tick — the next tick re-read the
 * same first 500 — it was UNREACHABLE for the whole window. No error, no log,
 * no metric.
 *
 * KEYSET, NOT `OFFSET`, and for the reasons `SQL_LIST_ACTIVE_FAMILIES_PAGE`
 * states in full:
 *
 *   - `WHERE family_id > $3 ORDER BY family_id` names a POSITION, not a count.
 *     `family_id` is totally ordered by PostgreSQL's `uuid` comparison, so
 *     «everything after this id» means the same thing on every execution no
 *     matter what was inserted or deleted between two pages. An `OFFSET` walk
 *     over a table that is changing underneath it skips and repeats rows.
 *   - it is index-friendly: each page is a range scan rather than a
 *     scan-and-discard of `n` rows.
 *
 * THE `ORDER BY` IS LOAD-BEARING AND NOT COSMETIC. Without a total order the
 * cursor names nothing: two pages may overlap (a household nudged twice, or
 * rather one decision and one `ALREADY_DECIDED`) or leave a gap (a household
 * never looked at). `goal-nudge-family-pagination.e2e.spec.ts` mutates this
 * clause and fails, which is what makes it a tested property rather than a
 * comment.
 *
 * `DISTINCT` AND THE CURSOR AGREE because the projection is the cursor column
 * itself: one row per family, ordered by the column the next page seeks past,
 * so a page boundary can never fall in the middle of a household's rows.
 *
 * `LIMIT` is still the caller's, so an operator can size a page without a
 * deploy — the same knob `SQL_LIST_FAMILIES_WITH_DUE_DELIVERIES` exposes. What
 * is no longer the caller's is whether the walk STOPS there.
 *
 * $1 now · $2 pageSize · $3 lastFamilyId (NULL = first page)
 */
export const SQL_LIST_FAMILIES_WITH_GOAL_CANDIDATES_PAGE = `
SELECT DISTINCT ar."family_id" AS family_id
  FROM "achievement_requests" ar
  JOIN "reward_programs" rp
    ON rp."id" = ar."program_id"
   AND rp."family_id" = ar."family_id"
 WHERE rp."status" = 'ACTIVE'
   AND rp."archived_at" IS NULL
   AND ar."local_date" >= ((($1::timestamptz) AT TIME ZONE 'UTC')::date - 1)
   AND ar."local_date" <= ((($1::timestamptz) AT TIME ZONE 'UTC')::date + 1)
   AND ($3::uuid IS NULL OR ar."family_id" > $3::uuid)
 ORDER BY family_id
 LIMIT $2`;

/**
 * `GOAL_DEADLINE_NEAR` — AN OPEN ATTEMPT ON A PROGRAM THAT IS ABOUT TO EXPIRE.
 *
 * EVERY CLAUSE IS A ROW STATE, and each one is a gate `checkProgramEligibility`
 * would apply to the action this sentence invites:
 *
 *   local_date = $2                   the FAMILY'S day, written by
 *                                     `AchievementService.start` through
 *                                     `FamilyDateService.toDateColumn`. Already
 *                                     family-local; never re-projected here.
 *   status IN (REQUESTED,IN_PROGRESS) the attempt is OPEN. `SUBMITTED`,
 *   submitted_at IS NULL              `PENDING_PARENT`, `VERIFIED` and
 *   decided_at IS NULL                `REJECTED` all mean the child handed it in
 *                                     and there is nothing left to hurry.
 *   rp.status / archived_at           a parent who archived or paused the goal
 *                                     has already decided; hurrying a child
 *                                     towards a retired goal is the monitor
 *                                     behaviour this product exists not to have.
 *   rp.child_id IS NULL OR = child    a program addressed to a sibling is not
 *                                     this child's deadline.
 *   the expiry band                   `FLOOR(seconds/60) BETWEEN $4 AND $5` is
 *                                     expressed on `expires_at` directly rather
 *                                     than on the derived column, so PostgreSQL
 *                                     can use an index and so the band and the
 *                                     rendered number cannot disagree. The upper
 *                                     bound is `$5 + 1` EXCLUSIVE, which is what
 *                                     `FLOOR(...) <= $5` means.
 *                                     `AT TIME ZONE 'UTC'` because `expires_at`
 *                                     is `timestamp` WITHOUT time zone holding a
 *                                     UTC instant (Prisma's storage convention):
 *                                     comparing it to a `timestamptz` bare would
 *                                     silently convert through the SESSION's
 *                                     zone, i.e. the deployment's.
 *   verified_today < max_per_day      the sentence «باقي لك ٥ دقائق فقط لإكمال
 *                                     هدفك» invites the child to FINISH, and
 *                                     `COPY_RULES.GOAL_DEADLINE_NEAR` requires
 *                                     `completedUnits < totalUnits` for exactly
 *                                     that reason. A child who has already met
 *                                     the day's plan is not behind on anything.
 *
 * DISTINCT ON (child, program) — one candidate per goal per child, so two open
 * attempts on one program cannot ask the engine twice. The ledger's unique key
 * would refuse the second anyway; doing it here means the second never costs a
 * decision, a composition and a round trip.
 *
 * $1 familyId · $2 businessDate (YYYY-MM-DD) · $3 now · $4 min minutes · $5 max minutes
 */
export const SQL_LIST_GOAL_DEADLINES = `
SELECT DISTINCT ON (ar."child_id", ar."program_id")
       ar."child_id"           AS child_id,
       ar."program_id"         AS program_id,
       rp."target_summary_ar"  AS goal_title,
       rp."activity"           AS activity,
       rp."max_per_day"        AS max_per_day,
       rp."min_age"            AS min_age,
       ch."date_of_birth"      AS date_of_birth,
       FLOOR(
         EXTRACT(EPOCH FROM (rp."expires_at" - (($3::timestamptz) AT TIME ZONE 'UTC'))) / 60
       )::int                  AS minutes_remaining,
       (
         SELECT COUNT(*)::int
           FROM "achievement_requests" v
          WHERE v."family_id"  = ar."family_id"
            AND v."program_id" = ar."program_id"
            AND v."child_id"   = ar."child_id"
            AND v."local_date" = $2::date
            AND v."status"     = 'VERIFIED'
       )                       AS verified_today
  FROM "achievement_requests" ar
  JOIN "reward_programs" rp
    ON rp."id" = ar."program_id"
   AND rp."family_id" = ar."family_id"
  JOIN "children" ch
    ON ch."id" = ar."child_id"
   AND ch."family_id" = ar."family_id"
 WHERE ar."family_id" = $1::uuid
   AND ar."local_date" = $2::date
   AND ar."status" IN ('REQUESTED', 'IN_PROGRESS')
   AND ar."submitted_at" IS NULL
   AND ar."decided_at" IS NULL
   AND ch."deleted_at" IS NULL
   AND ch."is_active" = true
   AND rp."status" = 'ACTIVE'
   AND rp."archived_at" IS NULL
   AND (rp."child_id" IS NULL OR rp."child_id" = ar."child_id")
   AND rp."expires_at" IS NOT NULL
   AND rp."expires_at" >= ((($3::timestamptz) + make_interval(mins => $4::int)) AT TIME ZONE 'UTC')
   AND rp."expires_at" <  ((($3::timestamptz) + make_interval(mins => ($5::int + 1))) AT TIME ZONE 'UTC')
   AND (
         SELECT COUNT(*)::int
           FROM "achievement_requests" v2
          WHERE v2."family_id"  = ar."family_id"
            AND v2."program_id" = ar."program_id"
            AND v2."child_id"   = ar."child_id"
            AND v2."local_date" = $2::date
            AND v2."status"     = 'VERIFIED'
       ) < rp."max_per_day"
 ORDER BY ar."child_id", ar."program_id", ar."attempt_no"`;

/**
 * `GOAL_ALMOST_DONE` — THE DAY'S PLAN IS ONE COMPLETION SHORT, AND THE CHILD CAN
 * STILL DO IT.
 *
 * THE PROGRESS IS THE COUNT OF `VERIFIED` ROWS, and `goal-nudge.types.ts`
 * carries the argument for why that is a fact rather than a column this schema
 * is missing. What belongs here is the second half of the condition, which is
 * the half that keeps the sentence from being a tease:
 *
 *   NOT EXISTS (open attempt)      `MAX_OPEN_ATTEMPTS_PER_DAY` is 1, so a child
 *                                  with an attempt already open CANNOT start
 *                                  another — and is in the middle of the very
 *                                  thing the message would ask them to do.
 *   week count < max_per_week      `checkProgramEligibility` refuses on the
 *                                  WEEKLY cap before it ever looks at the day.
 *                                  Six calendar days back from the family's own
 *                                  business date, matching `weekWindow`, not six
 *                                  times 86,400,000 milliseconds.
 *   frequency <> 'ONCE'            a once-ever program is completed or it is not;
 *                                  `verifiedToday > 0` already means it is, and
 *                                  `PROGRAM_ALREADY_COMPLETED` would refuse the
 *                                  start this sentence invites.
 *   expires_at NULL OR > now       `PROGRAM_EXPIRED`, same rule.
 *   rp.child_id IS NULL OR = child a sibling's program is not this child's plan.
 *
 * `min_age` IS RETURNED RATHER THAN COMPARED. The remaining gate is the child's
 * AGE, and age in this product is `businessAgeInYears` — whole years on the
 * FAMILY'S calendar, which is a TypeScript function with a timezone argument.
 * Re-deriving it as `EXTRACT(YEAR FROM AGE(...))` would be a second, subtly
 * different age in a second language; the row carries `date_of_birth` and
 * `min_age` and the producer applies the product's own function to them.
 *
 * HAVING rather than WHERE for the count, because it is an aggregate: exactly
 * one completion short of the day's plan, and at least one already done — «you
 * have done 0 of 1» is not «one step left», it is the whole thing.
 *
 * $1 familyId · $2 businessDate (YYYY-MM-DD) · $3 weekFrom (YYYY-MM-DD) · $4 now
 */
export const SQL_LIST_ALMOST_DONE_GOALS = `
SELECT ar."child_id"          AS child_id,
       ar."program_id"        AS program_id,
       rp."target_summary_ar" AS goal_title,
       rp."activity"          AS activity,
       rp."max_per_day"       AS max_per_day,
       rp."min_age"           AS min_age,
       ch."date_of_birth"     AS date_of_birth,
       COUNT(*)::int          AS verified_today
  FROM "achievement_requests" ar
  JOIN "reward_programs" rp
    ON rp."id" = ar."program_id"
   AND rp."family_id" = ar."family_id"
  JOIN "children" ch
    ON ch."id" = ar."child_id"
   AND ch."family_id" = ar."family_id"
 WHERE ar."family_id" = $1::uuid
   AND ar."local_date" = $2::date
   AND ar."status" = 'VERIFIED'
   AND ch."deleted_at" IS NULL
   AND ch."is_active" = true
   AND rp."status" = 'ACTIVE'
   AND rp."archived_at" IS NULL
   AND rp."frequency" <> 'ONCE'
   AND (rp."child_id" IS NULL OR rp."child_id" = ar."child_id")
   AND (rp."expires_at" IS NULL OR rp."expires_at" > (($4::timestamptz) AT TIME ZONE 'UTC'))
   AND NOT EXISTS (
         SELECT 1
           FROM "achievement_requests" o
          WHERE o."family_id"  = ar."family_id"
            AND o."program_id" = ar."program_id"
            AND o."child_id"   = ar."child_id"
            AND o."local_date" = $2::date
            AND o."status" IN ('REQUESTED', 'IN_PROGRESS')
            AND o."submitted_at" IS NULL
            AND o."decided_at" IS NULL
       )
   AND (
         SELECT COUNT(*)::int
           FROM "achievement_requests" w
          WHERE w."family_id"  = ar."family_id"
            AND w."program_id" = ar."program_id"
            AND w."child_id"   = ar."child_id"
            AND w."local_date" BETWEEN $3::date AND $2::date
            AND w."status"     = 'VERIFIED'
       ) < rp."max_per_week"
 GROUP BY ar."child_id",
          ar."program_id",
          rp."target_summary_ar",
          rp."activity",
          rp."max_per_day",
          rp."min_age",
          ch."date_of_birth"
HAVING COUNT(*)::int > 0
   AND rp."max_per_day" - COUNT(*)::int = 1
 ORDER BY ar."child_id", ar."program_id"`;
