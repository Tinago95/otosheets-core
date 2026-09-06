/**
 * The due-work queries the daily document sweep runs.
 *
 * Kept in their own file rather than added to EnvelopePgRepo's already long
 * body, because they are the only queries in this domain written for a CRON
 * rather than for a request. That changes what matters about them: a request
 * reads one document somebody is looking at, and a cron reads across every
 * document in the platform, so every one of these has to be indexed, bounded
 * and cursor-paged or it becomes a scan that times out at the least convenient
 * moment.
 *
 * The cursor is load-bearing and not a nicety. A recipient whose envelope
 * refuses to expire, because another signer's link is still good, keeps
 * matching the expiry predicate for ever. A "give me the first N due" query
 * would therefore hand back the same rows on every page and the caller's loop
 * would never terminate.
 */
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { envelopes, envelopeRecipients } from '../pg/schema/envelopes';

/** Statuses from which a document can still legitimately be signed. */
const LIVE_STATUSES = ['out_for_signing', 'in_review'] as const;

/** Recipient statuses that mean this person is no longer being waited on. */
const SETTLED_RECIPIENT_STATUSES = ['signed', 'declined', 'reviewed', 'bounced'] as const;

export interface SweepCursor {
    expiresAt?: string;
    dispatchedAt?: string;
    recipientId: string;
}

export interface Page<T> {
    items: T[];
    nextCursor: SweepCursor | null;
}

export interface DueExpiryRow {
    envelopeId: string;
    recipientId: string;
    expiresAt: string;
}

export interface DueReminderRow {
    envelopeId: string;
    recipientId: string;
    title: string;
    email: string;
    name: string | null;
    role: string;
    dispatchedAt: string;
    expiresAt: string | null;
}

/** A recipient still holding a link somebody could use right now. */
function stillUsable(now: string) {
    return and(
        isNull(envelopeRecipients.revokedAt),
        sql`${envelopeRecipients.tokenHash} IS NOT NULL`,
        sql`${envelopeRecipients.status} NOT IN ('signed','declined','bounced')`,
        or(isNull(envelopeRecipients.expiresAt), gt(envelopeRecipients.expiresAt, now)),
    );
}

