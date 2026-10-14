import type { Tone } from '../theme';

/**
 * The objective classification of a faculty preceptor, shared by every form and
 * roster that displays one.
 *
 * Three independent axes, deliberately kept separate and non-hierarchical:
 *
 *  - **Clinical Title** — the health system's professional rank. It says how
 *    senior a person is inside the hospital, not inside the training programme.
 *  - **Faculty Appointment** — the residency programme's accrediting category.
 *    This is the field an accreditation reviewer looks at.
 *  - **Administrative / Leadership Role** — an optional programme office a
 *    person holds, such as Programme Director.
 *
 * Being a Senior Consultant does not make someone a Core Faculty member, and
 * being a Programme Director does not make someone a Consultant. Keeping the
 * axes apart is what stops a roster from implying a supervision hierarchy the
 * programme never agreed to. There is intentionally no "teaching level allowed"
 * or "supervision authorisation tier" field: those invent a subjective ranking
 * that no institutional appointment establishes.
 */

export interface FacultySelectOption {
  value: string;
  label: string;
}

/** The health system's professional rank. */
export const CLINICAL_TITLE_OPTIONS: FacultySelectOption[] = [
  { value: 'Specialist', label: 'Specialist' },
  { value: 'Consultant', label: 'Consultant' },
  { value: 'Senior Consultant', label: 'Senior Consultant' },
  { value: 'Other', label: 'Other' },
];

/** The residency programme's formal appointment category. */
export const FACULTY_APPOINTMENT_OPTIONS: FacultySelectOption[] = [
  { value: 'Core Faculty', label: 'Core Faculty' },
  { value: 'Teaching Faculty', label: 'Teaching Faculty' },
  { value: 'Adjunct / Visiting Faculty', label: 'Adjunct / Visiting Faculty' },
];

/**
 * The programme office a person holds, if any.
 *
 * `None` is the stored value for "educator only"; the label spells that out so
 * the choice reads as an affirmative option rather than an empty one. Every
 * display path suppresses the badge when the value is `None`, so the roster
 * never prints a "None" badge.
 */
export const ADMINISTRATIVE_ROLE_OPTIONS: FacultySelectOption[] = [
  { value: 'None', label: 'None / General Educator' },
  { value: 'Program Director (PD)', label: 'Program Director (PD)' },
  { value: 'Associate Program Director (APD)', label: 'Associate Program Director (APD)' },
  { value: 'Continuity Clinic Lead', label: 'Continuity Clinic Lead' },
  { value: 'Rotation Director', label: 'Rotation Director' },
];

export const CLINICAL_TITLE_HINT = 'Professional rank within the health system.';
export const FACULTY_APPOINTMENT_HINT = 'Formal appointment under program accreditation rules.';
export const ADMINISTRATIVE_ROLE_HINT = 'Optional leadership role within the programme.';

/** The default specialty when a preceptor is added without one. */
export const DEFAULT_FACULTY_SPECIALTY = 'Family Medicine';

/** True when an administrative role is a real office rather than "None". */
export function hasAdministrativeRole(role: string | null | undefined): boolean {
  const value = (role ?? '').trim();
  return value !== '' && value.toLowerCase() !== 'none';
}

export interface FacultyBadge {
  label: string;
  tone: Tone;
}

/**
 * The subtle badges a roster row shows beside a preceptor's name.
 *
 * Only the two programme-facing axes are badged — the appointment and any real
 * administrative role. The clinical title stays out of the badge row: it is a
 * health-system rank, and turning it into a badge next to them would suggest a
 * precedence between the axes that does not exist.
 */
export function facultyBadges(input: {
  faculty_appointment?: string | null;
  administrative_role?: string | null;
}): FacultyBadge[] {
  return facultyBadgesFor(input.faculty_appointment, input.administrative_role);
}

/** The same badges, from already-camelCased parts, for in-memory option lists. */
export function facultyBadgesFor(
  facultyAppointment: string | null | undefined,
  administrativeRole: string | null | undefined,
): FacultyBadge[] {
  const badges: FacultyBadge[] = [];
  const appointment = (facultyAppointment ?? '').trim();
  if (appointment) badges.push({ label: appointment, tone: 'info' });
  if (hasAdministrativeRole(administrativeRole)) {
    badges.push({ label: (administrativeRole ?? '').trim(), tone: 'neutral' });
  }
  return badges;
}
