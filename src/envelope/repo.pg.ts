import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getPg, getPgTx, type PgDb } from '../pg/client';
import {
    envelopes, envelopeVersions, envelopeRecipients, envelopeFields,
    envelopeSignatures, envelopeEvents, envelopeArtifacts, envelopeComments,
    envelopeTemplates,
} from '../pg/schema/envelopes';
import { hashChainEntry, verifyChain, type ChainEntryInput, type ChainVerdict, type ChainValue } from './chain';
import {
    tierForKind, isRefusedKind, canHoldFields, canSign, canReturnVerdict,
    type ArtifactKind, type EnvelopeDTO, type EnvelopeStatus, type FieldType,
    type RecipientRole, type ReviewVerdict,
} from './schema';

export interface AppendEventInput {
    type: string;
    actorType: 'owner' | 'recipient' | 'system';
    actorId?: string | null;
    actorLabel?: string | null;
    versionId?: string | null;
    recipientId?: string | null;
    detail?: Record<string, ChainValue> | null;
    ip?: string | null;
    userAgent?: string | null;
}

export interface CreateEnvelopeInput {
    envelopeId: string;
    orgId: string;
    businessProfileId?: string | null;
    createdBy: string;
    createdByLabel?: string | null;
    title: string;
    kind: string;
    versionId: string;
    bodyMarkdown?: string | null;
    s3Key?: string | null;
    sha256?: string | null;
    holdSignersForReview?: boolean;
}

export interface AddRecipientInput {
    recipientId: string;
    envelopeId: string;
    role: RecipientRole;
    email: string;
    name?: string | null;
    orderNo?: number;
}

export interface DispatchInput {
    recipientId: string;
    tokenHash: string;
    expiresAt?: string | null;
    sesMessageId?: string | null;
    accessCodeHash?: string | null;
    accessCodeSalt?: string | null;
    accessCodeParams?: Record<string, unknown> | null;
    accessCodeChannel?: string | null;
}

export interface AddFieldInput {
    fieldId: string;
    versionId: string;
    recipientId?: string | null;
    type: FieldType;
    label?: string | null;
    required?: boolean;
    page: number;
    x: number | string;
    y: number | string;
    w: number | string;
    h: number | string;
}

export interface CreateVersionInput {
    versionId: string;
    envelopeId: string;
    createdBy: string;
    bodyMarkdown?: string | null;
    s3Key?: string | null;
    sha256?: string | null;
    createdReason?: string;
}

export interface AddCommentInput {
    commentId: string;
    envelopeId: string;
    versionId: string;
    recipientId?: string | null;
    authorLabel: string;
    page?: number | null;
    x?: number | string | null;
    y?: number | string | null;
    anchorQuote?: string | null;
    body: string;
    proposedText?: string | null;
}

export interface CreateTemplateInput {
    templateId: string;
    orgId: string;
    businessProfileId?: string | null;
    createdBy: string;
    name: string;
    description?: string | null;
    kind: string;
    bodyMarkdown?: string | null;
    s3Key?: string | null;
}

export interface CreateFromTemplateInput {
    envelopeId: string;
    versionId: string;
    templateId: string;
    orgId: string;
    createdBy: string;
    createdByLabel?: string | null;
    /** Overrides the template name for this one document. */
    title?: string;
}

export interface EnvelopeCursor { createdAt: string; envelopeId: string }

export interface ListEnvelopesParams {
    orgId: string;
    limit?: number;
    cursor?: EnvelopeCursor | null;
    status?: EnvelopeStatus;
}

export interface ListEnvelopesResult {
    items: EnvelopeDTO[];
    nextCursor: EnvelopeCursor | null;
}

export interface RecordSignatureInput {
    signatureId: string;
    versionId: string;
    recipientId: string;
    typedName?: string | null;
    signatureImageKey?: string | null;
    ip?: string | null;
    userAgent?: string | null;
}

export interface SealArtifactInput {
    artifactId: string;
    envelopeId: string;
    versionId?: string | null;
    kind: ArtifactKind;
    s3Key: string;
    sha256: string;
    byteSize: number;
}

/** How many times a losing chain writer retries for the next free position. */
const APPEND_ATTEMPTS = 5;

