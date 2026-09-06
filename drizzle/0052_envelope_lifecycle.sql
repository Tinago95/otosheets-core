-- The states a document could reach but never record (0052).
--
-- Three nullable columns on envelope_recipients, expand-contract, safe on a
-- second run.
--
-- `reminded_at` is the claim for the one reminder. It has to be a column rather
-- than a chain entry, because appendEvent retries a duplicate id five times and
-- then throws, so "already reminded" would be indistinguishable from a
-- contended chain. A guard on whether an email leaves must never rest on
-- parsing an error message.
--
-- `declined_at` and `declined_reason` record somebody refusing to sign. The
-- status column has carried 'declined' since the table was written and nothing
-- ever set it, so a signer who would not sign could only close the tab and the
-- owner's screen said "Opened it, not signed yet" for ever. The timestamp is
-- what makes the write conditional, so two taps inside one round trip produce
-- one entry rather than two; the reason is the point of asking at all.
--
-- Existing rows read null on all three, which is honest: nobody was reminded
-- and nobody declined, because neither was possible.

ALTER TABLE "envelope_recipients" ADD COLUMN IF NOT EXISTS "reminded_at" text;
--> statement-breakpoint
ALTER TABLE "envelope_recipients" ADD COLUMN IF NOT EXISTS "declined_at" text;
--> statement-breakpoint
ALTER TABLE "envelope_recipients" ADD COLUMN IF NOT EXISTS "declined_reason" text;
--> statement-breakpoint

-- The sweep runs daily across every document on the platform, so both of its
-- passes have to be served by an index or the cron becomes a scan that times
-- out at the least convenient moment. Partial, because the interesting rows are
-- a small and self-clearing subset: a link that has not lapsed and a recipient
-- who has already been reminded are both permanently uninteresting.
CREATE INDEX IF NOT EXISTS "envelope_recipients_due_expiry_idx"
    ON "envelope_recipients" ("expires_at", "recipient_id")
    WHERE "expires_at" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "envelope_recipients_due_reminder_idx"
    ON "envelope_recipients" ("dispatched_at", "recipient_id")
    WHERE "dispatched_at" IS NOT NULL
      AND "first_opened_at" IS NULL
      AND "reminded_at" IS NULL
      AND "revoked_at" IS NULL;
