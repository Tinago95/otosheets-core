import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { runMigrations, type SqlExecutor } from '../pg/migrate';
import type { PgDb } from '../pg/client';
import { EnvelopePgRepo } from './repo.pg';
import { tierForKind, isRefusedKind, canDraftKind } from './schema';

let db: PgDb;
let repo: EnvelopePgRepo;
let pglite: PGlite;

let n = 0;
const id = (p: string) => `${p}_${++n}`;

async function addRecipient(envelopeId: string, role: string, over: Record<string, unknown> = {}) {
    const recipientId = id('rcp');
    const now = new Date().toISOString();
    await pglite.query(
        `INSERT INTO envelope_recipients (recipient_id, envelope_id, role, email, status, created_at, updated_at, token_hash, expires_at, revoked_at)
         VALUES ($1,$2,$3,$4,'pending',$5,$5,$6,$7,$8)`,
        [recipientId, envelopeId, role, `${role}@example.com`, now,
         (over.tokenHash as string) ?? null, (over.expiresAt as string) ?? null, (over.revokedAt as string) ?? null],
    );
    return recipientId;
}

async function makeEnvelope(kind = 'proposal', orgId = 'org_1') {
    const envelopeId = id('env');
    const versionId = id('ver');
    await repo.create({
        envelopeId, orgId, createdBy: 'user_1', createdByLabel: 'Leon',
        title: 'Roof replacement', kind, versionId,
    });
    return { envelopeId, versionId };
}

/** Somebody else's document, for the scoping tests. */
async function otherOrgEnvelope() {
    return makeEnvelope('proposal', 'org_2');
}

beforeAll(async () => {
    pglite = new PGlite({ extensions: { pg_trgm } });
    const executor: SqlExecutor = { exec: async (s: string) => ({ rows: (await pglite.query(s)).rows as any[] }) };
    await runMigrations(executor);
    db = drizzle(pglite) as unknown as PgDb;
    await pglite.query("INSERT INTO orgs (org_id, name) VALUES ('org_1', 'Acme')");
    await pglite.query("INSERT INTO orgs (org_id, name) VALUES ('org_2', 'Someone else')");
    // PGlite is a single connection, so the same handle serves reads and the
    // transactional path. That is what makes the concurrency test below a real
    // test of the UNIQUE constraint rather than of connection isolation.
    repo = new EnvelopePgRepo(db, db);
});

describe('the tier engine', () => {
    it('derives the tier from the kind', () => {
        expect(tierForKind('proposal')).toBe(0);
        expect(tierForKind('nda')).toBe(1);
        expect(tierForKind('employment')).toBe(2);
    });

    it('fails closed on a kind it does not know', () => {
        expect(() => tierForKind('mystery')).toThrow(/Unknown document kind/);
        expect(isRefusedKind('mystery')).toBe(true);
        expect(canDraftKind('mystery')).toBe(false);
    });

    it('allows drafting at tier 0 only', () => {
        expect(canDraftKind('proposal')).toBe(true);
        expect(canDraftKind('nda')).toBe(false);
        expect(canDraftKind('employment')).toBe(false);
    });

    it('refuses to create a regulated document at all', async () => {
        await expect(repo.create({
            envelopeId: id('env'), orgId: 'org_1', createdBy: 'user_1',
            title: 'Employment contract', kind: 'employment', versionId: id('ver'),
        })).rejects.toThrow(/not handled here/);
    });

    it('stores the derived tier, which no caller supplies', async () => {
        const { envelopeId } = await makeEnvelope('nda');
        expect((await repo.get(envelopeId))?.tier).toBe(1);
    });
});

describe('creating an envelope', () => {
    it('writes the envelope, its first version and the chain root together', async () => {
        const { envelopeId } = await makeEnvelope();
        const env = await repo.get(envelopeId);
        expect(env?.status).toBe('draft');
        expect(env?.currentVersionNo).toBe(1);

        const events = await repo.listEvents(envelopeId);
        expect(events).toHaveLength(1);
        expect((events[0] as any).seq).toBe(1);
        expect((events[0] as any).prevHash).toBeNull();
        expect((events[0] as any).type).toBe('created');
    });

    it('is retry-safe on the same ids', async () => {
        const envelopeId = id('env');
        const versionId = id('ver');
        const args = { envelopeId, orgId: 'org_1', createdBy: 'user_1', title: 'Retry', kind: 'proposal', versionId };
        await repo.create(args);
        await repo.create(args);
        const versions = await pglite.query('SELECT * FROM envelope_versions WHERE envelope_id = $1', [envelopeId]);
        expect(versions.rows).toHaveLength(1);
    });
});

