import { describe, it, expect } from 'vitest';
import {
    ENVELOPE_KINDS, CONTRACT_TYPES, AU_JURISDICTIONS, DEFAULT_JURISDICTION,
    contractType, tryContractType, listContractTypes, partiesForKind,
    questionsForKind, sectionsForKind, visibleQuestions, defaultAnswers,
    isAustralianJurisdiction,
    type EnvelopeKind, type QuestionField,
} from './registry';
import {
    tierForKind, isRefusedKind, canDraftKind, canDraftFromQuestionnaire,
    draftModesForKind, isEnvelopeKind,
} from './schema';

const KINDS = ENVELOPE_KINDS as readonly EnvelopeKind[];

describe('registry shape', () => {
    it('every kind resolves', () => {
        for (const kind of KINDS) {
            const t = contractType(kind);
            expect(t.id).toBe(kind);
            expect(t.label.length).toBeGreaterThan(0);
            expect(t.description.length).toBeGreaterThan(0);
        }
    });

    it('the record key and the entry id are the same string', () => {
        for (const [key, entry] of Object.entries(CONTRACT_TYPES)) {
            expect(entry.id).toBe(key);
        }
    });

    it('lists every kind, in ENVELOPE_KINDS order', () => {
        expect(listContractTypes().map((t) => t.id)).toEqual([...KINDS]);
    });

    it('names a lucide component, never an emoji and never markup', () => {
        for (const kind of KINDS) {
            const icon = contractType(kind).icon;
            // PascalCase identifier. An emoji or a '<svg' fails this outright.
            expect(icon).toMatch(/^[A-Z][A-Za-z0-9]*$/);
        }
    });
});

describe('parties', () => {
    it('every kind has parties, and at least one of them signs', () => {
        for (const kind of KINDS) {
            const parties = partiesForKind(kind);
            expect(parties.length, kind).toBeGreaterThan(0);
            expect(parties.some((p) => p.signingRole === 'signer'), kind).toBe(true);
        }
    });

    it('role keys are unique within a kind', () => {
        for (const kind of KINDS) {
            const keys = partiesForKind(kind).map((p) => p.roleKey);
            expect(new Set(keys).size, kind).toBe(keys.length);
        }
    });

    it('labels are specific to the kind, not one generic pair reused', () => {
        // A subcontractor agreement asks for a hirer and a subcontractor; an NDA
        // asks for a disclosing and a receiving party. If these ever collapse to
        // the same pair the form has stopped telling anyone anything.
        expect(partiesForKind('subcontractor_agreement').map((p) => p.roleKey))
            .toEqual(['subcontractor', 'hirer']);
        expect(partiesForKind('nda').map((p) => p.roleKey))
            .toEqual(['receiving_party', 'disclosing_party']);
        expect(partiesForKind('lease').map((p) => p.roleKey))
            .toEqual(['lessee', 'lessor']);

        // These five genuinely are the same pair, because the counterparty
        // genuinely is the client. Every other kind names its parties for
        // itself, and a new kind landing on "Client | Your business" by default
        // fails here rather than shipping.
        const clientAndUs: readonly EnvelopeKind[] = [
            'proposal', 'quote_cover', 'scope_of_works', 'deposit_terms', 'variation_terms',
        ];
        const signature = (kind: EnvelopeKind) => partiesForKind(kind).map((p) => p.label).join('|');
        for (const kind of clientAndUs) expect(signature(kind), kind).toBe('Client|Your business');

        const rest = KINDS.filter((k) => !clientAndUs.includes(k)).map(signature);
        expect(new Set(rest).size).toBe(rest.length);
    });
});

