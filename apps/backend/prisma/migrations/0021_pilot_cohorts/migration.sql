-- ============================================================================
-- G16 — THE CONTROLLED-PILOT ALLOW-LIST (Saudi Arabia + Egypt).
--
-- WHAT THIS TABLE IS. One row per INVITED household, created by an operator
-- BEFORE that household registers. In a pilot country it is the only thing that
-- lets a registration through the gate, and after registration it is where that
-- family's cohort and country are recorded.
--
-- NOTHING IS LAUNCHED BY THIS MIGRATION. The gate is read from
-- `growth_settings.pilot.enabled`, whose documented default is `false`, and this
-- migration deliberately seeds NO settings row at all — so on every existing and
-- new deployment the gate is inert and registration behaves exactly as it did
-- before. Enabling the pilot is a later, deliberate admin UPDATE.
--
-- WHY THERE IS NO `family_id`, WHICH IS THE ONE DESIGN QUESTION HERE.
-- The gate runs INSIDE registration, ahead of the transaction that creates the
-- Family row — the whole point is to refuse before an account exists. A
-- `family_id` column could therefore only ever be NULL at the single moment it
-- matters, and a tenant column that is NULL exactly when it is needed is worse
-- than no column: it invites a filter that silently matches nothing.
-- `redeemed_by_family_id` is the backward link, written afterwards. The table is
-- therefore classified GLOBAL in `tenant-model-registry.ts`, beside
-- `growth_settings` and `feature_flags`, with that reasoning recorded there.
--
-- WHY AN EMAIL AND NOT A REDEEMABLE CODE. A code is bearer material: it can be
-- forwarded, posted in a group chat, and used by whoever reads it first, which is
-- precisely what a CONTROLLED pilot must not permit. An invitation bound to the
-- address the operator sent it to cannot be transferred by forwarding it. Stored
-- lower-cased, matching how `AuthService` already resolves users by email.
--
-- WHY `UNIQUE (email, cohort_id)` IS THE LOAD-BEARING LINE. It is what makes the
-- allow-list an allow-list. Without it, two rows for one address in one cohort
-- would let a second registration redeem the second row — so the invariant "one
-- invitation, one household" would hold only for as long as nobody inserted a
-- duplicate. Neither column is nullable, so PostgreSQL's NULLs-are-distinct rule
-- cannot quietly disable this index the way it would on a nullable key.
-- ============================================================================

CREATE TABLE "pilot_invites" (
    "id"                     UUID         NOT NULL DEFAULT gen_random_uuid(),
    "email"                  VARCHAR(255) NOT NULL,
    "cohort_id"              VARCHAR(60)  NOT NULL,
    "country_code"           VARCHAR(2)   NOT NULL,
    "redeemed_at"            TIMESTAMP(3),
    "redeemed_by_family_id"  UUID,
    "invited_by_user_id"     UUID,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pilot_invites_pkey" PRIMARY KEY ("id")
);

-- The invariant, stated as a constraint rather than as a convention.
CREATE UNIQUE INDEX "pilot_invites_email_cohort_id_key"
    ON "pilot_invites" ("email", "cohort_id");

-- The operator's read: "who is in this wave, in this country, and how many have
-- actually joined?"
CREATE INDEX "pilot_invites_cohort_id_country_code_idx"
    ON "pilot_invites" ("cohort_id", "country_code");

-- The reverse lookup: "which invitation did this family come from?"
CREATE INDEX "pilot_invites_redeemed_by_family_id_idx"
    ON "pilot_invites" ("redeemed_by_family_id");

-- A row is either fully unredeemed or fully redeemed. A half-redeemed row —
-- a timestamp with no family, or a family with no timestamp — would make the
-- "already used?" check ambiguous, so it is made unrepresentable here rather
-- than merely avoided in the service that writes it.
ALTER TABLE "pilot_invites"
    ADD CONSTRAINT "pilot_invites_redemption_complete"
    CHECK (
        ("redeemed_at" IS NULL     AND "redeemed_by_family_id" IS NULL)
     OR ("redeemed_at" IS NOT NULL AND "redeemed_by_family_id" IS NOT NULL)
    );

-- Lower-case is enforced, not hoped for: the gate looks a family up by
-- `LOWER(email)`, and one mixed-case row inserted by hand would be an invitation
-- that silently never matches — an operator would see the row and the family
-- would be refused.
ALTER TABLE "pilot_invites"
    ADD CONSTRAINT "pilot_invites_email_lowercase"
    CHECK ("email" = LOWER("email"));

-- ISO-3166 alpha-2, upper-case, for the same reason in the other direction: the
-- country list in `growth_settings.pilot.countries` is compared upper-cased.
ALTER TABLE "pilot_invites"
    ADD CONSTRAINT "pilot_invites_country_code_uppercase"
    CHECK ("country_code" = UPPER("country_code") AND LENGTH("country_code") = 2);