describe('the chain', () => {
    it('links each entry to the one before it and verifies', async () => {
        const { envelopeId } = await makeEnvelope();
        for (const type of ['sent', 'opened', 'signed']) {
            await repo.appendEvent(envelopeId, { type, actorType: 'system' }, (s) => `${envelopeId}:${s}`);
        }
        const events = await repo.listEvents(envelopeId);
        expect(events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4]);
        for (let i = 1; i < events.length; i++) {
            expect((events[i] as any).prevHash).toBe((events[i - 1] as any).hash);
        }
        expect(await repo.verifyChainFor(envelopeId)).toEqual({ ok: true, length: 4 });
    });

    it('does not fork when appends race', async () => {
        // The inherited implementation read the tail, appended and wrote back
        // with nothing serialising it, so two signers signing at once both took
        // the same position. Here the unique index makes the loser retry.
        const { envelopeId } = await makeEnvelope();
        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                repo.appendEvent(envelopeId, { type: `race_${i}`, actorType: 'system' }, (s) => `${envelopeId}:${s}`)),
        );
        const events = await repo.listEvents(envelopeId);
        expect(events).toHaveLength(9); // the root plus eight
        expect(events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(await repo.verifyChainFor(envelopeId)).toEqual({ ok: true, length: 9 });
    });

    it('notices when a stored entry is edited afterwards', async () => {
        const { envelopeId } = await makeEnvelope();
        await repo.appendEvent(envelopeId, { type: 'sent', actorType: 'system' }, (s) => `${envelopeId}:${s}`);
        await pglite.query(
            `UPDATE envelope_events SET canonical = replace(canonical, '"sent"', '"paid"') WHERE envelope_id = $1 AND seq = 2`,
            [envelopeId],
        );
        const verdict = await repo.verifyChainFor(envelopeId);
        expect(verdict.ok).toBe(false);
        expect(verdict).toMatchObject({ brokenAtSeq: 2 });
    });
});

describe('signing', () => {
    it('absorbs a replayed signature instead of signing twice', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const recipientId = await addRecipient(envelopeId, 'signer');

        const first = await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId, typedName: 'Dave Ellis' });
        const replay = await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId, typedName: 'Dave Ellis' });

        expect(first.created).toBe(true);
        expect(replay.created).toBe(false);
        expect(replay.signatureId).toBe(first.signatureId);

        const rows = await pglite.query('SELECT * FROM envelope_signatures WHERE version_id = $1', [versionId]);
        expect(rows.rows).toHaveLength(1);
    });

    it('refuses to let a reviewer sign', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const reviewerId = await addRecipient(envelopeId, 'reviewer');
        await expect(repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: reviewerId }))
            .rejects.toThrow(/reviewer cannot sign/);
    });

    it('refuses to assign a field to a reviewer', async () => {
        const { envelopeId } = await makeEnvelope();
        const reviewerId = await addRecipient(envelopeId, 'reviewer');
        const signerId = await addRecipient(envelopeId, 'signer');
        await expect(repo.assertFieldAssignable(reviewerId)).rejects.toThrow(/cannot be assigned a field/);
        await expect(repo.assertFieldAssignable(signerId)).resolves.toBeUndefined();
    });

    it('voids signatures on a superseded version without destroying them', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const recipientId = await addRecipient(envelopeId, 'signer');
        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId, typedName: 'Dave Ellis' });

        const voided = await repo.voidSignaturesForVersion(versionId, 'clause 5 changed after legal review');
        expect(voided).toBe(1);

        const rows = await pglite.query('SELECT * FROM envelope_signatures WHERE version_id = $1', [versionId]);
        expect(rows.rows).toHaveLength(1);
        expect((rows.rows[0] as any).voided_at).toBeTruthy();
        expect((rows.rows[0] as any).typed_name).toBe('Dave Ellis');

        // Voiding twice does not double-count.
        expect(await repo.voidSignaturesForVersion(versionId, 'again')).toBe(0);
    });
});

describe('completion', () => {
    it('counts only signers who still owe a signature on this version', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const a = await addRecipient(envelopeId, 'signer');
        const b = await addRecipient(envelopeId, 'signer');
        await addRecipient(envelopeId, 'reviewer');   // never owes a signature
        await addRecipient(envelopeId, 'viewer');     // nor does a viewer

        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(2);

        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: a, typedName: 'A' });
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(1);

        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: b, typedName: 'B' });
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(0);
    });

    it('treats a voided signature as not given, so a new version is outstanding again', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const a = await addRecipient(envelopeId, 'signer');
        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: a, typedName: 'A' });
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(0);

        await repo.voidSignaturesForVersion(versionId, 'clause 5 changed');
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(1);
    });

    it('does not wait on a signer whose link was revoked', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const a = await addRecipient(envelopeId, 'signer');
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(1);
        await repo.revokeRecipient(envelopeId, a, 'removed from the document');
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(0);
    });

    it('completes once, and the loser is told it did not win', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const a = await addRecipient(envelopeId, 'signer');
        const b = await addRecipient(envelopeId, 'signer');

        // Still owed, so nothing flips and the caller learns what is missing.
        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: a, typedName: 'A' });
        expect(await repo.completeOnce(envelopeId, versionId)).toEqual({ completed: false, outstanding: 1 });
        expect((await repo.get(envelopeId))?.status).toBe('draft');

        await repo.recordSignature({ signatureId: id('sig'), versionId, recipientId: b, typedName: 'B' });

        // Two final signers arriving together. Exactly one flips it, so the
        // completion entry and the completion email happen once.
        const both = await Promise.all([
            repo.completeOnce(envelopeId, versionId),
            repo.completeOnce(envelopeId, versionId),
        ]);
        expect(both.filter((r) => r.completed)).toHaveLength(1);
        expect((await repo.get(envelopeId))?.status).toBe('completed');
        expect((await repo.get(envelopeId) as any)?.completedAt).toBeTruthy();

        // And a replay long afterwards is still a no-op, not a second completion.
        expect((await repo.completeOnce(envelopeId, versionId)).completed).toBe(false);
    });

    it('does not complete a document nobody has signed', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        await addRecipient(envelopeId, 'signer');
        expect(await repo.completeOnce(envelopeId, versionId)).toEqual({ completed: false, outstanding: 1 });
        expect((await repo.get(envelopeId))?.status).toBe('draft');
    });

    it('lists versions in order', async () => {
        const { envelopeId } = await makeEnvelope();
        const versions = await repo.listVersions(envelopeId);
        expect(versions).toHaveLength(1);
        expect((versions[0] as any).versionNo).toBe(1);
    });
});

