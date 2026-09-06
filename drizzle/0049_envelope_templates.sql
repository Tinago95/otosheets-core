-- Reusable documents (0049). A template is what an envelope is made FROM: the
-- same wording sent to many counterparties.
--
-- Its own table rather than an is_template flag on envelopes, because a template
-- has no recipients, no status machine, no chain and no signatures. Folding them
-- together would mean every query over real documents had to remember to exclude
-- templates, and that is the filter someone eventually forgets.
CREATE TABLE IF NOT EXISTS envelope_templates (
    template_id text PRIMARY KEY,
    org_id text NOT NULL REFERENCES orgs(org_id) ON DELETE CASCADE,
    business_profile_id text,
    created_by text NOT NULL,
    name text NOT NULL,
    description text,
    kind text NOT NULL,
    body_markdown text,
    s3_key text,
    times_used integer NOT NULL DEFAULT 0,
    archived_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS envelope_templates_org_idx ON envelope_templates (org_id, created_at);
