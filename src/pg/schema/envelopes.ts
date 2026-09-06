import { pgTable, text, integer, boolean, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './identity';

/**
 * Documents (envelopes): the e-signature spine.
 *
 * Postgres-only, no DynamoDB mirror: every read is a join (envelope to its
 * recipients, its fields, its chain) or a report (what is out, who has not
 * signed), which is the source-of-truth rule's Postgres side.
 *
 * Named `envelope_*` rather than `document_*` on purpose. A `documents` concept
 * already ships: a DynamoDB `DocumentRepo` on the onboarding table, a live
 * `/documents` route and `DOCUMENT` endpoint keys. Two entities called Document
 * in one codebase, one on each store, is how the wrong repo gets imported.
 *
 * Four invariants are structural here rather than enforced in a handler,
 * because each is unrecoverable if it is ever violated once:
 *
 *  1. THE CHAIN CANNOT FORK.  `UNIQUE (envelope_id, seq)` plus an append inside
 *     getPgTx() means two concurrent writers cannot both take the same
 *     position. A chain read out, appended to and written back without that
 *     constraint forks silently, and a verifier cannot tell a fork from
 *     tampering.
 *  2. A DOCUMENT IS SEALED ONCE.  `UNIQUE (envelope_id, kind)` on artifacts is
 *     the once-only guarantee. Regenerating a sealed PDF produces different
 *     bytes for the same events (Chromium output is stable for a build, not
 *     across builds), which would break any hash taken over it.
 *  3. A SIGNATURE BELONGS TO A VERSION, NOT TO A DOCUMENT.  When a reviewer's
 *     proposed edit is accepted after someone has signed, the new version must
 *     void the old signature rather than silently inherit it. If signatures
 *     hung off the envelope there would be no honest answer to "what did they
 *     actually agree to".
 *  4. SIGNING IS IDEMPOTENT.  `UNIQUE (version_id, recipient_id)` is the wall.
 *     A replayed POST loses the insert and returns the prior result instead of
 *     appending a second chain entry and re-sending the completion email.
 */

/** Sales, standard, regulated. Set from `kind` at creation and never editable. */
export const envelopes = pgTable('envelopes', {
    envelopeId: text('envelope_id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.orgId, { onDelete: 'cascade' }),
    businessProfileId: text('business_profile_id'),
    createdBy: text('created_by').notNull(),
    title: text('title').notNull(),

    // The tier gate. `kind` is a required enumerated choice the owner makes
    // before anything is drafted or uploaded; `tier` is a pure lookup from it.
    // Deriving tier from a free-text description would mean classifying with a
    // model call, so the gate would depend on the thing it gates.
    kind: text('kind').notNull(),                    // proposal | scope_of_works | subcontractor_agreement | ...
    tier: integer('tier').notNull(),                 // 0 sales | 1 standard | 2 regulated (refused)

    status: text('status').notNull(),                // draft|in_review|out_for_signing|completed|declined|voided|expired
    currentVersionNo: integer('current_version_no').notNull().default(1),

    // Set when a reviewer is on the envelope: signers are held until the
    // verdict releases them. One Send, staged by role.
    holdSignersForReview: boolean('hold_signers_for_review').notNull().default(true),

    // What the document was drafted FROM, kept on the envelope rather than the
    // version. Without it a regenerate cannot prefill and has to ask for every
    // answer again, and there is no record anywhere of which jurisdiction's law
    // a signed contract was drafted under, which is the one thing a dispute
    // opens with. Nullable: an uploaded PDF was never drafted from anything.
    answers: jsonb('answers'),
    jurisdiction: text('jurisdiction'),               // NSW | VIC | QLD | WA | SA | TAS | ACT | NT
    effectiveDate: text('effective_date'),            // YYYY-MM-DD, not the created or signed date

    completedAt: text('completed_at'),
    voidedAt: text('voided_at'),
    voidedReason: text('voided_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    index('envelopes_org_created_idx').on(t.orgId, t.createdAt),
    index('envelopes_org_status_idx').on(t.orgId, t.status),
]);

/**
 * One row per version of the document body. v1 is the original; a reviewer's
 * accepted edit creates v2. Fields and signatures both hang off a version.
 */
export const envelopeVersions = pgTable('envelope_versions', {
    versionId: text('version_id').primaryKey(),
    envelopeId: text('envelope_id').notNull().references(() => envelopes.envelopeId, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),

    // The body as authored (markdown with anchor tokens) when it came from a
    // template or a draft; null for an uploaded PDF, where s3Key is the source.
    bodyMarkdown: text('body_markdown'),
    s3Key: text('s3_key'),
    sha256: text('sha256'),

    createdBy: text('created_by').notNull(),
    createdReason: text('created_reason'),            // original | reviewer_edit_accepted
    supersededAt: text('superseded_at'),
    createdAt: text('created_at').notNull(),
}, (t) => [
    uniqueIndex('envelope_versions_env_no_uq').on(t.envelopeId, t.versionNo),
]);

/**
 * Recipients. Role is a column, not a permission flag: a reviewer is dispatched
 * on a different schedule, can never hold a field, and their link auto-revokes
 * on verdict. Modelling that as a flag on one signers list is what lets the
 * inherited implementation's reviewers sign.
 *
 * The credential is an opaque 256-bit random token of which only the SHA-256 is
 * stored, so it can be revoked (a column write) and cannot be recomputed from
 * anything in the row. There is deliberately no HMAC secret: a keyed scheme
 * cannot be revoked without a store anyway, and it would need an env var the
 * API Lambda has no room for.
 */
export const envelopeRecipients = pgTable('envelope_recipients', {
    recipientId: text('recipient_id').primaryKey(),
    envelopeId: text('envelope_id').notNull().references(() => envelopes.envelopeId, { onDelete: 'cascade' }),

    role: text('role').notNull(),                     // signer | reviewer | viewer
    orderNo: integer('order_no').notNull().default(0),
    name: text('name'),
    email: text('email').notNull(),

    // Credential. Never the token itself.
    tokenHash: text('token_hash'),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    revokedReason: text('revoked_reason'),

    // Optional access code, per recipient rather than per envelope: a shared
    // code means revoking the reviewer locks out the signer. scrypt, salted
    // per recipient, with its parameters stored so they can be raised later
    // without invalidating existing codes.
    accessCodeHash: text('access_code_hash'),
    accessCodeSalt: text('access_code_salt'),
    accessCodeParams: jsonb('access_code_params'),
    accessCodeChannel: text('access_code_channel'),   // sms | spoken | email | none
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: text('locked_until'),

    status: text('status').notNull(),                 // pending|dispatched|opened|signed|declined|reviewed|bounced|revoked
    dispatchedAt: text('dispatched_at'),
    firstOpenedAt: text('first_opened_at'),
    completedAt: text('completed_at'),

    // Captured at send so a later bounce notification can be correlated. Added
    // afterwards, every envelope sent before it is permanently uncorrelatable.
    sesMessageId: text('ses_message_id'),
    bouncedAt: text('bounced_at'),
    bounceType: text('bounce_type'),
    bounceReason: text('bounce_reason'),

    // Reviewer only.
    /**
     * Which template role this person is filling, when the envelope came from a
     * template. Null on an ad hoc document, where the person IS the slot.
     */
    roleKey: text('role_key'),

    verdict: text('verdict'),                         // approved | changes_proposed | rejected
    verdictAt: text('verdict_at'),
    verdictNote: text('verdict_note'),

    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    index('envelope_recipients_env_idx').on(t.envelopeId),
    uniqueIndex('envelope_recipients_token_uq').on(t.tokenHash).where(sql`token_hash IS NOT NULL`),
    index('envelope_recipients_msgid_idx').on(t.sesMessageId),
]);

/**
 * Placed fields. Coordinates are percentages of the rendered page, which is what
 * lets the same numbers drive the placement UI at any zoom and the server-side
 * stamp at any page size. Assigned to a recipient, and only ever to a signer.
 */
export const envelopeFields = pgTable('envelope_fields', {
    fieldId: text('field_id').primaryKey(),
    versionId: text('version_id').notNull().references(() => envelopeVersions.versionId, { onDelete: 'cascade' }),
    recipientId: text('recipient_id').references(() => envelopeRecipients.recipientId, { onDelete: 'cascade' }),

    type: text('type').notNull(),                     // signature | initial | date | text
    label: text('label'),
    required: boolean('required').notNull().default(true),
    page: integer('page').notNull(),
    x: text('x').notNull(),                           // percentages held as text to avoid float drift
    y: text('y').notNull(),
    w: text('w').notNull(),
    h: text('h').notNull(),

    value: text('value'),
    filledAt: text('filled_at'),
    createdAt: text('created_at').notNull(),
}, (t) => [
    index('envelope_fields_version_idx').on(t.versionId),
    index('envelope_fields_recipient_idx').on(t.recipientId),
]);

/**
 * One row per recipient per version. The unique constraint is the idempotency
 * wall for signing, and `voided_at` is how an accepted reviewer edit revokes
 * consent without destroying the evidence that it was given.
 */
export const envelopeSignatures = pgTable('envelope_signatures', {
    signatureId: text('signature_id').primaryKey(),
    versionId: text('version_id').notNull().references(() => envelopeVersions.versionId, { onDelete: 'cascade' }),
    recipientId: text('recipient_id').notNull().references(() => envelopeRecipients.recipientId, { onDelete: 'cascade' }),

    typedName: text('typed_name'),
    signatureImageKey: text('signature_image_key'),
    signedAt: text('signed_at').notNull(),            // server clock, never a client-supplied timestamp
    ip: text('ip'),
    userAgent: text('user_agent'),

    voidedAt: text('voided_at'),
    voidedReason: text('voided_reason'),
}, (t) => [
    uniqueIndex('envelope_signatures_version_recipient_uq').on(t.versionId, t.recipientId),
]);

/**
 * The evidence chain. Append-only rows rather than a JSON array on the envelope,
 * so a position cannot be overwritten and `prev_hash` cannot be faked.
 *
 * `canonical` is the exact serialisation that was hashed. Storing it means the
 * chain can be re-verified later without depending on how the ORM happens to
 * re-encode a timestamp or a numeric on the way back out, which is what makes
 * "verify chain" impossible when only the object graph is kept.
 */
export const envelopeEvents = pgTable('envelope_events', {
    eventId: text('event_id').primaryKey(),
    envelopeId: text('envelope_id').notNull().references(() => envelopes.envelopeId, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),

    type: text('type').notNull(),
    actorType: text('actor_type').notNull(),          // owner | recipient | system
    actorId: text('actor_id'),
    actorLabel: text('actor_label'),
    versionId: text('version_id'),
    recipientId: text('recipient_id'),
    detail: jsonb('detail'),

    ip: text('ip'),
    userAgent: text('user_agent'),

    canonical: text('canonical').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    createdAt: text('created_at').notNull(),          // server clock
}, (t) => [
    uniqueIndex('envelope_events_env_seq_uq').on(t.envelopeId, t.seq),
    index('envelope_events_env_created_idx').on(t.envelopeId, t.createdAt),
]);

/** Sealed once. The unique constraint is the guarantee, not the handler. */
export const envelopeArtifacts = pgTable('envelope_artifacts', {
    artifactId: text('artifact_id').primaryKey(),
    envelopeId: text('envelope_id').notNull().references(() => envelopes.envelopeId, { onDelete: 'cascade' }),
    versionId: text('version_id'),
    kind: text('kind').notNull(),                     // original | sealed | certificate
    s3Key: text('s3_key').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: text('created_at').notNull(),
}, (t) => [
    uniqueIndex('envelope_artifacts_env_kind_uq').on(t.envelopeId, t.kind),
]);

/**
 * Reviewer comment pins. Addressed individually (unlike the inherited
 * implementation's unbounded array), so one can be resolved or replied to
 * without rewriting the set.
 */
export const envelopeComments = pgTable('envelope_comments', {
    commentId: text('comment_id').primaryKey(),
    envelopeId: text('envelope_id').notNull().references(() => envelopes.envelopeId, { onDelete: 'cascade' }),
    versionId: text('version_id').notNull(),
    recipientId: text('recipient_id'),
    authorLabel: text('author_label').notNull(),

    page: integer('page'),
    x: text('x'),
    y: text('y'),
    anchorQuote: text('anchor_quote'),

    body: text('body').notNull(),
    proposedText: text('proposed_text'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
}, (t) => [
    index('envelope_comments_version_idx').on(t.versionId),
    index('envelope_comments_env_created_idx').on(t.envelopeId, t.createdAt),
]);

/**
 * A reusable document. The same wording sent to many counterparties.
 *
 * Separate from `envelopes` rather than an `isTemplate` flag on one, because a
 * template has no recipients, no status machine, no chain and no signatures: it
 * is the thing an envelope is made FROM. Folding the two together would mean
 * every query over real documents had to remember to exclude templates, which
 * is the kind of filter someone eventually forgets.
 *
 * `body_markdown` carries anchor tokens ({{sig:counterparty}}, {{date:owner}})
 * that become fields when a document is generated from it, which is what lets
 * one template serve every counterparty. `s3_key` is the other shape: a file
 * uploaded once and sent repeatedly.
 */
export const envelopeTemplates = pgTable('envelope_templates', {
    templateId: text('template_id').primaryKey(),
    orgId: text('org_id').notNull().references(() => orgs.orgId, { onDelete: 'cascade' }),
    businessProfileId: text('business_profile_id'),
    createdBy: text('created_by').notNull(),

    name: text('name').notNull(),
    description: text('description'),
    // Fixed at the template, not chosen per send: the whole point is that the
    // same kind of document goes out the same way every time.
    kind: text('kind').notNull(),

    bodyMarkdown: text('body_markdown'),
    s3Key: text('s3_key'),

    timesUsed: integer('times_used').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
}, (t) => [
    index('envelope_templates_org_idx').on(t.orgId, t.createdAt),
]);

/**
 * A role on a template: a named slot such as counterparty, us, guarantor.
 *
 * This is the indirection the whole reuse story rests on. A field placed for
 * Dave Ellis is meaningless for the next counterparty; a field placed for THE
 * COUNTERPARTY works forever. Roles are what a template's fields point at, and
 * filling them with people is what turns a template into an envelope.
 *
 * `role_key` is stable within a template and is what fields reference, so
 * renaming the label a person sees does not orphan every field.
 */
export const envelopeTemplateRoles = pgTable('envelope_template_roles', {
    templateRoleId: text('template_role_id').primaryKey(),
    templateId: text('template_id').notNull().references(() => envelopeTemplates.templateId, { onDelete: 'cascade' }),
    roleKey: text('role_key').notNull(),
    label: text('label').notNull(),
    // What kind of recipient this role becomes: signer, reviewer or viewer.
    signingRole: text('signing_role').notNull(),
    orderNo: integer('order_no').notNull().default(0),
    required: boolean('required').notNull().default(true),
    createdAt: text('created_at').notNull(),
}, (t) => [
    uniqueIndex('envelope_template_roles_key_uq').on(t.templateId, t.roleKey),
]);

/**
 * A field on a template, bound to a role rather than a person.
 *
 * Copied onto the envelope at creation and re-pointed at whoever was given that
 * role. Copied rather than referenced, for the same reason the wording is:
 * editing the template later must not change a document already signed.
 */
export const envelopeTemplateFields = pgTable('envelope_template_fields', {
    templateFieldId: text('template_field_id').primaryKey(),
    templateId: text('template_id').notNull().references(() => envelopeTemplates.templateId, { onDelete: 'cascade' }),
    roleKey: text('role_key').notNull(),
    type: text('type').notNull(),
    label: text('label'),
    required: boolean('required').notNull().default(true),
    page: integer('page').notNull(),
    x: text('x').notNull(),
    y: text('y').notNull(),
    w: text('w').notNull(),
    h: text('h').notNull(),
    createdAt: text('created_at').notNull(),
}, (t) => [
    index('envelope_template_fields_template_idx').on(t.templateId),
]);