describe('the token', () => {
    it('resolves a live token and refuses a revoked or expired one', async () => {
        const { envelopeId } = await makeEnvelope();
        const live = await addRecipient(envelopeId, 'signer', { tokenHash: 'hash_live', expiresAt: '2099-01-01T00:00:00.000Z' });
        await addRecipient(envelopeId, 'signer', { tokenHash: 'hash_revoked', revokedAt: '2026-09-01T00:00:00.000Z' });
        await addRecipient(envelopeId, 'signer', { tokenHash: 'hash_expired', expiresAt: '2020-01-01T00:00:00.000Z' });

        expect((await repo.resolveByTokenHash('hash_live'))?.recipientId).toBe(live);
        expect(await repo.resolveByTokenHash('hash_revoked')).toBeNull();
        expect(await repo.resolveByTokenHash('hash_expired')).toBeNull();
        expect(await repo.resolveByTokenHash('hash_unknown')).toBeNull();
    });
});

describe('recipients and delivery', () => {
    it('adds recipients idempotently and lists them in order', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        expect((await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com', orderNo: 1 })).created).toBe(true);
        expect((await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com', orderNo: 1 })).created).toBe(false);
        await repo.addRecipient({ recipientId: id('rcp'), envelopeId, role: 'reviewer', email: 'r@x.com', orderNo: 0 });

        const list = await repo.listRecipients(envelopeId);
        expect(list).toHaveLength(2);
        expect((list[0] as any).role).toBe('reviewer'); // orderNo 0 first
    });

    it('captures the message id at send, which is what a bounce is matched on', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.markDispatched({ recipientId: rid, tokenHash: 'th_1', sesMessageId: 'msg-1', expiresAt: '2099-01-01T00:00:00.000Z' });

        const r = await repo.getRecipient(rid);
        expect(r.status).toBe('dispatched');
        expect(r.sesMessageId).toBe('msg-1');
        expect(r.dispatchedAt).toBeTruthy();
        expect((await repo.resolveByTokenHash('th_1'))?.recipientId).toBe(rid);
    });

    it('correlates a bounce back to the recipient and only once', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.markDispatched({ recipientId: rid, tokenHash: id('th'), sesMessageId: 'msg-bounce' });

        const first = await repo.markBouncedByMessageId('msg-bounce', 'Permanent', 'mailbox does not exist');
        expect(first).toHaveLength(1);
        expect(first[0].recipientId).toBe(rid);
        expect((await repo.getRecipient(rid)).status).toBe('bounced');

        // SNS redelivers; a second notification must not re-fire anything.
        expect(await repo.markBouncedByMessageId('msg-bounce', 'Permanent', 'again')).toHaveLength(0);
        expect(await repo.markBouncedByMessageId('msg-unknown', 'Permanent', 'x')).toHaveLength(0);
    });

    it('records the first open only', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        expect((await repo.markOpened(rid)).firstOpen).toBe(true);
        expect((await repo.markOpened(rid)).firstOpen).toBe(false);
    });

    it('takes a verdict from a reviewer, once, and refuses one from a signer', async () => {
        const { envelopeId } = await makeEnvelope();
        const reviewerId = await addRecipient(envelopeId, 'reviewer');
        const signerId = await addRecipient(envelopeId, 'signer');

        expect((await repo.recordVerdict(reviewerId, 'changes_proposed', 'clause 5')).recorded).toBe(true);
        expect((await repo.recordVerdict(reviewerId, 'approved')).recorded).toBe(false);
        await expect(repo.recordVerdict(signerId, 'approved')).rejects.toThrow(/cannot return a verdict/);
    });

    it('revokes a link so it stops resolving', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'reviewer', email: 'r@x.com' });
        await repo.markDispatched({ recipientId: rid, tokenHash: 'th_revoke' });
        expect(await repo.resolveByTokenHash('th_revoke')).toBeTruthy();

        expect(await repo.revokeRecipient(envelopeId, rid, 'verdict returned')).toEqual({ revoked: true });
        expect(await repo.resolveByTokenHash('th_revoke')).toBeNull();
    });

    it('will not revoke a link belonging to another document', async () => {
        // The handler checks the ENVELOPE against the acting org and then hands
        // over a recipient id off the path, so scoping by recipient alone let
        // one org kill another org's link by naming it.
        const mine = await makeEnvelope();
        const theirs = await otherOrgEnvelope();
        const victim = id('rcp');
        await repo.addRecipient({ recipientId: victim, envelopeId: theirs.envelopeId, role: 'signer', email: 'them@x.com' });
        await repo.markDispatched({ recipientId: victim, tokenHash: 'th_other_org' });

        expect(await repo.revokeRecipient(mine.envelopeId, victim, 'nice try')).toEqual({ revoked: false });
        expect((await repo.resolveByTokenHash('th_other_org'))?.recipientId).toBe(victim);
        expect((await repo.getRecipient(victim)).revokedAt).toBeNull();

        // And the owner of the document can still revoke it.
        expect(await repo.revokeRecipient(theirs.envelopeId, victim, 'sender revoked')).toEqual({ revoked: true });
        expect(await repo.resolveByTokenHash('th_other_org')).toBeNull();
    });

    it('claims the dispatch before the email and rolls it back if the send is refused', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.markDispatched({ recipientId: rid, tokenHash: 'th_live', expiresAt: '2099-01-01T00:00:00.000Z', sesMessageId: 'msg-live' });

        // A resend claims a new credential and gets the old one back.
        const claim = await repo.markDispatched({ recipientId: rid, tokenHash: 'th_resend', expiresAt: '2099-06-01T00:00:00.000Z' });
        expect(claim.claimed).toBe(true);
        expect(claim.previous?.tokenHash).toBe('th_live');
        expect(await repo.resolveByTokenHash('th_live')).toBeNull();

        // The send is refused, so the link already delivered has to come back.
        expect(await repo.rollbackDispatch(rid, 'th_resend', claim.previous)).toEqual({ restored: true });
        expect((await repo.resolveByTokenHash('th_live'))?.recipientId).toBe(rid);
        expect(await repo.resolveByTokenHash('th_resend')).toBeNull();
        const back = await repo.getRecipient(rid);
        expect(back.sesMessageId).toBe('msg-live');
        expect(back.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    });

    it('leaves a recipient exactly as it found them when a first send is refused', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });

        const claim = await repo.markDispatched({ recipientId: rid, tokenHash: 'th_never_sent' });
        await repo.rollbackDispatch(rid, 'th_never_sent', claim.previous);

        const after = await repo.getRecipient(rid);
        expect(after.status).toBe('pending');
        expect(after.tokenHash).toBeNull();
        expect(after.dispatchedAt).toBeNull();
        expect(await repo.resolveByTokenHash('th_never_sent')).toBeNull();
    });

    it('will not roll back over a newer claim', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.markDispatched({ recipientId: rid, tokenHash: 'th_first' });
        const stale = await repo.markDispatched({ recipientId: rid, tokenHash: 'th_second' });
        await repo.markDispatched({ recipientId: rid, tokenHash: 'th_third' });

        // The second send failed, but a third has since gone out. Restoring the
        // second's snapshot would break the link that actually reached someone.
        expect(await repo.rollbackDispatch(rid, 'th_second', stale.previous)).toEqual({ restored: false });
        expect((await repo.resolveByTokenHash('th_third'))?.recipientId).toBe(rid);
    });

    it('keeps the existing link when a dispatch does not issue a new one', async () => {
        // Recording the message id after the send must not re-mint the token:
        // the hash is the only copy of the link, so overwriting it would kill
        // the email that just went out.
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.markDispatched({
            recipientId: rid, tokenHash: 'th_keep', expiresAt: '2099-01-01T00:00:00.000Z',
            accessCodeHash: 'ach', accessCodeSalt: 'salt', accessCodeChannel: 'spoken',
        });

        await repo.markDispatched({ recipientId: rid, sesMessageId: 'msg-after-send' });

        const r = await repo.getRecipient(rid);
        expect(r.tokenHash).toBe('th_keep');
        expect(r.expiresAt).toBe('2099-01-01T00:00:00.000Z');
        expect(r.accessCodeHash).toBe('ach');
        expect(r.accessCodeChannel).toBe('spoken');
        expect(r.sesMessageId).toBe('msg-after-send');
        expect((await repo.resolveByTokenHash('th_keep'))?.recipientId).toBe(rid);
    });

    it('refuses to dispatch a revoked link', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        await repo.revokeRecipient(envelopeId, rid, 'the sender revoked this link');

        const claim = await repo.markDispatched({ recipientId: rid, tokenHash: 'th_after_revoke' });
        expect(claim.claimed).toBe(false);
        expect(await repo.resolveByTokenHash('th_after_revoke')).toBeNull();
        expect((await repo.getRecipient(rid)).status).toBe('revoked');
    });

    it('counts wrong codes atomically and locks out', async () => {
        const { envelopeId } = await makeEnvelope();
        const rid = id('rcp');
        await repo.addRecipient({ recipientId: rid, envelopeId, role: 'signer', email: 'a@x.com' });
        const until = '2099-01-01T00:00:00.000Z';

        // Parallel guesses must each be counted, not collapse into one.
        const results = await Promise.all(Array.from({ length: 5 }, () => repo.registerFailedCodeAttempt(rid, 5, until)));
        expect((await repo.getRecipient(rid)).failedAttempts).toBe(5);
        expect(results.some(r => r.locked)).toBe(true);
        expect((await repo.getRecipient(rid)).lockedUntil).toBe(until);

        await repo.clearFailedCodeAttempts(rid);
        const cleared = await repo.getRecipient(rid);
        expect(cleared.failedAttempts).toBe(0);
        expect(cleared.lockedUntil).toBeNull();
    });
});

