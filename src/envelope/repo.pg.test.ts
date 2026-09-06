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

async function makeEnvelope(kind = 'proposal') {
    const envelopeId = id('env');
    const versionId = id('ver');
    await repo.create({
        envelopeId, orgId: 'org_1', createdBy: 'user_1', createdByLabel: 'Leon',
        title: 'Roof replacement', kind, versionId,
    });
    return { envelopeId, versionId };
}

beforeAll(async () => {
    pglite = new PGlite({ extensions: { pg_trgm } });
    const executor: SqlExecutor = { exec: async (s: string) => ({ rows: (await pglite.query(s)).rows as any[] }) };
    await runMigrations(executor);
    db = drizzle(pglite) as unknown as PgDb;
    await pglite.query("INSERT INTO orgs (org_id, name) VALUES ('org_1', 'Acme')");
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
        await repo.revokeRecipient(a, 'removed from the document');
        expect(await repo.countOutstandingSigners(envelopeId, versionId)).toBe(0);
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

        await repo.revokeRecipient(rid, 'verdict returned');
        expect(await repo.resolveByTokenHash('th_revoke')).toBeNull();
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
        await repo.removeField(fieldId);
        expect(await repo.listFields(versionId)).toHaveLength(0);
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
});
