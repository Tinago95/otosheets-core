-- What a document was drafted from (0051).
--
-- Three nullable columns on envelopes, expand-contract, safe on a second run.
--
-- `answers` is the questionnaire the contract-type registry asked, stored as
-- given. Without it a regenerate has nothing to prefill from and asks the owner
-- every question again, which is how the second version ends up differing from
-- the first in a way nobody chose.
--
-- `jurisdiction` is the Australian state or territory whose law governs the
-- document. It is a column rather than a line buried in the body because the
-- one thing a dispute opens with is which law applies, and reading it back out
-- of prose is not an answer. Existing rows read as null, which is honest: they
-- were drafted before the question was asked.
--
-- `effective_date` is when the document takes effect, which is neither
-- created_at nor the date it was signed. An NDA dated to cover a conversation
-- that already happened is the ordinary case, not the exception.
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS answers jsonb;
--> statement-breakpoint
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS jurisdiction text;
--> statement-breakpoint
ALTER TABLE envelopes ADD COLUMN IF NOT EXISTS effective_date text;