describe('authoring', () => {
    it('places a field on a signer and refuses one on a reviewer', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const signerId = await addRecipient(envelopeId, 'signer');
        const reviewerId = await addRecipient(envelopeId, 'reviewer');

        const f = await repo.addField({ fieldId: id('fld'), versionId, recipientId: signerId, type: 'signature', page: 1, x: 8, y: 70, w: 34, h: 9 });
        expect(f.created).toBe(true);
        await expect(repo.addField({ fieldId: id('fld'), versionId, recipientId: reviewerId, type: 'signature', page: 1, x: 8, y: 83, w: 34, h: 9 }))
            .rejects.toThrow(/cannot be assigned a field/);

        expect(await repo.listFields(versionId)).toHaveLength(1);
    });

    it('is retry-safe on the field id, and can remove one', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const signerId = await addRecipient(envelopeId, 'signer');
        const fieldId = id('fld');
        const args = { fieldId, versionId, recipientId: signerId, type: 'date' as const, page: 1, x: 1, y: 2, w: 3, h: 4 };
        expect((await repo.addField(args)).created).toBe(true);
        expect((await repo.addField(args)).created).toBe(false);
        expect(await repo.removeField(envelopeId, fieldId)).toEqual({ removed: true });
        expect(await repo.listFields(versionId)).toHaveLength(0);
    });

    it('will not remove a field from another document', async () => {
        // A field hangs off a version, so the only way to prove which document
        // it is on is to reach the envelope through envelope_versions. Deleting
        // by field id alone let a caller who owned one document delete a field
        // on somebody else's.
        const mine = await makeEnvelope();
        const theirs = await otherOrgEnvelope();
        const signerId = await addRecipient(theirs.envelopeId, 'signer');
        const fieldId = id('fld');
        await repo.addField({ fieldId, versionId: theirs.versionId, recipientId: signerId, type: 'signature', page: 1, x: 1, y: 2, w: 3, h: 4 });

        expect(await repo.removeField(mine.envelopeId, fieldId)).toEqual({ removed: false });
        expect(await repo.listFields(theirs.versionId)).toHaveLength(1);

        expect(await repo.removeField(theirs.envelopeId, fieldId)).toEqual({ removed: true });
        expect(await repo.listFields(theirs.versionId)).toHaveLength(0);
    });

    it('supersedes the current version and moves the envelope onto it', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const v2 = await repo.createVersion({ versionId: id('ver'), envelopeId, createdBy: 'user_1', bodyMarkdown: '## v2' });

        expect(v2.versionNo).toBe(2);
        expect((await repo.get(envelopeId))?.currentVersionNo).toBe(2);

        const versions = await repo.listVersions(envelopeId);
        expect(versions).toHaveLength(2);
        expect((versions[0] as any).versionId).toBe(versionId);
        expect((versions[0] as any).supersededAt).toBeTruthy();
        expect((versions[1] as any).supersededAt).toBeNull();
    });

    it('records reviewer comments individually and resolves one at a time', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const reviewerId = await addRecipient(envelopeId, 'reviewer');
        const c1 = id('cmt');
        await repo.addComment({ commentId: c1, envelopeId, versionId, recipientId: reviewerId, authorLabel: 'Ruth', body: 'Clause 5 is too long', page: 1, x: 20, y: 40, proposedText: 'thirty (30) days' });
        await repo.addComment({ commentId: id('cmt'), envelopeId, versionId, authorLabel: 'Ruth', body: 'Second point' });

        expect(await repo.listComments(versionId)).toHaveLength(2);
        await repo.resolveComment(c1);
        const after = await repo.listComments(versionId);
        expect((after.find((c: any) => c.commentId === c1) as any).resolvedAt).toBeTruthy();
        expect((after.find((c: any) => c.commentId !== c1) as any).resolvedAt).toBeNull();
    });
});

