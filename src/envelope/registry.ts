/**
 * The contract-type registry: one typed record per document kind.
 *
 * Before this file a kind was a bare string in an array and an integer in a
 * second table, and everything else about it lived wherever it was needed: the
 * icon in a React grid, the party labels hard-coded in a send form, the
 * questions in a prompt string. Four places to edit to add a kind, and one of
 * them is a tier table, which is how a tier 2 kind eventually ships as tier 0.
 *
 * So: kind, tier, parties and questions are one literal here, and `schema.ts`
 * reads its tier answers out of it rather than keeping a copy. `tier` is still
 * a pure lookup that is never accepted from a caller.
 *
 * Australian by construction. Jurisdictions are the states and territories,
 * money is AUD, GST is asked as inclusive or exclusive rather than assumed, and
 * the subcontractor set asks the superannuation question the way the
 * Superannuation Guarantee (Administration) Act actually poses it: a contract
 * wholly or principally for the person's labour attracts super whatever the
 * paperwork calls them.
 */

import type { RecipientRole } from './schema';

export const ENVELOPE_KINDS = [
    // Tier 0, sales. Drafted from a free-text brief or the questionnaire.
    'proposal',
    'quote_cover',
    'scope_of_works',
    'capability_statement',
    // Tier 1, agreements. Drafted through the questionnaire only, never from
    // free text: the safety property is "agreements only from fixed clauses",
    // not "no agreements at all".
    'subcontractor_agreement',
    'service_agreement',
    'nda',
    'deposit_terms',
    'variation_terms',
    // Tier 2, regulated. Refused outright. These are the Australian cases where
    // a contract is voidable, unenforceable or a back-pay liability without
    // independent advice. Listed rather than omitted so the type grid can show
    // them refused with the reason, which answers the question once instead of
    // leaving the owner to ask it again next month.
    'employment',
    'guarantor',
    'prenuptial',
    'small_business_loan',
    'lease',
    'partnership',
] as const;
export type EnvelopeKind = typeof ENVELOPE_KINDS[number];

export type EnvelopeTier = 0 | 1 | 2;

/**
 * How a document may be drafted. Absent both, drafting is refused.
 *
 * `free_text` is "describe the job and we write it", which is only safe where
 * the worst case is a badly worded sales document. `questionnaire` is the
 * structured path: fixed clauses, and the answers are the only variables.
 */
export type DraftMode = 'free_text' | 'questionnaire';

export type QuestionType = 'text' | 'textarea' | 'select' | 'toggle' | 'money' | 'date';

/** What an answer can be. `money` and `date` are held as strings: dollars as typed, dates as YYYY-MM-DD. */
export type AnswerValue = string | number | boolean | null;

export type EnvelopeAnswers = Record<string, AnswerValue>;

export interface QuestionOption {
    value: string;
    label: string;
}

/**
 * Show this field only when another answer has a given value.
 *
 * The depended-on key must appear EARLIER in the same kind's array, which is
 * what lets a renderer resolve visibility in one pass and stops a cycle being
 * expressible at all. Enforced by the registry test.
 */
export interface QuestionDependency {
    key: string;
    equals: AnswerValue;
}

export interface QuestionField {
    key: string;
    label: string;
    type: QuestionType;
    /** Section heading. Section ORDER is the order of first appearance in the array, so there is no second list to keep in step. */
    section: string;
    options?: readonly QuestionOption[];
    default?: AnswerValue;
    required?: boolean;
    placeholder?: string;
    dependsOn?: QuestionDependency;
}

/**
 * A named slot on the document, filled by a person when it is sent.
 *
 * The label is what the owner reads while filling it in, and it is specific to
 * the kind: a subcontractor agreement has a hirer and a subcontractor, an NDA
 * has a disclosing and a receiving party. One generic "Party A / Party B" pair
 * for everything is how a form stops telling you anything.
 *
 * `roleKey` is stable and is what template fields point at (see
 * envelope_template_roles.role_key); the label can be reworded without
 * orphaning anything.
 */
export interface PartySlot {
    roleKey: string;
    label: string;
    signingRole: RecipientRole;
}

export interface ContractType {
    id: EnvelopeKind;
    label: string;
    /** One line on when you would use it. Shown under the label in the type grid. */
    description: string;
    /** Names a lucide-react component, e.g. 'FileText'. A string so this file stays data and can cross a wire. */
    icon: string;
    tier: EnvelopeTier;
    /** Ordered: this is dispatch order when the document is sent. */
    parties: readonly PartySlot[];
    questions: readonly QuestionField[];
    /** Empty means drafting is refused for this kind. */
    draftModes: readonly DraftMode[];
    /** Tier 2 only: why we will not draft it. Shown instead of a Draft button. */
    refusedReason?: string;
}

// ---------------------------------------------------------------------------
// Shared option sets.
//
// Shared for the VALUES, not to save typing: a renderer, a prompt and a report
// all have to agree that "ex_gst" means the same thing on a proposal and on a
// subcontractor agreement. The question literals themselves stay per kind.
// ---------------------------------------------------------------------------

/** The eight Australian jurisdictions. New South Wales is the default. */
export const AU_JURISDICTIONS: readonly QuestionOption[] = [
    { value: 'NSW', label: 'New South Wales' },
    { value: 'VIC', label: 'Victoria' },
    { value: 'QLD', label: 'Queensland' },
    { value: 'WA', label: 'Western Australia' },
    { value: 'SA', label: 'South Australia' },
    { value: 'TAS', label: 'Tasmania' },
    { value: 'ACT', label: 'Australian Capital Territory' },
    { value: 'NT', label: 'Northern Territory' },
];

export type AustralianJurisdiction = 'NSW' | 'VIC' | 'QLD' | 'WA' | 'SA' | 'TAS' | 'ACT' | 'NT';

export const DEFAULT_JURISDICTION: AustralianJurisdiction = 'NSW';

export function isAustralianJurisdiction(v: unknown): v is AustralianJurisdiction {
    return typeof v === 'string' && AU_JURISDICTIONS.some((j) => j.value === v);
}