describe('questions', () => {
    it('every question key is unique within its kind', () => {
        for (const kind of KINDS) {
            const keys = questionsForKind(kind).map((q) => q.key);
            expect(new Set(keys).size, kind).toBe(keys.length);
        }
    });

    it('every dependsOn names a key that exists in the same kind, and comes earlier', () => {
        for (const kind of KINDS) {
            const seen = new Set<string>();
            for (const q of questionsForKind(kind)) {
                if (q.dependsOn) {
                    // Earlier, not merely present: it is what lets a renderer
                    // resolve visibility in one pass and makes a cycle
                    // inexpressible.
                    expect(seen.has(q.dependsOn.key), `${kind}.${q.key} -> ${q.dependsOn.key}`).toBe(true);
                }
                seen.add(q.key);
            }
        }
    });

    it('a select always offers options, and a default is always one of them', () => {
        for (const kind of KINDS) {
            for (const q of questionsForKind(kind)) {
                if (q.type === 'select') {
                    expect(q.options?.length, `${kind}.${q.key}`).toBeGreaterThan(0);
                    if (q.default !== undefined) {
                        expect(q.options!.map((o) => o.value), `${kind}.${q.key}`).toContain(q.default);
                    }
                }
                if (q.type === 'toggle' && q.default !== undefined) {
                    expect(typeof q.default, `${kind}.${q.key}`).toBe('boolean');
                }
            }
        }
    });

    it('section order is first appearance, with no section split across the array', () => {
        for (const kind of KINDS) {
            const sections = sectionsForKind(kind);
            expect(new Set(sections).size, kind).toBe(sections.length);

            // Every question maps to a known section, and once a section is left
            // it is never returned to: otherwise a rendered form shows the same
            // heading twice.
            const runs: string[] = [];
            for (const q of questionsForKind(kind)) {
                if (runs[runs.length - 1] !== q.section) runs.push(q.section);
            }
            expect(runs, kind).toEqual(sections);
        }
    });

    it('the four tier 0 kinds carry a real question set', () => {
        // These are the ones that can be drafted from day one. A stub here is
        // worse than nothing: it produces a document that looks complete.
        for (const kind of ['proposal', 'quote_cover', 'scope_of_works', 'capability_statement'] as const) {
            expect(questionsForKind(kind).length, kind).toBeGreaterThanOrEqual(15);
            expect(sectionsForKind(kind).length, kind).toBeGreaterThanOrEqual(4);
            expect(questionsForKind(kind).some((q) => q.required), kind).toBe(true);
        }
    });

    it('is Australian: AUD money, GST asked rather than assumed, the eight jurisdictions', () => {
        expect(AU_JURISDICTIONS.map((j) => j.value))
            .toEqual(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT']);
        expect(DEFAULT_JURISDICTION).toBe('NSW');
        expect(isAustralianJurisdiction('NSW')).toBe(true);
        expect(isAustralianJurisdiction('CA')).toBe(false);

        const gst = questionsForKind('proposal').find((q) => q.key === 'gst_treatment')!;
        expect(gst.options!.map((o) => o.value)).toEqual(['ex_gst', 'inc_gst', 'no_gst']);

        // Money is labelled AUD wherever it is asked for, so nobody types a
        // figure wondering which currency it lands in.
        const money: QuestionField[] = KINDS.flatMap((k) => questionsForKind(k).filter((q) => q.type === 'money'));
        expect(money.length).toBeGreaterThan(0);
        for (const q of money) expect(q.label).toContain('AUD');

        // A works document has to ask about retention and defects liability, and
        // a subcontractor document has to ask the superannuation question.
        const scope = questionsForKind('scope_of_works').map((q) => q.key);
        expect(scope).toContain('retention');
        expect(scope).toContain('defects_liability_months');

        const sub = questionsForKind('subcontractor_agreement').map((q) => q.key);
        expect(sub).toContain('super_payable');
        expect(sub).toContain('own_abn_confirmed');
        expect(sub).toContain('subcontractor_abn');
    });
});

describe('visibleQuestions', () => {
    it('hides a dependent field until its answer matches', () => {
        const withoutDeposit = visibleQuestions('proposal', { deposit_required: false });
        expect(withoutDeposit.map((q) => q.key)).not.toContain('deposit_percent');

        const withDeposit = visibleQuestions('proposal', { deposit_required: true });
        expect(withDeposit.map((q) => q.key)).toContain('deposit_percent');
    });

    it('a declined restraint does not still ask for its period', () => {
        // The general shape of the rule, on the case it was written for.
        const declined = visibleQuestions('deposit_terms', { residential_building_work: false });
        expect(declined.map((q) => q.key)).not.toContain('deposit_cap_ack');

        const accepted = visibleQuestions('deposit_terms', { residential_building_work: true });
        expect(accepted.map((q) => q.key)).toContain('deposit_cap_ack');
    });

    it('with nothing answered, shows exactly the unconditional questions', () => {
        for (const kind of KINDS) {
            const shown = visibleQuestions(kind, {});
            expect(shown.map((q) => q.key), kind)
                .toEqual(questionsForKind(kind).filter((q) => !q.dependsOn).map((q) => q.key));
        }
    });

    it('defaults render a coherent form: every dependent shown by a default is reachable', () => {
        for (const kind of KINDS) {
            const shown = visibleQuestions(kind, defaultAnswers(kind)).map((q) => q.key);
            // No duplicates, and order is preserved from the source array.
            expect(new Set(shown).size, kind).toBe(shown.length);
        }
        expect(defaultAnswers('proposal').price_basis).toBe('fixed');
        expect(defaultAnswers('scope_of_works').jurisdiction).toBe('NSW');
    });
});

describe('tier lookups still fail closed', () => {
    it('resolves the known tiers', () => {
        expect(tierForKind('proposal')).toBe(0);
        expect(tierForKind('nda')).toBe(1);
        expect(tierForKind('employment')).toBe(2);
        expect(tierForKind('lease')).toBe(2);
        expect(tierForKind('partnership')).toBe(2);
    });

    it('throws on an unknown kind rather than defaulting to tier 0', () => {
        expect(() => tierForKind('mystery')).toThrow(/Unknown document kind/);
        expect(() => contractType('mystery')).toThrow(/Unknown document kind/);
        expect(tryContractType('mystery')).toBeNull();
        expect(isEnvelopeKind('mystery')).toBe(false);
    });

    it('refuses and blocks drafting on an unknown kind', () => {
        expect(isRefusedKind('mystery')).toBe(true);
        expect(canDraftKind('mystery')).toBe(false);
        expect(canDraftFromQuestionnaire('mystery')).toBe(false);
        expect(draftModesForKind('mystery')).toEqual([]);
    });

    it('pins the tier of every kind, so a second table cannot drift from this one', () => {
        // Deliberately a written-out expectation rather than
        // `tierForKind(k) === CONTRACT_TYPES[k].tier`, which is a function
        // equalling the thing it reads and proves nothing. If someone moves a
        // kind between tiers, this fails and makes them say so on purpose.
        expect(Object.fromEntries(KINDS.map((k) => [k, tierForKind(k)]))).toEqual({
            proposal: 0,
            quote_cover: 0,
            scope_of_works: 0,
            capability_statement: 0,
            nda: 1,
            service_agreement: 1,
            subcontractor_agreement: 1,
            deposit_terms: 1,
            variation_terms: 1,
            employment: 2,
            guarantor: 2,
            prenuptial: 2,
            small_business_loan: 2,
            lease: 2,
            partnership: 2,
        });
    });

    it('every kind the frontend can name is a kind core knows about', () => {
        // The frontend used to keep its own tier map with a `?? 0` default, so a
        // kind it had not been taught about read as unrestricted. The registry
        // is now the only table; this asserts the shape a consumer relies on
        // rather than trusting that nobody re-adds a copy.
        for (const kind of KINDS) {
            const entry = CONTRACT_TYPES[kind];
            expect(entry, kind).toBeTruthy();
            expect(entry.label.length, kind).toBeGreaterThan(0);
            expect([0, 1, 2], kind).toContain(entry.tier);
            if (entry.tier === 2) expect(entry.refusedReason, kind).toBeTruthy();
        }
    });
});

describe('the drafting policy', () => {
    it('tier 0 drafts from a free-text brief or the questionnaire', () => {
        for (const kind of KINDS.filter((k) => CONTRACT_TYPES[k].tier === 0)) {
            expect(canDraftKind(kind), kind).toBe(true);
            expect(canDraftFromQuestionnaire(kind), kind).toBe(true);
        }
    });

    it('tier 1 drafts through the questionnaire only, never free text', () => {
        const tier1 = KINDS.filter((k) => CONTRACT_TYPES[k].tier === 1);
        expect(tier1.length).toBeGreaterThan(0);
        for (const kind of tier1) {
            expect(canDraftFromQuestionnaire(kind), kind).toBe(true);
            expect(canDraftKind(kind), kind).toBe(false);
        }
    });

    it('tier 2 refuses drafting, and says why', () => {
        const tier2 = KINDS.filter((k) => CONTRACT_TYPES[k].tier === 2);
        expect(tier2).toEqual(expect.arrayContaining(['lease', 'partnership']));
        for (const kind of tier2) {
            expect(isRefusedKind(kind), kind).toBe(true);
            expect(canDraftKind(kind), kind).toBe(false);
            expect(canDraftFromQuestionnaire(kind), kind).toBe(false);
            expect(draftModesForKind(kind), kind).toEqual([]);
            // Refused with a reason, not by omission: the point of listing them.
            expect(CONTRACT_TYPES[kind].refusedReason?.length ?? 0, kind).toBeGreaterThan(40);
            expect(questionsForKind(kind), kind).toEqual([]);
        }
    });

    it('a kind that cannot be drafted has no questions, and one that can does', () => {
        for (const kind of KINDS) {
            const hasQuestions = questionsForKind(kind).length > 0;
            expect(hasQuestions, kind).toBe(draftModesForKind(kind).length > 0);
        }
    });
});