describe('reusable documents', () => {
    it('creates a template and lists it, retry-safe on the id', async () => {
        const templateId = id('tpl');
        const args = {
            templateId, orgId: 'org_1', createdBy: 'user_1', name: 'Standard roofing proposal',
            kind: 'proposal', bodyMarkdown: '## Proposal\n\n{{sig:counterparty}} {{date:counterparty}}',
        };
        expect((await repo.createTemplate(args)).created).toBe(true);
        expect((await repo.createTemplate(args)).created).toBe(false);

        const list = await repo.listTemplates('org_1');
        expect(list.map((t: any) => t.templateId)).toContain(templateId);
        expect((await repo.getTemplate(templateId)).timesUsed).toBe(0);
    });

    it('refuses a template for a kind that is not handled here', async () => {
        await expect(repo.createTemplate({
            templateId: id('tpl'), orgId: 'org_1', createdBy: 'user_1',
            name: 'Employment', kind: 'employment',
        })).rejects.toThrow(/not handled here/);
    });

    it('makes a document from a template and counts the use', async () => {
        const templateId = id('tpl');
        await repo.createTemplate({
            templateId, orgId: 'org_1', createdBy: 'user_1', name: 'NDA',
            kind: 'nda', bodyMarkdown: '## NDA {{sig:counterparty}}',
        });

        const made = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId,
            orgId: 'org_1', createdBy: 'user_1', title: 'NDA for Ellis',
        });

        expect(made.title).toBe('NDA for Ellis');
        expect(made.kind).toBe('nda');
        expect(made.tier).toBe(1);
        expect((await repo.getTemplate(templateId)).timesUsed).toBe(1);

        const versions = await repo.listVersions(made.envelopeId);
        expect((versions[0] as any).bodyMarkdown).toBe('## NDA {{sig:counterparty}}');
    });

    it('copies the wording rather than referencing it, so a later edit cannot change what was sent', async () => {
        const templateId = id('tpl');
        await repo.createTemplate({
            templateId, orgId: 'org_1', createdBy: 'user_1', name: 'Terms',
            kind: 'proposal', bodyMarkdown: 'original wording',
        });
        const made = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'user_1',
        });

        await pglite.query("UPDATE envelope_templates SET body_markdown = 'edited later' WHERE template_id = $1", [templateId]);

        const versions = await repo.listVersions(made.envelopeId);
        expect((versions[0] as any).bodyMarkdown).toBe('original wording');
    });

    it('will not use another org template', async () => {
        const templateId = id('tpl');
        await repo.createTemplate({ templateId, orgId: 'org_1', createdBy: 'u', name: 'Mine', kind: 'proposal', bodyMarkdown: 'x' });
        await expect(repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_OTHER', createdBy: 'u',
        })).rejects.toThrow(/No such template/);
    });

    it('archives rather than deletes, so a sent document still names it', async () => {
        const templateId = id('tpl');
        await repo.createTemplate({ templateId, orgId: 'org_1', createdBy: 'u', name: 'Old', kind: 'proposal', bodyMarkdown: 'x' });
        await repo.archiveTemplate(templateId);

        expect((await repo.listTemplates('org_1')).map((t: any) => t.templateId)).not.toContain(templateId);
        expect((await repo.listTemplates('org_1', true)).map((t: any) => t.templateId)).toContain(templateId);
        expect(await repo.getTemplate(templateId)).toBeTruthy();
    });
});