const GST_TREATMENTS: readonly QuestionOption[] = [
    { value: 'ex_gst', label: 'Price excludes GST' },
    { value: 'inc_gst', label: 'Price includes GST' },
    { value: 'no_gst', label: 'Not registered for GST' },
];

const PAYMENT_TERMS: readonly QuestionOption[] = [
    { value: '7', label: '7 days from invoice' },
    { value: '14', label: '14 days from invoice' },
    { value: '21', label: '21 days from invoice' },
    { value: '30', label: '30 days from invoice' },
    { value: 'eom_30', label: 'End of month plus 30 days' },
];

const CLAIM_FREQUENCIES: readonly QuestionOption[] = [
    { value: 'weekly', label: 'Weekly' },
    { value: 'fortnightly', label: 'Fortnightly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'on_milestone', label: 'On each milestone' },
];

const PUBLIC_LIABILITY_COVER: readonly QuestionOption[] = [
    { value: '5m', label: '$5 million' },
    { value: '10m', label: '$10 million' },
    { value: '20m', label: '$20 million' },
];

const DEFECTS_LIABILITY_MONTHS: readonly QuestionOption[] = [
    { value: '3', label: '3 months' },
    { value: '6', label: '6 months' },
    { value: '12', label: '12 months' },
    { value: '24', label: '24 months' },
];

const ACCEPTANCE_METHODS: readonly QuestionOption[] = [
    { value: 'sign', label: 'Sign and return this document' },
    { value: 'purchase_order', label: 'Issue a purchase order' },
    { value: 'email', label: 'Confirm by email' },
];

/** Reused verbatim across kinds that ask it, so the answer means one thing everywhere. */
const jurisdictionQuestion = (section: string): QuestionField => ({
    key: 'jurisdiction',
    label: 'Governing jurisdiction',
    type: 'select',
    section,
    options: AU_JURISDICTIONS,
    default: DEFAULT_JURISDICTION,
    required: true,
});

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const CONTRACT_TYPES: Record<EnvelopeKind, ContractType> = {
    // -----------------------------------------------------------------------
    // Tier 0. Sales documents. Nothing here binds anyone to anything until a
    // separate agreement is signed, which is why free text is safe.
    // -----------------------------------------------------------------------

    proposal: {
        id: 'proposal',
        label: 'Proposal',
        description: 'A priced offer for a piece of work, with what is included, what it costs and how the client accepts it.',
        icon: 'FileText',
        tier: 0,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'us', label: 'Your business', signingRole: 'signer' },
        ],
        draftModes: ['free_text', 'questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The client', required: true, placeholder: 'Northshore Property Group Pty Ltd' },
            { key: 'client_abn', label: 'Client ABN', type: 'text', section: 'The client', placeholder: '12 345 678 901' },
            { key: 'client_contact', label: 'Contact person', type: 'text', section: 'The client', placeholder: 'Dana Whitely, Facilities Manager' },

            { key: 'project_name', label: 'Project name', type: 'text', section: 'The work', required: true, placeholder: 'Level 3 lighting upgrade' },
            { key: 'site_address', label: 'Site address', type: 'text', section: 'The work', placeholder: '14 Ross Street, Newcastle NSW 2300' },
            { key: 'summary', label: 'What you are proposing', type: 'textarea', section: 'The work', required: true, placeholder: 'Two sentences on the outcome the client gets.' },
            { key: 'inclusions', label: 'What is included', type: 'textarea', section: 'The work', required: true, placeholder: 'One line per item.' },
            { key: 'exclusions', label: 'What is not included', type: 'textarea', section: 'The work', placeholder: 'The items a client most often assumes are in the price.' },
            { key: 'assumptions', label: 'Assumptions this price depends on', type: 'textarea', section: 'The work', placeholder: 'Clear site access, existing switchboard has capacity.' },

            {
                key: 'price_basis', label: 'How the price is built', type: 'select', section: 'Price', required: true, default: 'fixed',
                options: [
                    { value: 'fixed', label: 'Fixed price' },
                    { value: 'schedule_of_rates', label: 'Schedule of rates' },
                    { value: 'cost_plus', label: 'Cost plus margin' },
                    { value: 'estimate', label: 'Estimate only, not a fixed price' },
                ],
            },
            { key: 'price', label: 'Price (AUD)', type: 'money', section: 'Price', required: true },
            { key: 'rates_note', label: 'The rates that apply', type: 'textarea', section: 'Price', dependsOn: { key: 'price_basis', equals: 'schedule_of_rates' }, placeholder: 'Tradesperson $110/hr, apprentice $65/hr, after hours at time and a half.' },
            { key: 'margin_percent', label: 'Margin on cost (%)', type: 'text', section: 'Price', default: '15', dependsOn: { key: 'price_basis', equals: 'cost_plus' } },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'Price', required: true, default: 'ex_gst', options: GST_TREATMENTS },
            { key: 'price_valid_days', label: 'Price held for (days)', type: 'text', section: 'Price', default: '30' },

            { key: 'start_date', label: 'Proposed start', type: 'date', section: 'Timing' },
            { key: 'duration', label: 'Expected duration', type: 'text', section: 'Timing', placeholder: 'About three weeks' },
            { key: 'program_note', label: 'Anything that affects timing', type: 'textarea', section: 'Timing', placeholder: 'Long lead items, council approval, access windows.' },

            { key: 'deposit_required', label: 'Deposit required', type: 'toggle', section: 'Payment', default: true },
            {
                key: 'deposit_percent', label: 'Deposit (% of price)', type: 'text', section: 'Payment',
                // 10, not 20. A default is what most people accept without
                // thinking, and for residential building work 20 is unlawful in
                // more than one state: NSW caps a deposit at 10% (Home Building
                // Act s7C) and Victoria at 5% on contracts of $20,000 or more
                // (Domestic Building Contracts Act). Defaulting a tradesperson's
                // quote to a deposit they cannot lawfully ask for is worse than
                // making them type a number.
                default: '10',
                placeholder: '10',
                dependsOn: { key: 'deposit_required', equals: true },
            },
            { key: 'progress_claims', label: 'Progress claims', type: 'toggle', section: 'Payment', default: false },
            { key: 'claim_frequency', label: 'Claim frequency', type: 'select', section: 'Payment', options: CLAIM_FREQUENCIES, default: 'monthly', dependsOn: { key: 'progress_claims', equals: true } },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Payment', required: true, default: '14', options: PAYMENT_TERMS },

            { key: 'acceptance_method', label: 'How the client accepts', type: 'select', section: 'Acceptance', required: true, default: 'sign', options: ACCEPTANCE_METHODS },
            { key: 'notes', label: 'Anything else to say', type: 'textarea', section: 'Acceptance' },
        ],
    },

    quote_cover: {
        id: 'quote_cover',
        label: 'Quote cover letter',
        description: 'The page that goes in front of a quote: what it is for, what the price covers and how long it stands.',
        icon: 'Receipt',
        tier: 0,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'us', label: 'Your business', signingRole: 'viewer' },
        ],
        draftModes: ['free_text', 'questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The quote', required: true },
            { key: 'quote_number', label: 'Quote number', type: 'text', section: 'The quote', placeholder: 'Q-1042' },
            { key: 'project_name', label: 'What the quote is for', type: 'text', section: 'The quote', required: true, placeholder: 'Replace rear deck and balustrade' },
            { key: 'site_address', label: 'Site address', type: 'text', section: 'The quote' },

            { key: 'price', label: 'Quoted price (AUD)', type: 'money', section: 'Price', required: true },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'Price', required: true, default: 'ex_gst', options: GST_TREATMENTS },
            { key: 'price_valid_days', label: 'Price held for (days)', type: 'text', section: 'Price', default: '30' },
            { key: 'variations_note', label: 'Say that variations are priced separately', type: 'toggle', section: 'Price', default: true },

            { key: 'inclusions', label: 'Included in this price', type: 'textarea', section: 'What is covered', required: true },
            { key: 'exclusions', label: 'Not included', type: 'textarea', section: 'What is covered' },
            { key: 'provisional_sums', label: 'Provisional sums and allowances', type: 'textarea', section: 'What is covered', placeholder: 'Tiling allowance $60/m2, adjusted on selection.' },

            { key: 'deposit_required', label: 'Deposit required', type: 'toggle', section: 'Payment', default: true },
            {
                key: 'deposit_percent', label: 'Deposit (% of price)', type: 'text', section: 'Payment',
                // 10, not 20. A default is what most people accept without
                // thinking, and for residential building work 20 is unlawful in
                // more than one state: NSW caps a deposit at 10% (Home Building
                // Act s7C) and Victoria at 5% on contracts of $20,000 or more
                // (Domestic Building Contracts Act). Defaulting a tradesperson's
                // quote to a deposit they cannot lawfully ask for is worse than
                // making them type a number.
                default: '10',
                placeholder: '10',
                dependsOn: { key: 'deposit_required', equals: true },
            },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Payment', required: true, default: '14', options: PAYMENT_TERMS },
            {
                key: 'payment_method', label: 'How to pay', type: 'select', section: 'Payment', default: 'bank_transfer',
                options: [
                    { value: 'bank_transfer', label: 'Bank transfer' },
                    { value: 'card', label: 'Card' },
                    { value: 'both', label: 'Bank transfer or card' },
                ],
            },

            { key: 'acceptance_method', label: 'How the client accepts', type: 'select', section: 'Next step', required: true, default: 'sign', options: ACCEPTANCE_METHODS },
            { key: 'contact_name', label: 'Who to contact with questions', type: 'text', section: 'Next step' },
            { key: 'notes', label: 'Anything else to say', type: 'textarea', section: 'Next step' },
        ],
    },

    scope_of_works: {
        id: 'scope_of_works',
        label: 'Scope of works',
        description: 'The definitive list of what gets done on site, what is excluded, who supplies what and when it is finished.',
        icon: 'ClipboardList',
        tier: 0,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'us', label: 'Your business', signingRole: 'signer' },
        ],
        draftModes: ['free_text', 'questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The job', required: true },
            { key: 'project_name', label: 'Project', type: 'text', section: 'The job', required: true },
            { key: 'site_address', label: 'Site address', type: 'text', section: 'The job', required: true },
            { key: 'principal_contractor', label: 'Principal contractor, if not you', type: 'text', section: 'The job' },

            { key: 'works_description', label: 'What will be done', type: 'textarea', section: 'The works', required: true, placeholder: 'One line per work item, in the order it happens.' },
            { key: 'stages', label: 'Stages or work packages', type: 'textarea', section: 'The works' },
            { key: 'exclusions', label: 'Explicitly excluded', type: 'textarea', section: 'The works', required: true, placeholder: 'Asbestos removal, painting, making good to adjoining tenancies.' },
            { key: 'standards', label: 'Standards the work is built to', type: 'text', section: 'The works', placeholder: 'AS/NZS 3000, NCC 2022 Volume One' },

            {
                key: 'materials_supplied_by', label: 'Who supplies materials', type: 'select', section: 'Site and supply', required: true, default: 'contractor',
                options: [
                    { value: 'contractor', label: 'You supply materials' },
                    { value: 'client', label: 'Client supplies materials' },
                    { value: 'split', label: 'Split, listed below' },
                ],
            },
            { key: 'supply_split_note', label: 'Who supplies what', type: 'textarea', section: 'Site and supply', dependsOn: { key: 'materials_supplied_by', equals: 'split' } },
            { key: 'site_access', label: 'Site access', type: 'textarea', section: 'Site and supply', placeholder: 'Keys held by building manager, loading dock booked a day ahead.' },
            {
                key: 'power_water', label: 'Power and water on site', type: 'select', section: 'Site and supply', default: 'client',
                options: [
                    { value: 'client', label: 'Client provides' },
                    { value: 'contractor', label: 'You provide' },
                    { value: 'none', label: 'Not available on site' },
                ],
            },
            {
                key: 'waste_removal', label: 'Waste removal', type: 'select', section: 'Site and supply', default: 'contractor',
                options: [
                    { value: 'contractor', label: 'You remove waste' },
                    { value: 'client', label: 'Client removes waste' },
                ],
            },

            { key: 'start_date', label: 'Start on site', type: 'date', section: 'Program' },
            { key: 'completion_date', label: 'Practical completion', type: 'date', section: 'Program' },
            { key: 'working_hours', label: 'Working hours', type: 'text', section: 'Program', default: 'Monday to Friday, 7am to 3pm' },
            { key: 'weather_allowance_days', label: 'Wet weather days allowed', type: 'text', section: 'Program', default: '5' },

            { key: 'price', label: 'Contract sum (AUD)', type: 'money', section: 'Price and payment', required: true },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'Price and payment', required: true, default: 'ex_gst', options: GST_TREATMENTS },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Price and payment', required: true, default: '14', options: PAYMENT_TERMS },
            { key: 'progress_claims', label: 'Progress claims', type: 'toggle', section: 'Price and payment', default: true },
            { key: 'claim_frequency', label: 'Claim frequency', type: 'select', section: 'Price and payment', options: CLAIM_FREQUENCIES, default: 'monthly', dependsOn: { key: 'progress_claims', equals: true } },
            {
                // Security of Payment is the money mechanism for construction
                // work in every Australian state and territory. A progress
                // claim clause written as though it did not exist is the
                // single most consequential omission a subcontract can make:
                // the regime sets when a payment claim may be served, how long
                // the principal has to answer with a payment schedule, and what
                // happens if they do not. Asking is cheap; a clause that
                // contradicts the Act is not enforceable anyway.
                key: 'sopa_applies', label: 'Construction work covered by Security of Payment',
                type: 'toggle', section: 'Price and payment', default: true,
            },
            {
                key: 'sopa_claim_day', label: 'Payment claims served on',
                type: 'select', section: 'Price and payment', default: 'last_day',
                options: [
                    { value: 'last_day', label: 'The last day of the month' },
                    { value: 'day_25', label: 'The 25th of the month' },
                    { value: 'on_milestone', label: 'On reaching each milestone' },
                ],
                dependsOn: { key: 'sopa_applies', equals: true },
            },
            { key: 'retention', label: 'Retention held', type: 'toggle', section: 'Price and payment', default: false },
            { key: 'retention_percent', label: 'Retention (% of each claim)', type: 'text', section: 'Price and payment', default: '5', dependsOn: { key: 'retention', equals: true } },
            {
                key: 'retention_release', label: 'Retention released at', type: 'select', section: 'Price and payment', default: 'half_each',
                options: [
                    { value: 'practical_completion', label: 'All of it at practical completion' },
                    { value: 'defects_expiry', label: 'All of it when the defects period ends' },
                    { value: 'half_each', label: 'Half at practical completion, half when the defects period ends' },
                ],
                dependsOn: { key: 'retention', equals: true },
            },

            { key: 'defects_liability_months', label: 'Defects liability period', type: 'select', section: 'Defects and variations', required: true, default: '12', options: DEFECTS_LIABILITY_MONTHS },
            { key: 'variations_in_writing', label: 'Variations only in writing', type: 'toggle', section: 'Defects and variations', default: true },
            { key: 'variation_rate', label: 'Hourly rate for variations (AUD)', type: 'money', section: 'Defects and variations' },

            { key: 'public_liability_cover', label: 'Public liability cover', type: 'select', section: 'Insurance and safety', required: true, default: '20m', options: PUBLIC_LIABILITY_COVER },
            { key: 'workers_comp', label: 'Workers compensation in place', type: 'toggle', section: 'Insurance and safety', default: true },
            { key: 'swms_required', label: 'Safe work method statement before work starts', type: 'toggle', section: 'Insurance and safety', default: true },

            jurisdictionQuestion('Governing law'),
        ],
    },

    capability_statement: {
        id: 'capability_statement',
        label: 'Capability statement',
        description: 'A one-page statement of what the business does, who it has done it for, and the licences and insurances it holds.',
        icon: 'Building2',
        tier: 0,
        // Ordered with us first: the document is about us, and the declaration
        // at the foot of it is ours to sign. The reader only ever receives it.
        parties: [
            { roleKey: 'us', label: 'Your business', signingRole: 'signer' },
            { roleKey: 'recipient', label: 'Who it is going to', signingRole: 'viewer' },
        ],
        draftModes: ['free_text', 'questionnaire'],
        questions: [
            { key: 'business_name', label: 'Business name', type: 'text', section: 'The business', required: true },
            { key: 'abn', label: 'ABN', type: 'text', section: 'The business', required: true, placeholder: '12 345 678 901' },
            {
                key: 'entity_type', label: 'Entity type', type: 'select', section: 'The business', default: 'company',
                options: [
                    { value: 'sole_trader', label: 'Sole trader' },
                    { value: 'partnership', label: 'Partnership' },
                    { value: 'company', label: 'Company' },
                    { value: 'trust', label: 'Trust' },
                ],
            },
            { key: 'trading_since', label: 'Trading since', type: 'text', section: 'The business', placeholder: '2016' },
            { key: 'overview', label: 'What the business does', type: 'textarea', section: 'The business', required: true, placeholder: 'Three sentences. What you do, who for, and what you are known for.' },

            { key: 'core_services', label: 'Core services', type: 'textarea', section: 'Services', required: true, placeholder: 'One line per service.' },
            { key: 'service_area', label: 'Where you work', type: 'text', section: 'Services', required: true, placeholder: 'Sydney metro and the Central Coast' },
            { key: 'sectors', label: 'Sectors you work in', type: 'textarea', section: 'Services', placeholder: 'Strata, aged care, light commercial fitout.' },
            { key: 'capacity', label: 'Crew size and capacity', type: 'text', section: 'Services', placeholder: 'Six tradespeople, three vehicles, two jobs at a time' },

            { key: 'key_projects', label: 'Projects worth naming', type: 'textarea', section: 'Track record', placeholder: 'Client, what you did, roughly when, roughly what it was worth.' },
            { key: 'largest_contract', label: 'Largest contract delivered (AUD)', type: 'money', section: 'Track record' },
            { key: 'referees', label: 'Referees', type: 'textarea', section: 'Track record' },

            { key: 'licence_numbers', label: 'Licences and registrations', type: 'textarea', section: 'Licences and insurance', placeholder: 'NSW electrical contractor licence 123456C' },
            { key: 'public_liability_cover', label: 'Public liability cover', type: 'select', section: 'Licences and insurance', required: true, default: '20m', options: PUBLIC_LIABILITY_COVER },
            { key: 'workers_comp', label: 'Workers compensation in place', type: 'toggle', section: 'Licences and insurance', default: true },
            { key: 'professional_indemnity', label: 'Professional indemnity held', type: 'toggle', section: 'Licences and insurance', default: false },
            {
                key: 'professional_indemnity_cover', label: 'Professional indemnity cover', type: 'select', section: 'Licences and insurance', default: '1m',
                options: [
                    { value: '1m', label: '$1 million' },
                    { value: '2m', label: '$2 million' },
                    { value: '5m', label: '$5 million' },
                    { value: '10m', label: '$10 million' },
                ],
                dependsOn: { key: 'professional_indemnity', equals: true },
            },
            { key: 'accreditations', label: 'Accreditations and memberships', type: 'textarea', section: 'Licences and insurance', placeholder: 'Master Builders Association, ISO 9001, CM3 prequalified.' },

            { key: 'contact_name', label: 'Contact name', type: 'text', section: 'Contact', required: true },
            { key: 'contact_phone', label: 'Phone', type: 'text', section: 'Contact' },
            { key: 'website', label: 'Website', type: 'text', section: 'Contact' },
        ],
    },

    // -----------------------------------------------------------------------
    // Tier 1. Agreements. Questionnaire only: the clauses are fixed and the
    // answers are the only variables, so there is no path where a model writes
    // an obligation nobody chose.
    // -----------------------------------------------------------------------

    subcontractor_agreement: {
        id: 'subcontractor_agreement',
        label: 'Subcontractor agreement',
        description: 'Engages another business to do part of the work you have been contracted for, on your terms.',
        icon: 'HardHat',
        tier: 1,
        parties: [
            { roleKey: 'subcontractor', label: 'Subcontractor', signingRole: 'signer' },
            { roleKey: 'hirer', label: 'Hirer, your business', signingRole: 'signer' },
        ],
        draftModes: ['questionnaire'],
        questions: [
            { key: 'hirer_name', label: 'Hirer name', type: 'text', section: 'The parties', required: true },
            { key: 'hirer_abn', label: 'Hirer ABN', type: 'text', section: 'The parties', required: true },
            { key: 'subcontractor_name', label: 'Subcontractor name', type: 'text', section: 'The parties', required: true },
            { key: 'subcontractor_abn', label: 'Subcontractor ABN', type: 'text', section: 'The parties', required: true },
            { key: 'subcontractor_licence', label: 'Subcontractor licence number', type: 'text', section: 'The parties' },

            { key: 'works', label: 'The work being subcontracted', type: 'textarea', section: 'The work', required: true },
            { key: 'site_address', label: 'Site address', type: 'text', section: 'The work' },
            { key: 'start_date', label: 'Start date', type: 'date', section: 'The work' },
            { key: 'completion_date', label: 'Completion date', type: 'date', section: 'The work' },

            {
                key: 'rate_basis', label: 'How they are paid', type: 'select', section: 'Money', required: true, default: 'fixed',
                options: [
                    { value: 'fixed', label: 'Fixed price for the package' },
                    { value: 'hourly', label: 'Hourly rate' },
                    { value: 'day_rate', label: 'Day rate' },
                    { value: 'schedule_of_rates', label: 'Schedule of rates' },
                ],
            },
            { key: 'rate', label: 'Rate or price (AUD)', type: 'money', section: 'Money', required: true },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'Money', required: true, default: 'ex_gst', options: GST_TREATMENTS },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Money', required: true, default: '30', options: PAYMENT_TERMS },
            { key: 'retention', label: 'Retention held', type: 'toggle', section: 'Money', default: false },
            { key: 'retention_percent', label: 'Retention (% of each claim)', type: 'text', section: 'Money', default: '5', dependsOn: { key: 'retention', equals: true } },

            // The distinction that decides whether this is a contractor deal at
            // all. Getting it wrong is a superannuation guarantee charge, not a
            // contract dispute, and the charge is not deductible.
            { key: 'own_abn_confirmed', label: 'Works under its own ABN and invoices you', type: 'toggle', section: 'Contractor or employee', default: true },
            { key: 'controls_own_hours', label: 'Sets its own hours and method of work', type: 'toggle', section: 'Contractor or employee', default: true },
            { key: 'supplies_own_tools', label: 'Supplies its own tools, plant and materials', type: 'toggle', section: 'Contractor or employee', default: true },
            { key: 'can_delegate', label: 'Can send someone else to do the work', type: 'toggle', section: 'Contractor or employee', default: true },
            {
                key: 'super_payable', label: 'Superannuation payable', type: 'select', section: 'Contractor or employee', required: true, default: 'no',
                options: [
                    { value: 'no', label: 'No, the contract is for a result, not for labour' },
                    { value: 'yes', label: 'Yes, the contract is wholly or principally for their labour' },
                ],
            },
            { key: 'super_rate_percent', label: 'Super rate (%)', type: 'text', section: 'Contractor or employee', default: '12', dependsOn: { key: 'super_payable', equals: 'yes' } },

            { key: 'public_liability_cover', label: 'Public liability cover they must hold', type: 'select', section: 'Insurance and safety', required: true, default: '20m', options: PUBLIC_LIABILITY_COVER },
            { key: 'workers_comp', label: 'Workers compensation or personal accident cover required', type: 'toggle', section: 'Insurance and safety', default: true },
            { key: 'swms_required', label: 'Safe work method statement before work starts', type: 'toggle', section: 'Insurance and safety', default: true },

            { key: 'defects_liability_months', label: 'Defects liability period', type: 'select', section: 'Defects and law', required: true, default: '12', options: DEFECTS_LIABILITY_MONTHS },
            jurisdictionQuestion('Defects and law'),
        ],
    },

    service_agreement: {
        id: 'service_agreement',
        label: 'Service agreement',
        description: 'Ongoing services for one client, with a fixed scope, an agreed rate and a stated way out.',
        icon: 'Handshake',
        tier: 1,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'supplier', label: 'Supplier, your business', signingRole: 'signer' },
        ],
        draftModes: ['questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The parties', required: true },
            { key: 'client_abn', label: 'Client ABN', type: 'text', section: 'The parties' },
            { key: 'supplier_name', label: 'Supplier name', type: 'text', section: 'The parties', required: true },
            { key: 'supplier_abn', label: 'Supplier ABN', type: 'text', section: 'The parties', required: true },

            { key: 'services', label: 'The services', type: 'textarea', section: 'The services', required: true },
            { key: 'service_levels', label: 'Response times and service levels', type: 'textarea', section: 'The services', placeholder: 'Same business day for a breakdown, 48 hours otherwise.' },
            { key: 'exclusions', label: 'Not included', type: 'textarea', section: 'The services' },

            { key: 'start_date', label: 'Start date', type: 'date', section: 'Term', required: true },
            {
                key: 'term_type', label: 'Term', type: 'select', section: 'Term', required: true, default: 'ongoing',
                options: [
                    { value: 'ongoing', label: 'Ongoing until cancelled' },
                    { value: 'fixed', label: 'Fixed term' },
                ],
            },
            { key: 'term_months', label: 'Term length (months)', type: 'text', section: 'Term', default: '12', dependsOn: { key: 'term_type', equals: 'fixed' } },
            {
                key: 'notice_period_days', label: 'Notice to cancel', type: 'select', section: 'Term', required: true, default: '30',
                options: [
                    { value: '14', label: '14 days' },
                    { value: '30', label: '30 days' },
                    { value: '60', label: '60 days' },
                    { value: '90', label: '90 days' },
                ],
            },

            {
                key: 'fee_basis', label: 'How fees are charged', type: 'select', section: 'Fees', required: true, default: 'monthly',
                options: [
                    { value: 'monthly', label: 'Monthly retainer' },
                    { value: 'hourly', label: 'Hourly' },
                    { value: 'per_job', label: 'Per job' },
                ],
            },
            { key: 'rate', label: 'Fee or rate (AUD)', type: 'money', section: 'Fees', required: true },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'Fees', required: true, default: 'ex_gst', options: GST_TREATMENTS },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Fees', required: true, default: '14', options: PAYMENT_TERMS },
            {
                key: 'price_review', label: 'Price review', type: 'select', section: 'Fees', default: 'annual',
                options: [
                    { value: 'none', label: 'Fixed for the term' },
                    { value: 'annual', label: 'Reviewed each year' },
                    { value: 'cpi', label: 'Indexed to CPI each year' },
                ],
            },

            {
                key: 'liability_cap', label: 'Liability capped at', type: 'select', section: 'Liability and law', required: true, default: 'fees_paid',
                options: [
                    { value: 'fees_paid', label: 'The fees paid in the last twelve months' },
                    { value: 'fixed_amount', label: 'A fixed amount' },
                    { value: 'none', label: 'Not capped' },
                ],
            },
            { key: 'liability_cap_amount', label: 'Liability cap (AUD)', type: 'money', section: 'Liability and law', dependsOn: { key: 'liability_cap', equals: 'fixed_amount' } },
            jurisdictionQuestion('Liability and law'),
        ],
    },

    nda: {
        id: 'nda',
        label: 'Non-disclosure agreement',
        description: 'Protects the information one side shows the other before or during a job.',
        icon: 'ShieldCheck',
        tier: 1,
        parties: [
            { roleKey: 'receiving_party', label: 'Receiving party', signingRole: 'signer' },
            { roleKey: 'disclosing_party', label: 'Disclosing party', signingRole: 'signer' },
        ],
        draftModes: ['questionnaire'],
        questions: [
            { key: 'disclosing_name', label: 'Disclosing party', type: 'text', section: 'The parties', required: true },
            { key: 'disclosing_abn', label: 'Disclosing party ABN', type: 'text', section: 'The parties' },
            { key: 'receiving_name', label: 'Receiving party', type: 'text', section: 'The parties', required: true },
            { key: 'receiving_abn', label: 'Receiving party ABN', type: 'text', section: 'The parties' },
            { key: 'mutual', label: 'Both sides disclose', type: 'toggle', section: 'The parties', default: false },

            { key: 'purpose', label: 'Why information is being shared', type: 'textarea', section: 'What is protected', required: true, placeholder: 'To price a fitout and, if accepted, to build it.' },
            { key: 'confidential_scope', label: 'What counts as confidential', type: 'textarea', section: 'What is protected', required: true, placeholder: 'Pricing, drawings, client lists, anything marked confidential.' },

            { key: 'effective_date', label: 'Effective date', type: 'date', section: 'Term', required: true },
            {
                key: 'term_months', label: 'Confidentiality lasts', type: 'select', section: 'Term', required: true, default: '24',
                options: [
                    { value: '12', label: '12 months' },
                    { value: '24', label: '24 months' },
                    { value: '36', label: '36 months' },
                    { value: '60', label: '5 years' },
                    { value: 'indefinite', label: 'Indefinitely' },
                ],
            },

            {
                key: 'return_or_destroy', label: 'At the end, information is', type: 'select', section: 'Ending it', required: true, default: 'destroy',
                options: [
                    { value: 'return', label: 'Returned' },
                    { value: 'destroy', label: 'Destroyed' },
                    { value: 'either', label: 'Returned or destroyed, their choice' },
                ],
            },
            jurisdictionQuestion('Ending it'),
        ],
    },

    deposit_terms: {
        id: 'deposit_terms',
        label: 'Deposit terms',
        description: 'What the deposit buys, when it is due, and what happens to it if the job is called off.',
        icon: 'Banknote',
        tier: 1,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'us', label: 'Your business', signingRole: 'signer' },
        ],
        draftModes: ['questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The job', required: true },
            { key: 'project_name', label: 'Project', type: 'text', section: 'The job', required: true },
            { key: 'contract_price', label: 'Contract price (AUD)', type: 'money', section: 'The job', required: true },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'The job', required: true, default: 'ex_gst', options: GST_TREATMENTS },

            {
                key: 'deposit_basis', label: 'Deposit set as', type: 'select', section: 'The deposit', required: true, default: 'percent',
                options: [
                    { value: 'percent', label: 'A percentage of the contract price' },
                    { value: 'amount', label: 'A fixed amount' },
                ],
            },
            { key: 'deposit_percent', label: 'Deposit (% of contract price)', type: 'text', section: 'The deposit', default: '10', dependsOn: { key: 'deposit_basis', equals: 'percent' } },
            { key: 'deposit_amount', label: 'Deposit (AUD)', type: 'money', section: 'The deposit', dependsOn: { key: 'deposit_basis', equals: 'amount' } },
            {
                key: 'due_when', label: 'Due', type: 'select', section: 'The deposit', required: true, default: 'on_acceptance',
                options: [
                    { value: 'on_acceptance', label: 'On acceptance of the quote' },
                    { value: 'before_order', label: 'Before materials are ordered' },
                    { value: 'on_site_start', label: 'On the first day on site' },
                ],
            },
            { key: 'what_it_covers', label: 'What the deposit covers', type: 'textarea', section: 'The deposit', required: true, placeholder: 'Materials ordered to size, and the slot held in the schedule.' },

            {
                key: 'refundable', label: 'If the client cancels', type: 'select', section: 'If it is called off', required: true, default: 'partial',
                options: [
                    { value: 'full', label: 'Deposit refunded in full' },
                    { value: 'partial', label: 'Costs already incurred are kept, the rest refunded' },
                    { value: 'non_refundable', label: 'Deposit is not refunded' },
                ],
            },
            { key: 'deduction_note', label: 'What you keep and why', type: 'textarea', section: 'If it is called off', dependsOn: { key: 'refundable', equals: 'partial' } },
            { key: 'cooling_off_days', label: 'Cooling off period (business days)', type: 'text', section: 'If it is called off', default: '5' },

            // Residential building work carries statutory deposit caps that
            // differ by state, and a deposit above the cap is an offence rather
            // than a term the client agreed to. Asked, not assumed.
            { key: 'residential_building_work', label: 'This is residential building work', type: 'toggle', section: 'If it is called off', default: false },
            { key: 'deposit_cap_ack', label: 'Deposit is within the statutory cap for this jurisdiction', type: 'toggle', section: 'If it is called off', default: false, dependsOn: { key: 'residential_building_work', equals: true } },

            jurisdictionQuestion('Governing law'),
        ],
    },

    variation_terms: {
        id: 'variation_terms',
        label: 'Variation terms',
        description: 'How a change to an agreed job gets approved, priced and paid, agreed before the change happens.',
        icon: 'FilePlus2',
        tier: 1,
        parties: [
            { roleKey: 'client', label: 'Client', signingRole: 'signer' },
            { roleKey: 'us', label: 'Your business', signingRole: 'signer' },
        ],
        draftModes: ['questionnaire'],
        questions: [
            { key: 'client_name', label: 'Client name', type: 'text', section: 'The contract being varied', required: true },
            { key: 'project_name', label: 'Project', type: 'text', section: 'The contract being varied', required: true },
            { key: 'original_contract_date', label: 'Date of the original contract', type: 'date', section: 'The contract being varied' },
            { key: 'original_price', label: 'Original contract sum (AUD)', type: 'money', section: 'The contract being varied' },

            {
                key: 'approval_required', label: 'A variation is approved by', type: 'select', section: 'How variations work', required: true, default: 'written',
                options: [
                    { value: 'written', label: 'A signed variation order before work starts' },
                    { value: 'email', label: 'Written confirmation by email' },
                    { value: 'verbal_then_written', label: 'Verbal on site, confirmed in writing within 48 hours' },
                ],
            },
            {
                key: 'priced_how', label: 'A variation is priced', type: 'select', section: 'How variations work', required: true, default: 'quoted',
                options: [
                    { value: 'quoted', label: 'Quoted before it is approved' },
                    { value: 'hourly', label: 'At an hourly rate plus materials' },
                    { value: 'cost_plus', label: 'At cost plus a margin' },
                ],
            },
            { key: 'hourly_rate', label: 'Hourly rate (AUD)', type: 'money', section: 'How variations work', dependsOn: { key: 'priced_how', equals: 'hourly' } },
            { key: 'margin_percent', label: 'Margin on cost (%)', type: 'text', section: 'How variations work', default: '15', dependsOn: { key: 'priced_how', equals: 'cost_plus' } },
            { key: 'gst_treatment', label: 'GST', type: 'select', section: 'How variations work', required: true, default: 'ex_gst', options: GST_TREATMENTS },

            { key: 'program_extension', label: 'An approved variation extends the program', type: 'toggle', section: 'Timing and payment', default: true },
            {
                key: 'invoiced_when', label: 'Variations are invoiced', type: 'select', section: 'Timing and payment', required: true, default: 'with_next_claim',
                options: [
                    { value: 'immediately', label: 'As soon as the variation is done' },
                    { value: 'with_next_claim', label: 'With the next progress claim' },
                    { value: 'on_completion', label: 'At completion' },
                ],
            },
            { key: 'payment_terms_days', label: 'Payment terms', type: 'select', section: 'Timing and payment', required: true, default: '14', options: PAYMENT_TERMS },

            jurisdictionQuestion('Governing law'),
        ],
    },

    // -----------------------------------------------------------------------
    // Tier 2. Refused. Present so the type grid can say no and say why, which
    // answers the question once. An empty draftModes list is the refusal.
    // -----------------------------------------------------------------------

    employment: {
        id: 'employment',
        label: 'Employment contract',
        description: 'Hiring someone as an employee rather than engaging a contractor.',
        icon: 'Briefcase',
        tier: 2,
        parties: [
            { roleKey: 'employee', label: 'Employee', signingRole: 'signer' },
            { roleKey: 'employer', label: 'Employer', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'An employment contract sits on top of the National Employment Standards and a modern award, and a term below either of them is void whether or not both sides signed it. The only remedy is back pay. Use an employment lawyer, or the Fair Work Ombudsman template for your award.',
    },

    guarantor: {
        id: 'guarantor',
        label: 'Personal guarantee',
        description: 'A director or third party standing personally behind another party debts.',
        icon: 'ShieldAlert',
        tier: 2,
        parties: [
            { roleKey: 'guarantor', label: 'Guarantor', signingRole: 'signer' },
            { roleKey: 'creditor', label: 'Creditor', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'A personal guarantee is routinely set aside where the guarantor did not have independent legal advice. The advice is the point of the document, so producing it without one is producing something that will not hold.',
    },

    prenuptial: {
        id: 'prenuptial',
        label: 'Binding financial agreement',
        description: 'A financial agreement between partners, before or during a relationship.',
        icon: 'HeartHandshake',
        tier: 2,
        parties: [
            { roleKey: 'party_one', label: 'First party', signingRole: 'signer' },
            { roleKey: 'party_two', label: 'Second party', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'A binding financial agreement under the Family Law Act is only binding if each party received independent legal advice and their lawyer signed a certificate saying so. Without both certificates a court sets it aside.',
    },

    small_business_loan: {
        id: 'small_business_loan',
        label: 'Small business loan',
        description: 'Lending money to, or borrowing money from, another business.',
        icon: 'Landmark',
        tier: 2,
        parties: [
            { roleKey: 'borrower', label: 'Borrower', signingRole: 'signer' },
            { roleKey: 'lender', label: 'Lender', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'Lending brings in the credit legislation, the unfair contract terms regime and, if anything secures it, the Personal Property Securities Register. A loan document that is not registered where it should be is an unsecured loan.',
    },

    lease: {
        id: 'lease',
        label: 'Lease',
        description: 'Renting premises, retail or commercial, to or from another party.',
        icon: 'Building',
        tier: 2,
        parties: [
            { roleKey: 'lessee', label: 'Tenant', signingRole: 'signer' },
            { roleKey: 'lessor', label: 'Landlord', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'Retail and commercial leases are governed state by state, each with its own disclosure statement, minimum term and outgoings rules. A lease drafted from a generic template is how a tenant loses an option to renew.',
    },

    partnership: {
        id: 'partnership',
        label: 'Partnership agreement',
        description: 'Going into business with someone as partners rather than through a company.',
        icon: 'Users',
        tier: 2,
        parties: [
            { roleKey: 'partner_one', label: 'First partner', signingRole: 'signer' },
            { roleKey: 'partner_two', label: 'Second partner', signingRole: 'signer' },
        ],
        draftModes: [],
        questions: [],
        refusedReason:
            'Partners are jointly and severally liable for the whole of the partnership debts, so each partner is exposed to everything the other one signs. How that is shared, and how a partner leaves, is not a form.',
    },
};

// ---------------------------------------------------------------------------
// Lookups. All fail closed on an unknown kind.
// ---------------------------------------------------------------------------

export function isEnvelopeKindId(v: unknown): v is EnvelopeKind {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CONTRACT_TYPES, v);
}

/** The registry entry, or null. Use this when an unknown kind is an expected answer. */
export function tryContractType(kind: string): ContractType | null {
    return isEnvelopeKindId(kind) ? CONTRACT_TYPES[kind] : null;
}

/** The registry entry. Throws rather than defaulting, so an unknown kind cannot land as tier 0. */
export function contractType(kind: string): ContractType {
    const t = tryContractType(kind);
    if (!t) throw new Error(`Unknown document kind: ${kind}`);
    return t;
}

/** Every type, in ENVELOPE_KINDS order, which is tier order. What the type grid renders. */
export function listContractTypes(): readonly ContractType[] {
    return ENVELOPE_KINDS.map((k) => CONTRACT_TYPES[k]);
}

export function partiesForKind(kind: string): readonly PartySlot[] {
    return contractType(kind).parties;
}

export function questionsForKind(kind: string): readonly QuestionField[] {
    return contractType(kind).questions;
}

export function iconForKind(kind: string): string {
    return contractType(kind).icon;
}

/**
 * Section headings in the order they first appear in the question array.
 *
 * Derived rather than declared. A separate ordered list of sections is a second
 * thing to keep in step with the first, and it drifts the first time someone
 * adds a question without scrolling up.
 */
export function sectionsForKind(kind: string): string[] {
    const seen: string[] = [];
    for (const q of contractType(kind).questions) {
        if (!seen.includes(q.section)) seen.push(q.section);
    }
    return seen;
}

/**
 * The questions to actually show, given what has been answered so far.
 *
 * A dependency always appears earlier in the array (the registry test enforces
 * it), so one pass is enough and a hidden parent correctly hides its children.
 */
export function visibleQuestions(kind: string, answers: EnvelopeAnswers): QuestionField[] {
    const visible = new Set<string>();
    const out: QuestionField[] = [];
    for (const q of contractType(kind).questions) {
        if (q.dependsOn) {
            // A dependency that is itself hidden cannot be satisfied: a declined
            // restraint must not leave its period asking from three levels down.
            if (!visible.has(q.dependsOn.key)) continue;
            if (answers[q.dependsOn.key] !== q.dependsOn.equals) continue;
        }
        visible.add(q.key);
        out.push(q);
    }
    return out;
}

/** Prefill for a fresh questionnaire. Only keys that declare a default appear. */
export function defaultAnswers(kind: string): EnvelopeAnswers {
    const out: EnvelopeAnswers = {};
    for (const q of contractType(kind).questions) {
        if (q.default !== undefined) out[q.key] = q.default;
    }
    return out;
}
