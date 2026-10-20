import type {
  RotationNoticeDepartment,
  RotationNoticePlan,
  RotationNoticeResident,
  RotationNoticeDispatchResult,
} from '../types/api';

/**
 * Pure helpers for the "Send Notice Letter" confirmation.
 *
 * Kept out of the screen because these are the numbers a coordinator reads
 * before agreeing to send letters to departments outside their own programme.
 * A summary that miscounts is worse than no summary, so the arithmetic is
 * something a verifier can pin down rather than something buried in JSX.
 */

/**
 * The residents a run would notify, de-duplicated by id.
 *
 * A resident split across two rotations in one block has two assignments and
 * therefore two letters, but must still receive *one* in-app notification —
 * counting rows rather than people would tell the coordinator they are about to
 * notify more residents than exist.
 */
export function uniqueResidentCount(plan: Pick<RotationNoticePlan, 'residents'> | null): number {
  if (!plan) return 0;
  return new Set(plan.residents.map((resident) => resident.resident_id)).size;
}

/** How many letters the run would store: one per assignment, not per resident. */
export function plannedLetterCount(plan: Pick<RotationNoticePlan, 'targets'> | null): number {
  return plan ? plan.targets.length : 0;
}

/**
 * Departments that would receive a letter with no address attached.
 *
 * Surfaced separately from the total because it is the one number that changes
 * what the coordinator is deciding: the letters are still stored and logged, but
 * nothing reaches those departments.
 */
export function departmentsWithoutRecipient(
  departments: RotationNoticeDepartment[] | null | undefined,
): RotationNoticeDepartment[] {
  if (!departments) return [];
  return departments.filter((department) => !department.has_recipient);
}

/** A `Block N` label list, e.g. "Block 5" or "Blocks 5, 6, 7". */
export function describeBlockNumbers(blockNumbers: number[] | null | undefined): string {
  const numbers = [...new Set(blockNumbers ?? [])]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((a, b) => a - b);
  if (numbers.length === 0) return 'this view';
  if (numbers.length === 1) return `Block ${numbers[0]}`;
  return `Blocks ${numbers.join(', ')}`;
}

/**
 * Whether the send button may be pressed, and why not when it may not.
 *
 * A draft block is a refusal rather than a warning: the whole point of
 * finalization is that a schedule still being edited must not be announced to
 * other hospitals. An empty plan is also a refusal — there is nothing to send,
 * and a "sent 0 letters" success would read as a completed dispatch.
 */
export function describeSendReadiness(
  plan: Pick<RotationNoticePlan, 'targets' | 'draft_block_ids'> | null,
  options: { sendToCoordinators: boolean; notifyResidents: boolean },
): { ready: boolean; reason: string | null } {
  if (!plan) return { ready: false, reason: null };
  if (!options.sendToCoordinators && !options.notifyResidents) {
    return { ready: false, reason: 'Choose at least one recipient group to send to.' };
  }
  if (plan.targets.length === 0) {
    return { ready: false, reason: 'No scheduled assignments in this view, so there is nothing to send.' };
  }
  if (plan.draft_block_ids.length > 0) {
    return {
      ready: false,
      reason: `${describeBlockNumbers(plan.draft_block_ids)} still draft. Finalize the block before sending notices.`,
    };
  }
  return { ready: true, reason: null };
}

/**
 * One line per department for the confirmation list.
 *
 * Sorted by resident count descending so the departments carrying the most
 * residents — the ones most worth checking before sending — lead the list.
 */
export function describeDepartmentRows(
  departments: RotationNoticeDepartment[] | null | undefined,
): { label: string; detail: string; warning: boolean }[] {
  if (!departments) return [];
  return [...departments]
    .sort((a, b) => b.resident_count - a.resident_count || a.department_name.localeCompare(b.department_name))
    .map((department) => ({
      label: department.department_name,
      detail: `${department.resident_count} resident${department.resident_count === 1 ? '' : 's'}`,
      warning: !department.has_recipient,
    }));
}

/** A compact outcome line for the result banner. */
export function describeDispatchOutcome(result: RotationNoticeDispatchResult): string {
  const parts: string[] = [];
  if (result.send_to_coordinators) {
    parts.push(
      `${result.letters_sent} letter${result.letters_sent === 1 ? '' : 's'} stored for ${result.departments.length} department${result.departments.length === 1 ? '' : 's'}`,
    );
  }
  if (result.notify_residents) {
    parts.push(
      `${result.residents_notified} resident${result.residents_notified === 1 ? '' : 's'} notified`,
    );
  }
  if (parts.length === 0) return 'Nothing was sent.';
  return `${parts.join('; ')}.`;
}

/**
 * A resident's assignment count, for the plan list.
 *
 * A resident with more than one assignment in the view gets more than one
 * letter; saying so prevents the count of residents and the count of letters
 * from looking like a contradiction.
 */
export function describeResidentRows(
  residents: RotationNoticeResident[] | null | undefined,
): { label: string; detail: string }[] {
  if (!residents) return [];
  return residents.map((resident) => ({
    label: resident.resident_name,
    detail:
      resident.assignment_count > 1
        ? `${resident.pgy_level ?? 'PGY level not recorded'} · ${resident.assignment_count} assignments`
        : resident.pgy_level ?? 'PGY level not recorded',
  }));
}