describe('roles, and sending a prepared template again', () => {
    async function prepared() {
        const templateId = id('tpl');
        await repo.createTemplate({
            templateId, orgId: 'org_1', createdBy: 'user_1', name: 'Subcontractor agreement',
            kind: 'subcontractor_agreement', bodyMarkdown: '## Agreement for {{counterparty.name}}',
        });
        await repo.addTemplateRole({ templateRoleId: id('rol'), templateId, roleKey: 'counterparty', label: 'Counterparty', signingRole: 'signer', orderNo: 0 });
        await repo.addTemplateRole({ templateRoleId: id('rol'), templateId, roleKey: 'us', label: 'Us', signingRole: 'signer', orderNo: 1 });
        await repo.addTemplateRole({ templateRoleId: id('rol'), templateId, roleKey: 'lawyer', label: 'Our lawyer', signingRole: 'reviewer', required: false });
        await repo.addTemplateField({ templateFieldId: id('tf'), templateId, roleKey: 'counterparty', type: 'signature', page: 1, x: 8, y: 70, w: 34, h: 8 });
        await repo.addTemplateField({ templateFieldId: id('tf'), templateId, roleKey: 'counterparty', type: 'date', page: 1, x: 46, y: 70, w: 20, h: 8 });
        await repo.addTemplateField({ templateFieldId: id('tf'), templateId, roleKey: 'us', type: 'signature', page: 1, x: 8, y: 84, w: 34, h: 8 });
        return templateId;
    }

    it('places template fields against roles, never people', async () => {
        const templateId = await prepared();
        const fields = await repo.listTemplateFields(templateId);
        expect(fields).toHaveLength(3);
        expect(new Set(fields.map((f: any) => f.roleKey))).toEqual(new Set(['counterparty', 'us']));
        expect(fields.every((f: any) => !('recipientId' in f))).toBe(true);
    });

    it('refuses a field on a role that cannot hold one', async () => {
        const templateId = await prepared();
        await expect(repo.addTemplateField({
            templateFieldId: id('tf'), templateId, roleKey: 'lawyer', type: 'signature', page: 1, x: 1, y: 1, w: 5, h: 5,
        })).rejects.toThrow(/cannot be assigned a field/);
    });

    it('refuses a field for a role nobody defined', async () => {
        const templateId = await prepared();
        await expect(repo.addTemplateField({
            templateFieldId: id('tf'), templateId, roleKey: 'ghost', type: 'date', page: 1, x: 1, y: 1, w: 5, h: 5,
        })).rejects.toThrow(/no role called/);
    });

    it('fills the roles with people and re-points the fields at them', async () => {
        const templateId = await prepared();
        const dave = id('rcp'); const owner = id('rcp');
        const made = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'user_1',
            title: 'Agreement with Ellis',
            roleAssignments: [
                { roleKey: 'counterparty', recipientId: dave, email: 'dave@ellis.com', name: 'Dave Ellis' },
                { roleKey: 'us', recipientId: owner, email: 'leon@halvorsen.com', name: 'Leon' },
            ],
        });

        const recipients = await repo.listRecipients(made.envelopeId);
        expect(recipients).toHaveLength(2);
        expect((recipients as any[]).find((r) => r.recipientId === dave).roleKey).toBe('counterparty');

        const versions = await repo.listVersions(made.envelopeId);
        const fields = await repo.listFields((versions[0] as any).versionId) as any[];
        expect(fields).toHaveLength(3);
        expect(fields.filter((f) => f.recipientId === dave)).toHaveLength(2);
        expect(fields.filter((f) => f.recipientId === owner)).toHaveLength(1);
    });

    it('sends the same prepared template again to somebody else', async () => {
        const templateId = await prepared();
        const first = id('rcp'); const second = id('rcp'); const ownerA = id('rcp'); const ownerB = id('rcp');

        const a = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'u',
            roleAssignments: [
                { roleKey: 'counterparty', recipientId: first, email: 'one@x.com' },
                { roleKey: 'us', recipientId: ownerA, email: 'leon@x.com' },
            ],
        });
        const b = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'u',
            roleAssignments: [
                { roleKey: 'counterparty', recipientId: second, email: 'two@x.com' },
                { roleKey: 'us', recipientId: ownerB, email: 'leon@x.com' },
            ],
        });

        // Two separate documents, each with its own people and its own fields,
        // and nothing was re-placed by hand.
        expect(a.envelopeId).not.toBe(b.envelopeId);
        for (const [env, who] of [[a, first], [b, second]] as const) {
            const v = await repo.listVersions(env.envelopeId);
            const f = await repo.listFields((v[0] as any).versionId) as any[];
            expect(f.filter((x) => x.recipientId === who)).toHaveLength(2);
        }
        expect((await repo.getTemplate(templateId)).timesUsed).toBe(2);
    });

    it('will not send with a required role left empty', async () => {
        const templateId = await prepared();
        await expect(repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'u',
            roleAssignments: [{ roleKey: 'counterparty', recipientId: id('rcp'), email: 'one@x.com' }],
        })).rejects.toThrow(/Nobody was given these roles: Us/);
    });

    it('refuses a role the template does not have', async () => {
        const templateId = await prepared();
        await expect(repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'u',
            roleAssignments: [{ roleKey: 'landlord', recipientId: id('rcp'), email: 'x@x.com' }],
        })).rejects.toThrow(/no role called "landlord"/);
    });

    it('leaves an optional role unfilled without leaving a field orphaned', async () => {
        const templateId = await prepared();
        const c = id('rcp');
        const made = await repo.createFromTemplate({
            envelopeId: id('env'), versionId: id('ver'), templateId, orgId: 'org_1', createdBy: 'u',
            roleAssignments: [
                { roleKey: 'counterparty', recipientId: c, email: 'one@x.com' },
                { roleKey: 'us', recipientId: id('rcp'), email: 'leon@x.com' },
            ],
        });
        // The lawyer role is optional and was not filled; no recipient, no field.
        expect(await repo.listRecipients(made.envelopeId)).toHaveLength(2);
    });
});

