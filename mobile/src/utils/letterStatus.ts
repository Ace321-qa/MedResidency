import type { Tone } from '../theme';
import type { LetterSentStatus, ReleaseLetter } from '../types/api';
import { unresolvedPlaceholders } from './letterPreview';

/**
 * Shared presentation rules for a generated release letter.
 *
 * The resident's profile and the coordinator's dispatch log render the same
 * rows from the same endpoint, so the status colour, the destination name and
 * the "still carries {{TOKEN}}" warning all live here once rather than being
 * re-derived (and drifting) in each screen.
 */

/** Mirrors the `sent_status` lifecycle. REVOKED is a superseded letter. */
export const LETTER_STATUS_TONE: Record<LetterSentStatus, Tone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  DELIVERED: 'success',
  REVOKED: 'danger',
};

export function letterStatusTone(status: LetterSentStatus): Tone {
  return LETTER_STATUS_TONE[status] ?? 'neutral';
}

/**
 * What the letter releases the resident *to*. A clinic-anchored letter names the
 * clinic; a rotation-anchored one names the rotation. Used as the row title.
 */
export function letterDestinationName(letter: ReleaseLetter): string {
  return letter.clinic_name ?? letter.rotation_name ?? 'Release letter';
}

/**
 * Whether a stored letter still carries `{{TOKEN}}` markers. The list endpoint
 * does not return `unresolved_placeholders`, so the body is checked here: a
 * letter with one is not ready to be signed, and that has to be visible before
 * the resident opens it — not after.
 */
export function hasUnresolvedFields(letter: ReleaseLetter): boolean {
  return unresolvedPlaceholders(letter.generated_letter_body).length > 0;
}