export function makeSweepQueries(db: any) {
    return {
        /**
         * Recipients whose link has lapsed, on a document still waiting.
         *
         * Ordered by (expires_at, recipient_id) and resumed strictly after the
         * cursor, so a row this caller decides not to act on cannot come back
         * on the next page.
         */
        async listRecipientsPastExpiry(
            now: string, limit: number, cursor: SweepCursor | null,
        ): Promise<Page<DueExpiryRow>> {
            const rows = await db.select({
                envelopeId: envelopeRecipients.envelopeId,
                recipientId: envelopeRecipients.recipientId,
                expiresAt: envelopeRecipients.expiresAt,
            })
                .from(envelopeRecipients)
                .innerJoin(envelopes, eq(envelopes.envelopeId, envelopeRecipients.envelopeId))
                .where(and(
                    sql`${envelopeRecipients.expiresAt} IS NOT NULL`,
                    lt(envelopeRecipients.expiresAt, now),
                    isNull(envelopeRecipients.revokedAt),
                    sql`${envelopes.status} IN ('out_for_signing','in_review')`,
                    cursor
                        ? sql`(${envelopeRecipients.expiresAt}, ${envelopeRecipients.recipientId})
                               > (${cursor.expiresAt ?? ''}, ${cursor.recipientId})`
                        : undefined,
                ))
                .orderBy(asc(envelopeRecipients.expiresAt), asc(envelopeRecipients.recipientId))
                .limit(limit + 1);

            return page(rows, limit, (r: any) => ({
                expiresAt: r.expiresAt, recipientId: r.recipientId,
            }));
        },

        /**
         * Flip one document to expired, once, and say whether this call did it.
         *
         * One statement, conditional on two things at the same time: the status
         * is still live, so a sweep racing the final signature cannot overwrite
         * completed; and NOBODY still holds a usable link, so one signer's dead
         * link does not close a document another signer can still sign.
         *
         * Deliberately not setEnvelopeStatus, which is an unconditional write.
         */
        async expireOnce(envelopeId: string, now: string): Promise<{ expired: boolean }> {
            const rows = await db.update(envelopes)
                .set({ status: 'expired', updatedAt: now })
                .where(and(
                    eq(envelopes.envelopeId, envelopeId),
                    sql`${envelopes.status} IN ('out_for_signing','in_review')`,
                    sql`NOT EXISTS (
                        SELECT 1 FROM envelope_recipients r
                         WHERE r.envelope_id = ${envelopeId}
                           AND r.revoked_at IS NULL
                           AND r.token_hash IS NOT NULL
                           AND r.status NOT IN ('signed','declined','bounced')
                           AND (r.expires_at IS NULL OR r.expires_at > ${now})
                    )`,
                ))
                .returning({ id: envelopes.envelopeId });
            return { expired: rows.length > 0 };
        },

        /**
         * Recipients who were sent a link, never opened it, and have not been
         * nudged.
         *
         * `first_opened_at IS NULL` is not a refinement, it is a safety
         * property: the reminder re-issues the link, because only the hash of a
         * token is stored and the raw one in the inbox cannot be recovered. So
         * reminding somebody who has the document open would kill the tab they
         * are reading. Excluding unopened links makes the replacement free.
         */
        async listRecipientsDueReminder(
            dispatchedBefore: string, now: string, limit: number, cursor: SweepCursor | null,
        ): Promise<Page<DueReminderRow>> {
            const rows = await db.select({
                envelopeId: envelopeRecipients.envelopeId,
                recipientId: envelopeRecipients.recipientId,
                title: envelopes.title,
                email: envelopeRecipients.email,
                name: envelopeRecipients.name,
                role: envelopeRecipients.role,
                dispatchedAt: envelopeRecipients.dispatchedAt,
                expiresAt: envelopeRecipients.expiresAt,
            })
                .from(envelopeRecipients)
                .innerJoin(envelopes, eq(envelopes.envelopeId, envelopeRecipients.envelopeId))
                .where(and(
                    sql`${envelopeRecipients.dispatchedAt} IS NOT NULL`,
                    lt(envelopeRecipients.dispatchedAt, dispatchedBefore),
                    isNull(envelopeRecipients.firstOpenedAt),
                    isNull(envelopeRecipients.remindedAt),
                    isNull(envelopeRecipients.revokedAt),
                    sql`${envelopeRecipients.tokenHash} IS NOT NULL`,
                    sql`${envelopeRecipients.status} NOT IN ('signed','declined','reviewed','bounced')`,
                    or(isNull(envelopeRecipients.expiresAt), gt(envelopeRecipients.expiresAt, now)),
                    sql`${envelopes.status} IN ('out_for_signing','in_review')`,
                    cursor
                        ? sql`(${envelopeRecipients.dispatchedAt}, ${envelopeRecipients.recipientId})
                               > (${cursor.dispatchedAt ?? ''}, ${cursor.recipientId})`
                        : undefined,
                ))
                .orderBy(asc(envelopeRecipients.dispatchedAt), asc(envelopeRecipients.recipientId))
                .limit(limit + 1);

            return page(rows, limit, (r: any) => ({
                dispatchedAt: r.dispatchedAt, recipientId: r.recipientId,
            }));
        },

        /**
         * Claim the one reminder, conditional on nobody having claimed it.
         *
         * A column rather than the chain, because appendEvent retries a
         * duplicate id and then throws, so "already reminded" would be
         * indistinguishable from a contended chain. A guard on whether to send
         * an email must never rest on parsing an error.
         */
        async markRemindedOnce(recipientId: string, at: string): Promise<{ claimed: boolean }> {
            const rows = await db.update(envelopeRecipients)
                .set({ remindedAt: at, updatedAt: at })
                .where(and(
                    eq(envelopeRecipients.recipientId, recipientId),
                    isNull(envelopeRecipients.remindedAt),
                ))
                .returning({ id: envelopeRecipients.recipientId });
            return { claimed: rows.length > 0 };
        },

        /**
         * Record a decline once, so a double tap is one entry on the chain.
         *
         * The envelope status refuses a SEQUENTIAL replay, but two requests
         * inside one round trip both read the old status and both proceed. This
         * is the conditional write that decides between them.
         */
        async declineOnce(
            recipientId: string, reason: string, at: string,
        ): Promise<{ declined: boolean }> {
            const rows = await db.update(envelopeRecipients)
                .set({ status: 'declined', declinedAt: at, declinedReason: reason, updatedAt: at })
                .where(and(
                    eq(envelopeRecipients.recipientId, recipientId),
                    isNull(envelopeRecipients.declinedAt),
                ))
                .returning({ id: envelopeRecipients.recipientId });
            return { declined: rows.length > 0 };
        },

        /** Exposed for the expiry pass, which needs to know if anyone can still sign. */
        _stillUsable: stillUsable,
    };
}

/** One extra row is fetched to decide whether there is a next page. */
function page<T>(rows: any[], limit: number, toCursor: (r: any) => SweepCursor): Page<T> {
    const items = rows.slice(0, limit) as T[];
    const nextCursor = rows.length > limit ? toCursor(rows[limit - 1]) : null;
    return { items, nextCursor };
}