describe('the vault', () => {
    it('pages with a cursor rather than returning everything', async () => {
        const org = 'org_vault';
        await pglite.query("INSERT INTO orgs (org_id, name) VALUES ($1, 'Vault') ON CONFLICT DO NOTHING", [org]);
        for (let i = 0; i < 5; i++) {
            await repo.create({ envelopeId: `venv_${i}`, orgId: org, createdBy: 'u', title: `Doc ${i}`, kind: 'proposal', versionId: `vver_${i}` });
        }

        const page1 = await repo.listEnvelopes({ orgId: org, limit: 2 });
        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).toBeTruthy();

        const page2 = await repo.listEnvelopes({ orgId: org, limit: 2, cursor: page1.nextCursor });
        expect(page2.items).toHaveLength(2);
        const seen = [...page1.items, ...page2.items].map((e: any) => e.envelopeId);
        expect(new Set(seen).size).toBe(4); // no overlap between pages

        const last = await repo.listEnvelopes({ orgId: org, limit: 2, cursor: page2.nextCursor });
        expect(last.items).toHaveLength(1);
        expect(last.nextCursor).toBeNull();
    });

    it('is scoped to the org and can filter by status', async () => {
        const org = 'org_vault';
        await repo.setEnvelopeStatus('venv_0', 'completed');
        const completed = await repo.listEnvelopes({ orgId: org, status: 'completed' });
        expect(completed.items.map((e: any) => e.envelopeId)).toEqual(['venv_0']);
        expect((await repo.listEnvelopes({ orgId: 'org_1', status: 'completed' })).items.every((e: any) => e.orgId === 'org_1')).toBe(true);
    });

    it('counts by status in one query', async () => {
        const counts = await repo.countByStatus('org_vault');
        expect(counts.completed).toBe(1);
        expect(counts.draft).toBe(4);
    });
});