export class EnvelopePgRepo {
    constructor(private readonly injected?: PgDb, private readonly injectedTx?: PgDb) {}
    private get db(): PgDb { return this.injected ?? getPg(); }
    private get tx(): PgDb { return this.injectedTx ?? this.injected ?? getPgTx(); }

    // ── the chain ────────────────────────────────────────────────────────

    /**
     * Append one entry, atomically, at the next free position.
     *
     * Read-max-then-insert is not safe on its own: two concurrent appends read
     * the same max and both try to take it. The UNIQUE (envelope_id, seq) index
     * is what makes that a lost insert rather than a fork, and the loser simply
     * takes the next position. That constraint is the reason this is correct,
     * not the transaction on its own.
     *
     * The timestamp is taken here, from the server clock. It is never accepted
     * from a caller: the inherited implementation hashed a client-supplied
     * `timestamp` into the chain, so a signer could attest to any moment they
     * liked and the chain would agree with them.
     */
    async appendEvent(envelopeId: string, input: AppendEventInput, eventIdFor: (seq: number) => string): Promise<{ seq: number; hash: string }> {
        let lastError: unknown;

        for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
            try {
                return await (this.tx as any).transaction(async (tx: any) => {
                    const tail = await tx.select({ seq: envelopeEvents.seq, hash: envelopeEvents.hash })
                        .from(envelopeEvents)
                        .where(eq(envelopeEvents.envelopeId, envelopeId))
                        .orderBy(desc(envelopeEvents.seq))
                        .limit(1);

                    const seq = (tail[0]?.seq ?? 0) + 1;
                    const prevHash = tail[0]?.hash ?? null;
                    const createdAt = new Date().toISOString();

                    const entry: ChainEntryInput = {
                        envelopeId,
                        seq,
                        type: input.type,
                        actorType: input.actorType,
                        actorId: input.actorId ?? null,
                        actorLabel: input.actorLabel ?? null,
                        versionId: input.versionId ?? null,
                        recipientId: input.recipientId ?? null,
                        detail: input.detail ?? null,
                        ip: input.ip ?? null,
                        userAgent: input.userAgent ?? null,
                        createdAt,
                        prevHash,
                    };
                    const { canonical, hash } = hashChainEntry(entry);

                    await tx.insert(envelopeEvents).values({
                        eventId: eventIdFor(seq),
                        envelopeId,
                        seq,
                        type: entry.type,
                        actorType: entry.actorType,
                        actorId: entry.actorId,
                        actorLabel: entry.actorLabel,
                        versionId: entry.versionId,
                        recipientId: entry.recipientId,
                        detail: entry.detail as any,
                        ip: entry.ip,
                        userAgent: entry.userAgent,
                        canonical,
                        prevHash,
                        hash,
                        createdAt,
                    });

                    return { seq, hash };
                });
            } catch (err) {
                lastError = err;
                // A unique violation here means someone else took this position
                // while we were computing. Try again for the next one.
                if (!isUniqueViolation(err)) throw err;
            }
        }
        throw new Error(`Could not append to the chain for ${envelopeId} after ${APPEND_ATTEMPTS} attempts: ${String(lastError)}`);
    }

    /** Re-verify a whole chain from what is stored, not from anything rebuilt. */
    async verifyChainFor(envelopeId: string): Promise<ChainVerdict> {
        const rows = await this.db.select({
            seq: envelopeEvents.seq,
            canonical: envelopeEvents.canonical,
            prevHash: envelopeEvents.prevHash,
            hash: envelopeEvents.hash,
        }).from(envelopeEvents)
            .where(eq(envelopeEvents.envelopeId, envelopeId))
            .orderBy(asc(envelopeEvents.seq));

        return verifyChain(rows as any);
    }

    async listEvents(envelopeId: string) {
        return this.db.select().from(envelopeEvents)
            .where(eq(envelopeEvents.envelopeId, envelopeId))
            .orderBy(asc(envelopeEvents.seq));
    }

    // ── envelopes ────────────────────────────────────────────────────────

    /**
     * Create an envelope, its first version and the chain's first entry
     * together. The tier is derived from the kind here and is not a parameter,
     * so there is no call site that can set it.
     */
    async create(input: CreateEnvelopeInput): Promise<EnvelopeDTO> {
        if (isRefusedKind(input.kind)) {
            throw new Error(`Documents of kind "${input.kind}" are not handled here`);
        }
        const tier = tierForKind(input.kind);
        const now = new Date().toISOString();

        await (this.tx as any).transaction(async (tx: any) => {
            await tx.insert(envelopes).values({
                envelopeId: input.envelopeId,
                orgId: input.orgId,
                businessProfileId: input.businessProfileId ?? null,
                createdBy: input.createdBy,
                title: input.title,
                kind: input.kind,
                tier,
                status: 'draft',
                currentVersionNo: 1,
                holdSignersForReview: input.holdSignersForReview ?? true,
                createdAt: now,
                updatedAt: now,
            }).onConflictDoNothing({ target: envelopes.envelopeId });

            await tx.insert(envelopeVersions).values({
                versionId: input.versionId,
                envelopeId: input.envelopeId,
                versionNo: 1,
                bodyMarkdown: input.bodyMarkdown ?? null,
                s3Key: input.s3Key ?? null,
                sha256: input.sha256 ?? null,
                createdBy: input.createdBy,
                createdReason: 'original',
                createdAt: now,
            }).onConflictDoNothing({ target: envelopeVersions.versionId });
        });

        await this.appendEvent(input.envelopeId, {
            type: 'created',
            actorType: 'owner',
            actorId: input.createdBy,
            actorLabel: input.createdByLabel ?? null,
            versionId: input.versionId,
            detail: { kind: input.kind, tier, title: input.title },
        }, (seq) => `${input.envelopeId}:${seq}`);

        const row = await this.get(input.envelopeId);
        if (!row) throw new Error('Envelope vanished immediately after creation');
        return row;
    }

    async listVersions(envelopeId: string) {
        return this.db.select().from(envelopeVersions)
            .where(eq(envelopeVersions.envelopeId, envelopeId))
            .orderBy(asc(envelopeVersions.versionNo));
    }

    /**
     * How many signers still owe a signature on this version.
     *
     * Computed in the database rather than by walking a recipients list the
     * caller loaded earlier. Completion decided from a stale read is how two
     * final signers arriving at the same moment both conclude they were last,
     * and the envelope gets completed (and emailed) twice.
     *
     * A revoked signer is not outstanding, and a voided signature does not
     * count as given.
     */
    async countOutstandingSigners(envelopeId: string, versionId: string): Promise<number> {
        const rows = await this.db.select({ n: sql<number>`count(*)::int` })
            .from(envelopeRecipients)
            .where(and(
                eq(envelopeRecipients.envelopeId, envelopeId),
                eq(envelopeRecipients.role, 'signer'),
                sql`${envelopeRecipients.revokedAt} IS NULL`,
                sql`NOT EXISTS (
                    SELECT 1 FROM envelope_signatures s
                     WHERE s.recipient_id = ${envelopeRecipients.recipientId}
                       AND s.version_id = ${versionId}
                       AND s.voided_at IS NULL
                )`,
            ));
        return Number((rows[0] as any)?.n ?? 0);
    }

    async get(envelopeId: string): Promise<EnvelopeDTO | null> {
        const r = await this.db.select().from(envelopes).where(eq(envelopes.envelopeId, envelopeId)).limit(1);
        return (r[0] as any) ?? null;
    }

    // ── recipients and signing ───────────────────────────────────────────

    async getRecipient(recipientId: string) {
        const r = await this.db.select().from(envelopeRecipients)
            .where(eq(envelopeRecipients.recipientId, recipientId)).limit(1);
        return (r[0] as any) ?? null;
    }

    /**
     * Resolve a presented token to its recipient, refusing anything expired or
     * revoked. Only the hash is ever compared, and the caller hashes the token
     * before it gets here so the raw value is never in a query.
     */
    async resolveByTokenHash(tokenHash: string, now = new Date().toISOString()) {
        const r = await this.db.select().from(envelopeRecipients)
            .where(and(
                eq(envelopeRecipients.tokenHash, tokenHash),
                sql`${envelopeRecipients.revokedAt} IS NULL`,
                sql`(${envelopeRecipients.expiresAt} IS NULL OR ${envelopeRecipients.expiresAt} > ${now})`,
            ))
            .limit(1);
        return (r[0] as any) ?? null;
    }

    /**
     * Record a signature. The unique index on (version_id, recipient_id) is the
     * idempotency wall: a replayed POST loses the insert and gets the prior row
     * back instead of appending a second chain entry and re-sending the email.
     * Returns whether this call was the one that actually signed.
     */
    async recordSignature(input: RecordSignatureInput): Promise<{ created: boolean; signatureId: string }> {
        const recipient = await this.getRecipient(input.recipientId);
        if (!recipient) throw new Error('Unknown recipient');
        if (!canSign(recipient.role as RecipientRole)) {
            throw new Error(`A ${recipient.role} cannot sign`);
        }

        const inserted = await (this.db as any).insert(envelopeSignatures).values({
            signatureId: input.signatureId,
            versionId: input.versionId,
            recipientId: input.recipientId,
            typedName: input.typedName ?? null,
            signatureImageKey: input.signatureImageKey ?? null,
            signedAt: new Date().toISOString(),
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
        }).onConflictDoNothing({
            target: [envelopeSignatures.versionId, envelopeSignatures.recipientId],
        }).returning({ id: envelopeSignatures.signatureId });

        if (inserted.length > 0) return { created: true, signatureId: inserted[0].id };

        const existing = await this.db.select({ id: envelopeSignatures.signatureId })
            .from(envelopeSignatures)
            .where(and(
                eq(envelopeSignatures.versionId, input.versionId),
                eq(envelopeSignatures.recipientId, input.recipientId),
            )).limit(1);
        return { created: false, signatureId: (existing[0] as any).id };
    }

    /**
     * Void every signature collected against a version. Used when a reviewer's
     * proposed edit is accepted after someone has already signed: consent to v1
     * does not carry to v2, and the rows stay so the record can still say what
     * was agreed and when it stopped applying.
     */
    async voidSignaturesForVersion(versionId: string, reason: string): Promise<number> {
        const rows = await (this.db as any).update(envelopeSignatures)
            .set({ voidedAt: new Date().toISOString(), voidedReason: reason })
            .where(and(
                eq(envelopeSignatures.versionId, versionId),
                sql`${envelopeSignatures.voidedAt} IS NULL`,
            ))
            .returning({ id: envelopeSignatures.signatureId });
        return rows.length;
    }

    /**
     * Add a recipient. Idempotent on the id so a retried prepare does not create
     * the person twice. A reviewer is added the same way a signer is: the role
     * column, not a separate table, is what keeps one recipients list while the
     * two lifecycles stay distinct.
     */
    async addRecipient(input: AddRecipientInput): Promise<{ recipientId: string; created: boolean }> {
        const now = new Date().toISOString();
        const inserted = await (this.db as any).insert(envelopeRecipients).values({
            recipientId: input.recipientId,
            envelopeId: input.envelopeId,
            role: input.role,
            orderNo: input.orderNo ?? 0,
            name: input.name ?? null,
            email: input.email,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
        }).onConflictDoNothing({ target: envelopeRecipients.recipientId })
            .returning({ id: envelopeRecipients.recipientId });

        return { recipientId: input.recipientId, created: inserted.length > 0 };
    }

    async listRecipients(envelopeId: string) {
        return this.db.select().from(envelopeRecipients)
            .where(eq(envelopeRecipients.envelopeId, envelopeId))
            .orderBy(asc(envelopeRecipients.orderNo));
    }

    /**
     * Attach the credential and mark the link as sent.
     *
     * The SES message id is stored HERE, at the moment of sending, because it is
     * the only handle a later bounce notification carries. Captured afterwards
     * it correlates nothing, and the reminder sweep goes on mailing an address
     * that never received anything.
     */
    async markDispatched(input: DispatchInput): Promise<void> {
        await (this.db as any).update(envelopeRecipients).set({
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt ?? null,
            sesMessageId: input.sesMessageId ?? null,
            accessCodeHash: input.accessCodeHash ?? null,
            accessCodeSalt: input.accessCodeSalt ?? null,
            accessCodeParams: (input.accessCodeParams ?? null) as any,
            accessCodeChannel: input.accessCodeChannel ?? null,
            status: 'dispatched',
            dispatchedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }).where(eq(envelopeRecipients.recipientId, input.recipientId));
    }

    /** First open only. Re-opening is not a new fact worth another chain entry. */
    async markOpened(recipientId: string): Promise<{ firstOpen: boolean }> {
        const now = new Date().toISOString();
        const rows = await (this.db as any).update(envelopeRecipients)
            .set({ firstOpenedAt: now, status: 'opened', updatedAt: now })
            .where(and(
                eq(envelopeRecipients.recipientId, recipientId),
                sql`${envelopeRecipients.firstOpenedAt} IS NULL`,
            ))
            .returning({ id: envelopeRecipients.recipientId });
        return { firstOpen: rows.length > 0 };
    }

    /**
     * Correlate a bounce back to the recipient by the message id captured at
     * send. Returns the recipients it matched so the caller can write the chain
     * entry and stop reminding them.
     */
    async markBouncedByMessageId(sesMessageId: string, bounceType: string, reason: string) {
        const now = new Date().toISOString();
        return await (this.db as any).update(envelopeRecipients)
            .set({ status: 'bounced', bouncedAt: now, bounceType, bounceReason: reason, updatedAt: now })
            .where(and(
                eq(envelopeRecipients.sesMessageId, sesMessageId),
                sql`${envelopeRecipients.bouncedAt} IS NULL`,
            ))
            .returning({ recipientId: envelopeRecipients.recipientId, envelopeId: envelopeRecipients.envelopeId });
    }

    /** Only a reviewer returns a verdict, and only once. */
    async recordVerdict(recipientId: string, verdict: ReviewVerdict, note?: string | null): Promise<{ recorded: boolean }> {
        const recipient = await this.getRecipient(recipientId);
        if (!recipient) throw new Error('Unknown recipient');
        if (!canReturnVerdict(recipient.role as RecipientRole)) {
            throw new Error(`A ${recipient.role} cannot return a verdict`);
        }
        const now = new Date().toISOString();
        const rows = await (this.db as any).update(envelopeRecipients)
            .set({ verdict, verdictAt: now, verdictNote: note ?? null, status: 'reviewed', updatedAt: now })
            .where(and(
                eq(envelopeRecipients.recipientId, recipientId),
                sql`${envelopeRecipients.verdict} IS NULL`,
            ))
            .returning({ id: envelopeRecipients.recipientId });
        return { recorded: rows.length > 0 };
    }

    /** Revoking is a column write, which is the whole reason the token is stored rather than keyed. */
    async revokeRecipient(recipientId: string, reason: string): Promise<void> {
        const now = new Date().toISOString();
        await (this.db as any).update(envelopeRecipients)
            .set({ revokedAt: now, revokedReason: reason, status: 'revoked', updatedAt: now })
            .where(eq(envelopeRecipients.recipientId, recipientId));
    }

    async setEnvelopeStatus(envelopeId: string, status: EnvelopeStatus): Promise<void> {
        await (this.db as any).update(envelopes)
            .set({ status, updatedAt: new Date().toISOString() })
            .where(eq(envelopes.envelopeId, envelopeId));
    }

    /**
     * Count a wrong access code and lock the link once there have been too many.
     * Incremented in the statement rather than read-modify-written, so parallel
     * guesses cannot each read the same low count.
     */
    async registerFailedCodeAttempt(recipientId: string, maxAttempts: number, lockedUntil: string): Promise<{ attempts: number; locked: boolean }> {
        const rows = await (this.db as any).update(envelopeRecipients)
            .set({
                failedAttempts: sql`${envelopeRecipients.failedAttempts} + 1`,
                lockedUntil: sql`CASE WHEN ${envelopeRecipients.failedAttempts} + 1 >= ${maxAttempts} THEN ${lockedUntil} ELSE ${envelopeRecipients.lockedUntil} END`,
                updatedAt: new Date().toISOString(),
            })
            .where(eq(envelopeRecipients.recipientId, recipientId))
            .returning({ attempts: envelopeRecipients.failedAttempts, lockedUntil: envelopeRecipients.lockedUntil });
        const attempts = rows[0]?.attempts ?? 0;
        return { attempts, locked: attempts >= maxAttempts };
    }

    /** A correct code clears the counter so an honest typo does not accumulate for ever. */
    async clearFailedCodeAttempts(recipientId: string): Promise<void> {
        await (this.db as any).update(envelopeRecipients)
            .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date().toISOString() })
            .where(eq(envelopeRecipients.recipientId, recipientId));
    }

    // ── fields ───────────────────────────────────────────────────────────

    /** Only a signer may hold a field. A reviewer holding one is how a reviewer ends up signing. */
    async assertFieldAssignable(recipientId: string): Promise<void> {
        const recipient = await this.getRecipient(recipientId);
        if (!recipient) throw new Error('Unknown recipient');
        if (!canHoldFields(recipient.role as RecipientRole)) {
            throw new Error(`A ${recipient.role} cannot be assigned a field`);
        }
    }

    async listFields(versionId: string) {
        return this.db.select().from(envelopeFields)
            .where(eq(envelopeFields.versionId, versionId))
            .orderBy(asc(envelopeFields.page));
    }

    /**
     * Place a field. Refuses a recipient who cannot hold one, so the rule lives
     * with the write rather than only in whatever screen happens to call it.
     */
    async addField(input: AddFieldInput): Promise<{ fieldId: string; created: boolean }> {
        if (input.recipientId) await this.assertFieldAssignable(input.recipientId);
        const inserted = await (this.db as any).insert(envelopeFields).values({
            fieldId: input.fieldId,
            versionId: input.versionId,
            recipientId: input.recipientId ?? null,
            type: input.type,
            label: input.label ?? null,
            required: input.required ?? true,
            page: input.page,
            x: String(input.x), y: String(input.y), w: String(input.w), h: String(input.h),
            createdAt: new Date().toISOString(),
        }).onConflictDoNothing({ target: envelopeFields.fieldId })
            .returning({ id: envelopeFields.fieldId });
        return { fieldId: input.fieldId, created: inserted.length > 0 };
    }

    async removeField(fieldId: string): Promise<void> {
        await (this.db as any).delete(envelopeFields).where(eq(envelopeFields.fieldId, fieldId));
    }

    /** Fill one field as part of signing. */
    async fillField(fieldId: string, value: string): Promise<void> {
        await (this.db as any).update(envelopeFields)
            .set({ value, filledAt: new Date().toISOString() })
            .where(eq(envelopeFields.fieldId, fieldId));
    }

    // ── versions ─────────────────────────────────────────────────────────

    /**
     * Supersede the current version with a new one. Used when a reviewer's
     * proposed edit is accepted: the caller voids the signatures on the old
     * version separately, because consent to v1 does not carry to v2.
     */
    async createVersion(input: CreateVersionInput): Promise<{ versionId: string; versionNo: number }> {
        return await (this.tx as any).transaction(async (tx: any) => {
            const latest = await tx.select({ n: envelopeVersions.versionNo })
                .from(envelopeVersions)
                .where(eq(envelopeVersions.envelopeId, input.envelopeId))
                .orderBy(desc(envelopeVersions.versionNo))
                .limit(1);
            const versionNo = (latest[0]?.n ?? 0) + 1;
            const now = new Date().toISOString();

            await tx.update(envelopeVersions)
                .set({ supersededAt: now })
                .where(and(
                    eq(envelopeVersions.envelopeId, input.envelopeId),
                    sql`${envelopeVersions.supersededAt} IS NULL`,
                ));

            await tx.insert(envelopeVersions).values({
                versionId: input.versionId,
                envelopeId: input.envelopeId,
                versionNo,
                bodyMarkdown: input.bodyMarkdown ?? null,
                s3Key: input.s3Key ?? null,
                sha256: input.sha256 ?? null,
                createdBy: input.createdBy,
                createdReason: input.createdReason ?? 'reviewer_edit_accepted',
                createdAt: now,
            });

            await tx.update(envelopes)
                .set({ currentVersionNo: versionNo, updatedAt: now })
                .where(eq(envelopes.envelopeId, input.envelopeId));

            return { versionId: input.versionId, versionNo };
        });
    }

    // ── comments ─────────────────────────────────────────────────────────

    async addComment(input: AddCommentInput): Promise<{ commentId: string; created: boolean }> {
        const inserted = await (this.db as any).insert(envelopeComments).values({
            commentId: input.commentId,
            envelopeId: input.envelopeId,
            versionId: input.versionId,
            recipientId: input.recipientId ?? null,
            authorLabel: input.authorLabel,
            page: input.page ?? null,
            x: input.x != null ? String(input.x) : null,
            y: input.y != null ? String(input.y) : null,
            anchorQuote: input.anchorQuote ?? null,
            body: input.body,
            proposedText: input.proposedText ?? null,
            createdAt: new Date().toISOString(),
        }).onConflictDoNothing({ target: envelopeComments.commentId })
            .returning({ id: envelopeComments.commentId });
        return { commentId: input.commentId, created: inserted.length > 0 };
    }

    async listComments(versionId: string) {
        return this.db.select().from(envelopeComments)
            .where(eq(envelopeComments.versionId, versionId))
            .orderBy(asc(envelopeComments.createdAt));
    }

    async resolveComment(commentId: string): Promise<void> {
        await (this.db as any).update(envelopeComments)
            .set({ resolvedAt: new Date().toISOString() })
            .where(and(
                eq(envelopeComments.commentId, commentId),
                sql`${envelopeComments.resolvedAt} IS NULL`,
            ));
    }

    // ── reusable documents ───────────────────────────────────────────────

    async createTemplate(input: CreateTemplateInput): Promise<{ templateId: string; created: boolean }> {
        if (isRefusedKind(input.kind)) {
            throw new Error(`Documents of kind "${input.kind}" are not handled here`);
        }
        const now = new Date().toISOString();
        const inserted = await (this.db as any).insert(envelopeTemplates).values({
            templateId: input.templateId,
            orgId: input.orgId,
            businessProfileId: input.businessProfileId ?? null,
            createdBy: input.createdBy,
            name: input.name,
            description: input.description ?? null,
            kind: input.kind,
            bodyMarkdown: input.bodyMarkdown ?? null,
            s3Key: input.s3Key ?? null,
            createdAt: now,
            updatedAt: now,
        }).onConflictDoNothing({ target: envelopeTemplates.templateId })
            .returning({ id: envelopeTemplates.templateId });
        return { templateId: input.templateId, created: inserted.length > 0 };
    }

    async listTemplates(orgId: string, includeArchived = false) {
        const clauses = [eq(envelopeTemplates.orgId, orgId)];
        if (!includeArchived) clauses.push(sql`${envelopeTemplates.archivedAt} IS NULL`);
        return this.db.select().from(envelopeTemplates)
            .where(and(...clauses))
            .orderBy(desc(envelopeTemplates.createdAt));
    }

    async getTemplate(templateId: string) {
        const r = await this.db.select().from(envelopeTemplates)
            .where(eq(envelopeTemplates.templateId, templateId)).limit(1);
        return (r[0] as any) ?? null;
    }

    /** Archived rather than deleted: a document already sent from it still names it. */
    async archiveTemplate(templateId: string): Promise<void> {
        await (this.db as any).update(envelopeTemplates)
            .set({ archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
            .where(eq(envelopeTemplates.templateId, templateId));
    }

    /**
     * Make a document from a template.
     *
     * The template's wording and kind are copied onto the new envelope rather
     * than referenced, so editing the template later cannot change a document
     * that has already gone out. That is a deliberate frozen copy: what someone
     * signed has to stay what it was.
     */
    async createFromTemplate(input: CreateFromTemplateInput): Promise<EnvelopeDTO> {
        const template = await this.getTemplate(input.templateId);
        if (!template || template.orgId !== input.orgId) throw new Error('No such template');

        const envelope = await this.create({
            envelopeId: input.envelopeId,
            orgId: input.orgId,
            businessProfileId: template.businessProfileId ?? null,
            createdBy: input.createdBy,
            createdByLabel: input.createdByLabel ?? null,
            title: input.title || template.name,
            kind: template.kind,
            versionId: input.versionId,
            bodyMarkdown: template.bodyMarkdown ?? null,
            s3Key: template.s3Key ?? null,
        });

        // Atomic increment, never read-modify-write: two people using the same
        // template at once should count as two.
        await (this.db as any).update(envelopeTemplates)
            .set({ timesUsed: sql`${envelopeTemplates.timesUsed} + 1`, updatedAt: new Date().toISOString() })
            .where(eq(envelopeTemplates.templateId, input.templateId));

        return envelope;
    }

    // ── the vault ────────────────────────────────────────────────────────

    /**
     * Keyset pagination, the house contract: `limit` in, an opaque `nextToken`
     * out. Never returns the whole table, whatever the caller asks for.
     */
    async listEnvelopes(params: ListEnvelopesParams): Promise<ListEnvelopesResult> {
        const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
        const clauses = [eq(envelopes.orgId, params.orgId)];
        if (params.status) clauses.push(eq(envelopes.status, params.status));
        if (params.cursor) {
            clauses.push(sql`(${envelopes.createdAt}, ${envelopes.envelopeId}) < (${params.cursor.createdAt}, ${params.cursor.envelopeId})`);
        }

        const rows = await this.db.select().from(envelopes)
            .where(and(...clauses))
            .orderBy(desc(envelopes.createdAt), desc(envelopes.envelopeId))
            .limit(limit + 1);

        const items = rows.slice(0, limit) as any[];
        const more = rows.length > limit;
        const last = items[items.length - 1];
        return {
            items,
            nextCursor: more && last ? { createdAt: last.createdAt, envelopeId: last.envelopeId } : null,
        };
    }

    /**
     * The vault's column counts, as one grouped query. Counting by reducing over
     * a loaded page works at a dozen documents and is silently wrong at sixty.
     */
    async countByStatus(orgId: string): Promise<Record<string, number>> {
        const rows = await this.db.select({ status: envelopes.status, n: sql<number>`count(*)::int` })
            .from(envelopes)
            .where(eq(envelopes.orgId, orgId))
            .groupBy(envelopes.status);
        const out: Record<string, number> = {};
        for (const r of rows as any[]) out[r.status] = Number(r.n);
        return out;
    }

    // ── artifacts ────────────────────────────────────────────────────────

    /**
     * Store a sealed artifact. The unique index on (envelope_id, kind) means the
     * first writer wins and every later one is told so, rather than a second
     * seal quietly replacing the first. Chromium output is deterministic for a
     * build and not across builds, so a regenerated seal would not match the
     * hash the chain already attests to.
     */
    async sealOnce(input: SealArtifactInput): Promise<{ sealed: boolean; existingS3Key?: string }> {
        const inserted = await (this.db as any).insert(envelopeArtifacts).values({
            artifactId: input.artifactId,
            envelopeId: input.envelopeId,
            versionId: input.versionId ?? null,
            kind: input.kind,
            s3Key: input.s3Key,
            sha256: input.sha256,
            byteSize: input.byteSize,
            createdAt: new Date().toISOString(),
        }).onConflictDoNothing({
            target: [envelopeArtifacts.envelopeId, envelopeArtifacts.kind],
        }).returning({ id: envelopeArtifacts.artifactId });

        if (inserted.length > 0) return { sealed: true };

        const existing = await this.db.select({ k: envelopeArtifacts.s3Key })
            .from(envelopeArtifacts)
            .where(and(
                eq(envelopeArtifacts.envelopeId, input.envelopeId),
                eq(envelopeArtifacts.kind, input.kind),
            )).limit(1);
        return { sealed: false, existingS3Key: (existing[0] as any)?.k };
    }
}

/** Postgres reports a unique violation as SQLSTATE 23505, whichever driver is in front of it. */
function isUniqueViolation(err: unknown): boolean {
    const e = err as any;
    return e?.code === '23505'
        || e?.cause?.code === '23505'
        || /duplicate key value|unique constraint/i.test(String(e?.message ?? ''));
}
