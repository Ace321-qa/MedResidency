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

/** Every option a resident can pick, including the one that asks them to type. */
export const ALL_REASON_VALUES: readonly string[] = [
  ...REASON_OPTIONS.map((option) => option.value),
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
