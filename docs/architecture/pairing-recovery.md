# ADR — Pairing Recovery

**Status:** Proposed. Formalizes Decision-035, in the exact Recovery
Matrix format requested: `Failure | Retry | User Action | Parent Action | Auto Recovery`.
**Depends on:** `pairing-state-machine.md` §6/§7 (this document expands
those into full operational detail; it does not replace them).

"User" = the child, at their device. "Parent" = the confirming
FamilyMember, wherever they are. No code in this document.

---

## Recovery Matrix

| Failure | Cause | Retry | User Action | Parent Action | Auto Recovery |
|---|---|---|---|---|---|
| QR code expired | >10 min since `INVITATION_CREATED` (unchanged TTL) | Manual — a new invitation must be created | Tell the parent the code expired | Generate a new pairing code | No — invitations are one-time and time-boxed by design; auto-regenerating would defeat the TTL's purpose |
| Invitation link expired | Same TTL, alternate delivery method (Decision-012) | Manual | Tap the link again, see the expiry message | Re-send a fresh invitation | No |
| Wrong OTP entered | User typo, or a stale/reused code | Automatic, up to the existing rate limit (10/min on `pairing/confirm`) — the SAME invitation remains valid until its own TTL, a wrong attempt does not consume it | Re-enter the code | None needed unless repeated failures suggest the parent should re-share the code | Yes, within rate limit — this is the one failure class safe to auto-retry, since it's the same still-valid invitation |
| Device unsupported (below `minSdkVersion` 26, per Android enforcement ADR §9) | Hard platform floor | None — retrying changes nothing | Told plainly the device's Android version isn't supported, with the minimum required version stated | None to take on this device; may pair a different device instead | No — this is a permanent state for that device, not transient |
| Internet dropped mid-pairing | Connectivity loss between `AUTHENTICATING` and `ACTIVATED` | Automatic on reconnect — resumes from the **last confirmed state** (`pairing-state-machine.md` §6), never restarts from `INVITATION_CREATED` since the invitation was already consumed | None — the app should detect reconnection and resume itself | None, unless the invitation's own TTL expires while offline, in which case it becomes the "QR expired" case above | Yes, up to the invitation's remaining TTL |
| Parent closed the app during `PARENT_CONFIRMED` wait | No timeout is defined for this state (`pairing-state-machine.md` §7 — "no hard timeout... until the invitation's own TTL") | Manual — parent reopens the app | None — the child's device simply continues waiting, correctly | Reopen the Admin Dashboard/Parent App and complete the approval | Partially — the pairing attempt itself isn't lost (state persists server-side), but nothing progresses until the parent acts |
| Child closed the app mid-flow (before `ACTIVATED`) | App backgrounded/killed during `AUTHENTICATING` through `POLICY_ASSIGNED` | Manual — child must reopen the Child App | Reopen the app; per the design, it should detect an in-progress pairing attempt still within TTL and resume, not start over | None needed unless the invitation expires while the app stayed closed | Partial — resumable only within the invitation's remaining TTL, same constraint as the connectivity case above |
| Server restarted mid-flow | Backend deployment/crash during any pairing step | Automatic on the client side, same resume-from-last-confirmed-state logic — server-side state for `DEVICE_REGISTERED` and later is persisted in Postgres, not in-memory, so a server restart does not lose progress past that point | None, if resume succeeds | None, unless the resume itself fails and the invitation has expired by the time service is restored | Yes, for anything at `DEVICE_REGISTERED` or later; **not** for state before that (`INVITATION_OPENED`/`AUTHENTICATING` rely on the Redis-held invitation, which is unaffected by a Postgres-side server restart specifically, but would be lost if Redis itself were restarted — a distinct, rarer failure mode worth the same handling as the "QR expired" case if it occurs) |
| Attestation unavailable | Device hardware/OS doesn't support Key Attestation | None — this is an expected, non-error outcome for real devices (`trust-levels-framework.md` §3), not a failure to recover from | None — pairing continues normally at Trust Level `L2` | Sees the device's trust level reflects no attestation, if they check details; no action required | N/A — not actually a failure state, listed here only because Decision-035 named it explicitly; the correct system behavior is to proceed, not recover from anything |
| Capability sync failed | Network/parsing error submitting the initial Capability Profile at `CAPABILITIES_UPLOADED` | Automatic, bounded retry (same connectivity-loss handling as above) | None if auto-retry succeeds | If retries are exhausted, parent sees "pairing incomplete" and can manually trigger a retry from the Dashboard | Yes, bounded automatic retry; falls through to requiring parent action only after exhausting retries |

## Design rules this matrix follows consistently

1. **Anything before `DEVICE_REGISTERED` that fails is a "start a new
   invitation" case, never a resume case** — the invitation is one-time
   use; there is nothing partial to resume before a device row even exists.
2. **Anything at `DEVICE_REGISTERED` or later that fails transiently
   resumes from its last confirmed state** — this is why `pairing-state-machine.md`'s
   append-only `DevicePairingEvent` table (CR-2) matters operationally,
   not just for audit: it's exactly what "last confirmed state" reads from.
3. **No failure in this matrix silently retries indefinitely** — every
   "Automatic" cell is bounded by either the invitation's own TTL or an
   explicit rate limit, never an unbounded loop.
4. **User-facing messages (the "User Action" column, where the user is
   told something) are factual and specific, never generic** — "the code
   expired" not "something went wrong," consistent with this project's
   established copy principle (see `docs/architecture/admin-dashboard.md`'s
   UI-writing notes: errors state what happened, plainly).

## Explicitly out of scope for this document

- **Device Replacement** and **Lost Device** flows are not failure
  recovery — they are deliberate parent-initiated state transitions,
  already fully specified in `pairing-state-machine.md` §7. Repeating
  them here would create two sources of truth for the same flows.
- **Anti-Tamper-triggered suspension** is not a pairing failure — it's a
  post-`ACTIVATED` operational event, out of this document's scope by
  definition (this matrix covers the pairing flow itself, states before
  `ACTIVATED`).

## Observability for this feature (Decision-049's four questions, answered)

1. **How do we monitor it?** Every row in the matrix corresponds to a
   distinct event type already defined in `pairing-state-machine.md` §5
   — monitoring is "count events by type over time," not a separate
   mechanism bolted on afterward.
2. **How do we measure success?** Pairing Telemetry (next document, per
   the approved order) tracks two distinct rates: the "clean" success
   rate (reached `ACTIVATED` without hitting any row above) and the
   "recovered" rate (reached `ACTIVATED` after recovering from one or
   more failures) — a high recovered rate on one specific failure type
   is itself worth acting on even when the overall success rate looks
   healthy.
3. **How do we know it broke?** A sustained rise in any single failure
   type's rate — not one overall threshold, since different rows have
   different normal baselines (a wrong OTP followed by a correct one is
   ordinary; a server restart mid-pairing should be rare).
4. **How do we explain a problem when one occurs?** The matrix's
   per-row distinct causes and messages (design rule 4, above), plus —
   for support/debugging — the full `DevicePairingEvent` timeline for
   that specific device, which already contains every transition and
   failure it experienced, in order, by construction (append-only, per
   Decision-039).
