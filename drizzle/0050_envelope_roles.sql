-- Roles on templates (0050).
--
-- A field placed for Dave Ellis is meaningless for the next counterparty. A
-- field placed for THE COUNTERPARTY works forever. Roles are that indirection,
-- and they are what makes a prepared template sendable again.
--
-- Template fields point at a role_key; recipients record which role they fill;
-- creating an envelope from a template copies the fields across, re-pointed at
-- whoever was given that role.
CREATE TABLE IF NOT EXISTS envelope_template_roles (
    template_role_id text PRIMARY KEY,
    template_id text NOT NULL REFERENCES envelope_templates(template_id) ON DELETE CASCADE,
    role_key text NOT NULL,
    label text NOT NULL,
    signing_role text NOT NULL,
    order_no integer NOT NULL DEFAULT 0,
    required boolean NOT NULL DEFAULT true,
    created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS envelope_template_roles_key_uq ON envelope_template_roles (template_id, role_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS envelope_template_fields (
    template_field_id text PRIMARY KEY,
    template_id text NOT NULL REFERENCES envelope_templates(template_id) ON DELETE CASCADE,
    role_key text NOT NULL,
    type text NOT NULL,
    label text,
    required boolean NOT NULL DEFAULT true,
    page integer NOT NULL,
    x text NOT NULL,
    y text NOT NULL,
    w text NOT NULL,
    h text NOT NULL,
    created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS envelope_template_fields_template_idx ON envelope_template_fields (template_id);
--> statement-breakpoint
-- Which template role a recipient is filling. Null on an ad hoc document, where
-- the person is the slot.
ALTER TABLE envelope_recipients ADD COLUMN IF NOT EXISTS role_key text;