describe('sealing', () => {
    it('seals once and reports the existing artifact afterwards', async () => {
        const { envelopeId, versionId } = await makeEnvelope();
        const first = await repo.sealOnce({
            artifactId: id('art'), envelopeId, versionId, kind: 'sealed',
            s3Key: 'documents/org_1/sealed/a.pdf', sha256: 'aaa', byteSize: 100,
        });
        const second = await repo.sealOnce({
            artifactId: id('art'), envelopeId, versionId, kind: 'sealed',
            s3Key: 'documents/org_1/sealed/b.pdf', sha256: 'bbb', byteSize: 200,
        });

        expect(first.sealed).toBe(true);
        expect(second.sealed).toBe(false);
        expect(second.existingS3Key).toBe('documents/org_1/sealed/a.pdf');

        const rows = await pglite.query("SELECT * FROM envelope_artifacts WHERE envelope_id = $1 AND kind = 'sealed'", [envelopeId]);
        expect(rows.rows).toHaveLength(1);
    });

    it('still allows a different artifact kind on the same envelope', async () => {
        const { envelopeId } = await makeEnvelope();
        expect((await repo.sealOnce({ artifactId: id('art'), envelopeId, kind: 'original', s3Key: 'o.pdf', sha256: 'o', byteSize: 1 })).sealed).toBe(true);
        expect((await repo.sealOnce({ artifactId: id('art'), envelopeId, kind: 'certificate', s3Key: 'c.pdf', sha256: 'c', byteSize: 1 })).sealed).toBe(true);
    });

    it('finalises the claim, so the sealed bytes can be found afterwards', async () => {
        // The slot is claimed with a placeholder key before the PDF exists.
        // Without the finalise the row keeps that placeholder, and a seal that
        // succeeded end to end still leaves nothing anyone can fetch.
        const { envelopeId, versionId } = await makeEnvelope();
        await repo.sealOnce({ artifactId: id('art'), envelopeId, versionId, kind: 'sealed', s3Key: 'pending', sha256: 'pending', byteSize: 0 });

        expect(await repo.getArtifact(envelopeId, 'sealed')).toBeNull();
        expect((await repo.getArtifact(envelopeId, 'sealed', { includeUnfinalised: true }))?.s3Key).toBe('pending');

        expect(await repo.finaliseArtifact(envelopeId, 'sealed', {
            s3Key: 'documents/org_1/sealed/x.pdf', sha256: 'deadbeef', byteSize: 4096,
        })).toEqual({ finalised: true });

        const art = await repo.getArtifact(envelopeId, 'sealed');
        expect(art.s3Key).toBe('documents/org_1/sealed/x.pdf');
        expect(art.sha256).toBe('deadbeef');
        expect(art.byteSize).toBe(4096);
        expect((await repo.listArtifacts(envelopeId)).map((a: any) => a.kind)).toEqual(['sealed']);
    });

    it('absorbs a repeated finalise and refuses a different one', async () => {
        const { envelopeId } = await makeEnvelope();
        await repo.sealOnce({ artifactId: id('art'), envelopeId, kind: 'sealed', s3Key: 'pending', sha256: 'pending', byteSize: 0 });
        const bytes = { s3Key: 'sealed/a.pdf', sha256: 'aaa', byteSize: 10 };

        expect((await repo.finaliseArtifact(envelopeId, 'sealed', bytes)).finalised).toBe(true);
        // The same bytes again is a retry, not a second seal.
        expect((await repo.finaliseArtifact(envelopeId, 'sealed', bytes)).finalised).toBe(true);
        // Different bytes are a different document, and the chain attests to the first.
        expect((await repo.finaliseArtifact(envelopeId, 'sealed', { s3Key: 'sealed/b.pdf', sha256: 'bbb', byteSize: 20 })).finalised).toBe(false);
        expect((await repo.getArtifact(envelopeId, 'sealed')).s3Key).toBe('sealed/a.pdf');

        await expect(repo.finaliseArtifact(envelopeId, 'sealed', { s3Key: 'sealed/c.pdf', sha256: 'ccc', byteSize: 0 }))
            .rejects.toThrow(/no bytes/);
    });

    it('lets a seal that never produced any bytes be tried again', async () => {
        // A throw between claiming the slot and uploading used to block every
        // retry for ever: the slot was taken, so the document could never be
        // sealed at all.
        const { envelopeId } = await makeEnvelope();
        const claim = { artifactId: id('art'), envelopeId, kind: 'sealed' as const, s3Key: 'pending', sha256: 'pending', byteSize: 0 };
        expect(await repo.sealOnce(claim)).toEqual({ sealed: true });

        const retry = await repo.sealOnce({ ...claim, artifactId: id('art') });
        expect(retry).toEqual({ sealed: true, resumed: true });

        await repo.finaliseArtifact(envelopeId, 'sealed', { s3Key: 'sealed/done.pdf', sha256: 'done', byteSize: 99 });

        // Once there are bytes behind it, the slot is closed again.
        const after = await repo.sealOnce({ ...claim, artifactId: id('art') });
        expect(after.sealed).toBe(false);
        expect(after.existingS3Key).toBe('sealed/done.pdf');
    });
});
