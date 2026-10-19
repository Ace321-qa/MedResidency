/**
 * The reasons a resident is offered for requesting a rotation.
 *
 * A blank reason field was the easy thing to build and the hardest to triage:
 * the Approvals queue ended up with a column of empty reasons, and the
 * coordinator's only context was a block number. These seven options are the
 * vocabulary residents actually use, chosen so that choosing one is both
 * quicker than typing a sentence and more useful to read.
 *
 * They are data rather than inline config because the label, the explanation
 * and the option id must stay in step with the payload they produce, and
 * because the coordinator's queue has to be able to filter on the id.
 *
 * There is one set per request type — a block rotation and a clinic session are
 * different asks, and the coordinator filters on the exact stored string.
 */

/** The option that is not an option: it opens a text field instead. */
export const OTHER_REASON = 'OTHER';

/** Its label, exported so the chip and the prose around it cannot drift apart. */
export const OTHER_REASON_LABEL = 'Other (Specify below)';

/** The value sent as `reason` when the resident picked "Other" and typed. */
export const OTHER_REASON_PREFIX = 'Other: ';

export interface ReasonOption {
  /** The value sent as `reason` when this option is chosen. */
  readonly value: string;
  /** Short label for the pill / radio row. */
  readonly label: string;
  /** One-line explanation shown underneath — why a coordinator cares. */
  readonly hint: string;
}

export const REASON_OPTIONS: readonly ReasonOption[] = [
  {
    value: 'Mandatory Core Rotation',
    label: 'Mandatory Core Rotation',
    hint: 'Core requirement for programme progression.',
  },
  {
    value: 'Elective / Subspecialty Exploration',
    label: 'Elective / Subspecialty Exploration',
    hint: 'Career interest or fellowship preparation.',
  },
  {
    value: 'Remediation / Off-Cycle Catchup',
    label: 'Remediation / Off-Cycle Catchup',
    hint: 'Fulfilling required block coverage.',
  },
  {
    value: 'Research / Scholarly Activity',
    label: 'Research / Scholarly Activity',
    hint: 'Dedicated research block or academic project.',
  },
  {
    value: 'Out-of-Program / External Attachment',
    label: 'Out-of-Program / External Attachment',
    hint: 'Specialised training at an external site.',
  },
  {
    value: 'Personal / Family Circumstances',
    label: 'Personal / Family Circumstances',
    hint: 'Location or scheduling request due to personal needs.',
  },
] as const;

/**
 * The reasons offered for a **clinic** request.
 *
 * A clinic request is a different ask from a hospital rotation: the resident is
 * filling a longitudinal / primary-care requirement, not covering a block, so
 * "Out-of-Program / External Attachment" is not a clinic reason and
 * "Personal / Scheduling Alignment" is. The two lists are kept apart rather than
 * merged because the coordinator filters the queue on the exact string — mixing
 * them would make one filter chip mean two different things.
 */
export const CLINIC_REASON_OPTIONS: readonly ReasonOption[] = [
  {
    value: 'Mandatory Core Clinic Requirement',
    label: 'Mandatory Core Clinic Requirement',
    hint: 'Fulfilling the required ACGME / institutional clinic block.',
  },
  {
    value: 'Elective / Subspecialty Focus',
    label: 'Elective / Subspecialty Focus',
    hint: 'Deepening skills in a specialised outpatient clinic.',
  },
  {
    value: 'Remediation / Off-Cycle Catchup',
    label: 'Remediation / Off-Cycle Catchup',
    hint: 'Completing required clinical shift hours.',
  },
  {
    value: 'Research / Scholarly Activity',
    label: 'Research / Scholarly Activity',
    hint: 'Dedicated research block or clinical project.',
  },
  {
    value: 'Personal / Scheduling Alignment',
    label: 'Personal / Scheduling Alignment',
    hint: 'Shift alignment or personal circumstances.',
  },
] as const;

/**
 * The presets for a request type.
 *
 * Exported as a function so the screen, the hint and any future queue filter
 * all read one switch instead of each remembering which list applies where.
 */
export function reasonOptionsFor(requestType: 'HOSPITAL' | 'CLINIC'): readonly ReasonOption[] {
  return requestType === 'CLINIC' ? CLINIC_REASON_OPTIONS : REASON_OPTIONS;
}

/** Every option a resident can pick, including the one that asks them to type. */
export const ALL_REASON_VALUES: readonly string[] = [
  ...REASON_OPTIONS.map((option) => option.value),
  ...CLINIC_REASON_OPTIONS.map((option) => option.value),
  OTHER_REASON,
] as const;

/**
 * The `reason` actually stored on the request row.
 *
 * A preset is sent verbatim so the queue can filter on the exact string. "Other"
 * is prefixed so a coordinator reading the queue can tell it from a preset that
 * happened to be typed by hand.
 *
 * @param selected The `value` of the picked option, or `''` when nothing is picked.
 * @param customText The free-text reason, only relevant when `selected` is `OTHER_REASON`.
 */
export function buildReason(selected: string, customText?: string): string | undefined {
  if (selected === OTHER_REASON) {
    const text = (customText ?? '').trim();
    return text === '' ? undefined : `${OTHER_REASON_PREFIX}${text}`;
  }
  return selected.trim() === '' ? undefined : selected.trim();
}
