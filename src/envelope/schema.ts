/**
 * Documents (envelopes): the tier rules, and the recipient role rules.
 *
 * The tier engine lives here rather than in a handler on purpose. Drafting and
 * uploading are two different entry points, and a refusal list inside either one
 * is the tier engine built twice and badly. `kind` is a required enumerated
 * choice; `tier` is a pure lookup from it and is never accepted from a caller.
 *
 * The per-kind data itself moved to `registry.ts`, and these functions now read
 * it. There is deliberately no second tier table here: two copies is how a
 * tier 2 kind eventually ships as tier 0.
 */

import {
    CONTRACT_TYPES, ENVELOPE_KINDS, tryContractType,
    type DraftMode, type EnvelopeAnswers, type EnvelopeKind, type EnvelopeTier,
} from './registry';

export function isEnvelopeKind(v: unknown): v is EnvelopeKind {
    return typeof v === 'string' && (ENVELOPE_KINDS as readonly string[]).includes(v);
}

/** The only way a tier is ever set. Throws rather than defaulting, so an unknown kind cannot land as tier 0. */
export function tierForKind(kind: string): EnvelopeTier {
    if (!isEnvelopeKind(kind)) throw new Error(`Unknown document kind: ${kind}`);
    return CONTRACT_TYPES[kind].tier;
}

/** Tier 2 is refused at both entry points. Fails closed on an unknown kind. */
export function isRefusedKind(kind: string): boolean {
    try {
        return tierForKind(kind) >= 2;
    } catch {
        return true;
    }
}

/** How this kind may be drafted, if at all. Empty for an unknown kind and for tier 2. */
export function draftModesForKind(kind: string): readonly DraftMode[] {
    return tryContractType(kind)?.draftModes ?? [];
}

/**
 * Free-text drafting: "describe the job and we write it". Tier 0 only.
 *
 * Kept as the narrow gate it has always been. Tier 1 became draftable through
 * the questionnaire, not through a brief, so widening this function would open
 * the wrong door: callers that ask it are asking whether a paragraph of prose
 * may become a document.
 */
export function canDraftKind(kind: string): boolean {
    return draftModesForKind(kind).includes('free_text');
}

/** Structured drafting: fixed clauses, and the answers are the only variables. Tier 0 and tier 1. */
export function canDraftFromQuestionnaire(kind: string): boolean {
    return draftModesForKind(kind).includes('questionnaire');
}

export type EnvelopeStatus =
    | 'draft' | 'in_review' | 'out_for_signing' | 'completed' | 'declined' | 'voided' | 'expired';

export type RecipientRole = 'signer' | 'reviewer' | 'viewer';

export type RecipientStatus =
    | 'pending' | 'dispatched' | 'opened' | 'signed' | 'declined' | 'reviewed' | 'bounced' | 'revoked';

export type ReviewVerdict = 'approved' | 'changes_proposed' | 'rejected';

export type FieldType = 'signature' | 'initial' | 'date' | 'text';

export type ArtifactKind = 'original' | 'sealed' | 'certificate';

export type AccessCodeChannel = 'sms' | 'spoken' | 'email' | 'none';

/**
 * Only a signer may hold a field, and only a reviewer may return a verdict.
 * Expressed as functions so both the repo and the handlers ask the same
 * question. The inherited implementation kept role as a label used only for an
 * audit string, which is why its reviewers could sign.
 */
export function canHoldFields(role: RecipientRole): boolean {
    return role === 'signer';
}
export function canSign(role: RecipientRole): boolean {
    return role === 'signer';
}
export function canReturnVerdict(role: RecipientRole): boolean {
    return role === 'reviewer';
}

export interface EnvelopeDTO {
    envelopeId: string;
    orgId: string;
    businessProfileId?: string | null;
    createdBy: string;
    title: string;
    kind: EnvelopeKind;
    tier: EnvelopeTier;
    status: EnvelopeStatus;
    currentVersionNo: number;
    holdSignersForReview: boolean;

    // What the document was drafted FROM. Persisted so a regenerate can prefill
    // rather than asking everything again, and so the chain has a record of the
    // jurisdiction a contract was actually drafted under. Null on an upload.
    answers?: EnvelopeAnswers | null;
    /** An AU state or territory code. Validate with isAustralianJurisdiction from the registry. */
    jurisdiction?: string | null;
    /** YYYY-MM-DD. When the document takes effect, which is neither when it was created nor when it was signed. */
    effectiveDate?: string | null;

    completedAt?: string | null;
    voidedAt?: string | null;
    voidedReason?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface EnvelopeRecipientDTO {
    recipientId: string;
    envelopeId: string;
    role: RecipientRole;
    orderNo: number;
    name?: string | null;
    email: string;
    expiresAt?: string | null;
    revokedAt?: string | null;
    accessCodeChannel?: AccessCodeChannel | null;
    status: RecipientStatus;
    dispatchedAt?: string | null;
    firstOpenedAt?: string | null;
    completedAt?: string | null;
    sesMessageId?: string | null;
    bouncedAt?: string | null;
    bounceType?: string | null;
    bounceReason?: string | null;
    verdict?: ReviewVerdict | null;
    verdictAt?: string | null;
    verdictNote?: string | null;
    createdAt: string;
    updatedAt: string;
}
