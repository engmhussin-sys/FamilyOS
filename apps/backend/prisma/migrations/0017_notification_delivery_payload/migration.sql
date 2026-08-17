-- PHASE E (`PD-N-004`) — THE COLUMN A DEFERRED NOTIFICATION NEEDS IN ORDER TO
-- BE THE SAME NOTIFICATION IN THE MORNING.
--
-- Phase D's `notification_deliveries` carried type, title, body and the causal
-- key, which is everything the two producers it routed happened to use.
-- `DigitalWellbeingEngineService` — the producer Phase D recorded as still
-- bypassing the gate (`PD-N-004`) — carries something more: a free-form
-- `metadata` object from the device, written into `notifications.data`, which
-- is where the parent app reads the specifics of a policy violation (which
-- package, which limit, how far over).
--
-- Routing that producer through the deferral queue WITHOUT this column would
-- have closed a silent-drop defect by opening a silent-truncation one: the
-- 02:00 alert would arrive at 07:00 with its payload replaced by a
-- reconstruction. A queue that cannot hold the message is not a queue.
--
-- Nullable, no default, no backfill: every existing row predates a producer
-- that sets it, and NULL is the honest value for «this notification never had
-- a payload», which is exactly true of every row already in the table.
--
-- Re-runnable (`IF NOT EXISTS`), like every migration in this project since
-- 0010.

ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "data" jsonb;
