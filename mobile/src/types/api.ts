/**
 * Response shapes for the MedResidency API (src/server.js).
 *
 * Two MySQL-to-JSON quirks drive several of the types below:
 *  - `DECIMAL` columns (total_hours, assigned_weeks) are sent as JSON strings.
 *  - `DATE` columns are sent as a UTC instant at the server's local midnight,
 *    while the leave and release-letter queries DATE_FORMAT them to `YYYY-MM-DD`.
 *    Both forms are in use, so date fields are typed loosely as strings and
 *    normalised by `src/utils/format.ts`.
 */

/** A `DATETIME`/`DATE` column serialised as an ISO-8601 string. */
export type IsoDateString = string;

/** A `DATE` column serialised by `DATE_FORMAT(..., '%Y-%m-%d')`. */
export type CalendarDateString = string;

/** `DECIMAL` columns arrive as strings over JSON. */
export type DecimalString = string;

/** A MySQL numeric column that may arrive as either a JSON number or string. */
export type Numeric = number | DecimalString;

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface ApiListResponse<T> extends ApiResponse<T[]> {
  count: number;
}

/** The body returned for any 4xx/5xx. The request helper converts this to ApiError. */
export interface ApiErrorBody {
  success: false;
  error?: string;
  message?: string;
  details?: string;
}

/** `GET /health` — also used by Settings to prove the API is reachable. */
export interface HealthStatus {
  status: 'success' | 'error';
  server: string;
  timestamp: IsoDateString;
  database: {
    connected: boolean;
    database_name: string;
    database_time: IsoDateString;
  };
}

/** One row of `GET /residents` — the roster list, not the full profile. */
export interface ResidentListItem {
  resident_id: number;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  date_of_birth: IsoDateString;
  sex: string;
  nationality: string;
  citizenship_status: string;
  program_id: number | null;
  program_code: string | null;
  specialty_name: string | null;
  pgy_level: number | null;
  resident_status: string;
  created_at: IsoDateString;
}

/** `GET /rotations/blocks?program_id=`. */
export interface RotationBlock {
  block_id: number;
  program_id: number;
  program_code: string;
  week_start_day: string | null;
  academic_year: string;
  block_number: number;
  block_name: string;
  start_date: IsoDateString;
  end_date: IsoDateString;
  /**
   * `start_date`/`end_date` re-formatted as `YYYY-MM-DD`.
   *
   * The `*_date` fields above are raw MySQL DATE values, which arrive as JS
   * `Date` objects and are rendered in the device's timezone. A block that ends
   * "on Saturday" then prints as Friday for anyone west of UTC. The `_iso`
   * fields are formatted in SQL and are safe to compare and display directly.
   */
  start_date_iso: CalendarDateString | null;
  end_date_iso: CalendarDateString | null;
  /** `DAYNAME` of the real start date, e.g. "Sunday". */
  actual_start_day: string;
  /** `DAYNAME` of the real end date, e.g. "Saturday". */
  actual_end_day: string;
  /** Inclusive length in days; 28 for a four-week block. */
  block_days: number;
  /** Whole weeks the window spans; `null` when the window is not a clean block. */
  block_weeks: number | null;
}

/** `GET /rotations?program_id=` — the catalogue of possible rotations. */
export interface RotationDefinition {
  rotation_id: number;
  program_id: number;
  rotation_code: string;
  rotation_name: string;
  department_name: string | null;
  department_id: number | null;
  default_duration_weeks: number;
  is_active: number;
}

/**
 * One row of `GET /rotations/catalogue?program_id=`.
 *
 * The API speaks the catalogue's own field names — `full_name`, `department`,
 * `abbreviation` — which are the `rotation_name`, `department_name` and
 * `rotation_code` columns of the same `rotations` rows the master grid and the
 * assignment forms read. The extra two fields are carried through so a screen
 * never has to call a second endpoint to know whether a rotation is available.
 */
export interface RotationCatalogueEntry {
  id: number;
  program_id: number;
  full_name: string;
  department: string;
  abbreviation: string;
  default_duration_weeks: number;
  is_active: number;
  created_at: IsoDateString | null;
  updated_at: IsoDateString | null;
}

/** `POST /rotations/catalogue` / `PUT /rotations/catalogue/:id` — the form. */
export interface CatalogueRotationPayload {
  program_id: number;
  full_name: string;
  department: string;
  /** Sent upper-cased; the API enforces one per programme. */
  abbreviation: string;
}

export interface ResidentIdentifier {
  id: number;
  identifier_type: string;
  identifier_value: string;
  issuing_country: string | null;
  is_primary: number;
}

export interface ResidentEnrollment {
  id: number;
  resident_id: number;
  program_id: number;
  resident_status: string;
  position_type: string;
  year_in_program: number | null;
  start_date: IsoDateString | null;
  expected_completion_date: IsoDateString | null;
  started_program_at_year_one: number;
  previous_education_documented: number;
  prior_training_years: Numeric | null;
  comments: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
  program_code: string;
  specialty_name: string;
  week_start_day: string | null;
  standard_shift_hours: Numeric | null;
}

/** `GET /residents/:id` — the residents row plus identifiers and enrollments. */
export interface Resident {
  id: number;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  date_of_birth: IsoDateString;
  sex: string;
  nationality: string;
  citizenship_status: string;
  race_ethnicity: string | null;
  created_at: IsoDateString;
  updated_at: IsoDateString;
  identifiers: ResidentIdentifier[];
  enrollments: ResidentEnrollment[];
}

/** The `resident_status` values the edit form offers and the API accepts. */
export const RESIDENT_STATUSES = [
  'ACTIVE_FULL_TIME',
  'ACTIVE_PART_TIME',
  'LEAVE_OF_ABSENCE',
  'STARTED_OFF_CYCLE',
  'GRADUATED',
  'WITHDRAWN',
] as const;

export type ResidentStatus = (typeof RESIDENT_STATUSES)[number];

/**
 * `PUT /residents/:id` — the coordinator's edit form.
 *
 * Every field is optional; the API changes only what it receives. `email` and
 * `mobile` are stored as identifiers beside the corporate id, because the
 * `residents` table has no columns for them.
 */
export interface UpdateResidentPayload {
  first_name?: string;
  middle_initial?: string | null;
  last_name?: string;
  /** Selects which enrollment the PGY level and status apply to. */
  program_id?: number;
  pgy_level?: number;
  resident_status?: ResidentStatus | string;
  corporate_id?: string;
  email?: string;
  mobile?: string;
}

/** `DELETE /residents/:id` — `cascade` also removes attendance and rotation history. */
export interface DeleteResidentOptions {
  cascade?: boolean;
}

export type AssignmentType = 'FULL_BLOCK' | 'PARTIAL_BLOCK';

/** `GET /rotations/assignments/resident/:resident_id`. */
export interface RotationAssignment {
  assignment_id: number;
  resident_name: string;
  block_name: string;
  rotation_name: string;
  department_name: string | null;
  start_date: IsoDateString;
  end_date: IsoDateString;
  assigned_weeks: Numeric;
  assignment_type: AssignmentType;
  notes: string | null;
}

/** Mirrors the `attendance_status` enum on resident_attendance_logs. */
export const ATTENDANCE_STATUSES = [
  'PRESENT',
  'ABSENT',
  'ON_CALL',
  'SICK_LEAVE',
  'VACATION',
  'ANNUAL_LEAVE',
  'CASUAL_LEAVE',
  'EMERGENCY_LEAVE',
  'HAJJ_LEAVE',
  'ACADEMIC_LEAVE',
  'STUDY_LEAVE',
  'EXAM_LEAVE',
  'OTHER_LEAVE',
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** `GET /attendance/resident/:resident_id`. */
export interface AttendanceLog {
  log_id: number;
  resident_name: string;
  shift_date: IsoDateString;
  clock_in: IsoDateString | null;
  clock_out: IsoDateString | null;
  total_hours: Numeric | null;
  attendance_status: AttendanceStatus;
  other_leave_specify: string | null;
  is_flagged_for_breach: number;
  violation_rule: string | null;
  violation_severity: string | null;
  violation_details: string | null;
}

export interface LogAttendancePayload {
  resident_id: number;
  assignment_id?: number;
  /** `YYYY-MM-DD`. */
  shift_date: string;
  /** `YYYY-MM-DD HH:MM:SS` — the column is DATETIME, not TIME. */
  clock_in?: string;
  clock_out?: string;
  total_hours?: number;
  attendance_status: AttendanceStatus;
  other_leave_specify?: string;
  notes?: string;
}

/** `POST /attendance` — includes the duty-hour evaluation result. */
export interface LogAttendanceResult {
  log_id: number;
  resident_id: number;
  shift_date: string;
  total_hours: Numeric | null;
  attendance_status: AttendanceStatus;
  is_flagged_for_breach: boolean;
  breach_details: string | null;
  rule_evaluated: string;
}

/** Mirrors the `leave_type` enum on resident_leave_requests. */
export const LEAVE_TYPES = [
  'ANNUAL_LEAVE',
  'CASUAL_LEAVE',
  'SICK_LEAVE',
  'EMERGENCY_LEAVE',
  'HAJJ_LEAVE',
  'ACADEMIC_LEAVE',
  'STUDY_LEAVE',
  'EXAM_LEAVE',
  'OTHER_LEAVE',
] as const;

export type LeaveType = (typeof LEAVE_TYPES)[number];

/** Chief sign-off workflow: PENDING -> APPROVED_BY_CHIEF -> APPROVED. */
export const LEAVE_STATUSES = [
  'PENDING',
  'APPROVED_BY_CHIEF',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;

export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** `GET /leaves/resident/:resident_id`. */
export interface LeaveRequest {
  request_id: number;
  resident_name: string;
  leave_type: LeaveType;
  other_leave_specify: string | null;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
  total_days: number;
  reason: string | null;
  status: LeaveStatus;
  reviewed_by_user_id: number | null;
  rejection_reason: string | null;
  created_at: IsoDateString | null;
  updated_at: IsoDateString | null;
}

/** `GET/POST/PUT/DELETE /letters/templates` — release-letter templates. */
export interface LetterTemplate {
  id: number;
  program_id: number;
  template_code: string;
  template_name: string;
  letter_subject: string;
  letter_body: string;
  is_active: number;
  created_at: IsoDateString | null;
  updated_at: IsoDateString | null;
}

/** `POST/GET/PATCH /requests/rotation` — a resident asking to move rota. */
export type RotationRequestType = 'HOSPITAL' | 'CLINIC';

export type RotationRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface RotationRequest {
  request_id: number;
  resident_id: number;
  program_id: number;
  request_type: RotationRequestType;
  /** Department name for a hospital request, clinic name for a clinic one. */
  department_clinic: string;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
  reason: string | null;
  status: RotationRequestStatus;
  decision_reason: string | null;
  created_at: IsoDateString | null;
  decided_at: IsoDateString | null;
  /** Joined from `residents` by the API. */
  resident_name: string | null;
}

/** Mirrors the `sent_status` enum on generated_release_letters. */
export const LETTER_SENT_STATUSES = [
  'DRAFT',
  'GENERATED',
  'SENT',
  'ACKNOWLEDGED',
] as const;

export type LetterSentStatus = (typeof LETTER_SENT_STATUSES)[number];

/** `GET /letters/resident/:resident_id`. */
export interface ReleaseLetter {
  letter_id: number;
  resident_name: string;
  longitudinal_assignment_id: number;
  site_name: string | null;
  day_of_week: string | null;
  clinic_name: string;
  template_id: number;
  template_code: string;
  template_name: string;
  letter_subject: string;
  recipient_dept_head: string;
  hospital_department_name: string | null;
  generated_letter_body: string;
  sent_status: LetterSentStatus;
  sent_at: IsoDateString | null;
  created_at: IsoDateString | null;
  release_start_date: CalendarDateString;
  release_end_date: CalendarDateString;
}
/** `POST /leaves/request` — the body the resident form submits. */
export interface LeaveRequestPayload {
  resident_id: number;
  leave_type: LeaveType;
  /** Required by the API when leave_type is OTHER_LEAVE. */
  other_leave_specify?: string;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
  /** Optional; the server derives it from the date range when omitted. */
  total_days?: number;
  reason?: string;
}

/** `PATCH /leaves/:id/status` — the review decision. */
export interface LeaveStatusPayload {
  status: LeaveStatus;
  reviewed_by_user_id?: number;
  /** Required by the API when status is REJECTED. */
  rejection_reason?: string;
}

/** `POST /letters/generate` — mail-merges a release letter server-side. */
export interface GenerateLetterPayload {
  resident_id: number;
  longitudinal_assignment_id?: number;
  template_code?: string;
  /** DRAFT | GENERATED | SENT | ACKNOWLEDGED */
  sent_status?: LetterSentStatus;
}

/** `POST /rotations/assignments` — assigns a resident to a rotation block. */
export interface CreateAssignmentPayload {
  resident_id: number;
  rotation_id: number;
  rotation_block_id: number;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
  assigned_weeks?: number;
  assignment_type?: AssignmentType;
  notes?: string;
}

/**
 * `GET /rotations/blocks/dates` without a `start_date` — the programme's rules.
 *
 * These are what a form needs before a date has been chosen: which day the week
 * starts, therefore which day a block ends, and the length a block defaults to.
 */
export interface BlockCalendar {
  program_id: number;
  /** Canonical day name, e.g. "SUNDAY"; `null` when the programme records none. */
  week_start_day: string | null;
  /** The day before `week_start_day`: "Saturday" for a Sunday-start programme. */
  week_end_day: string | null;
  default_block_duration_weeks: number | null;
}

/**
 * `GET /rotations/blocks/dates` with a `start_date` — the derived window.
 *
 * `duration_weeks` is `null` when the window is not a whole number of weeks,
 * which is also what `errors` explains; the write is rejected with the same
 * wording, so a form can show the server's own sentence.
 */
export interface BlockCalendarWindow extends BlockCalendar {
  start_date: CalendarDateString | null;
  end_date: CalendarDateString | null;
  duration_weeks: number | null;
  starts_on: string | null;
  ends_on: string | null;
  /** `Sun 05 Jul - Sat 01 Aug 2026`, ready to show under a date field. */
  window_label: string | null;
  errors: string[];
}

/**
 * `POST /rotations/blocks` and `PUT /rotations/blocks/:id` — one academic block.
 *
 * Send **either** `end_date` **or** `duration_weeks`, never both: the server
 * re-derives the window from `programs.week_start_day` so that a block always
 * ends the day before its start (Sunday-start programmes end Saturday,
 * Monday-start programmes end Sunday) and rejects a window that contradicts the
 * duration it was asked for.
 *
 * `week_start_day` is intentionally absent: it belongs to the programme, not the
 * block, and the API reads it from `programs` rather than trusting a client to
 * restate it.
 *
 * On `PUT` only `start_date` is required to be supplied if a duration or end
 * date is also given; an omitted field keeps its stored value.
 */
export interface CreateBlockPayload {
  program_id: number;
  academic_year: string;
  block_number: number;
  block_name: string;
  start_date: CalendarDateString;
  /** Derives the end date. Omit when sending `duration_weeks`. */
  end_date?: CalendarDateString;
  /** Derives the end date as `start + weeks * 7 - 1`. Omit when sending `end_date`. */
  duration_weeks?: number;
}

/**
 * `POST /residents/onboard` — the coordinator's registration form.
 *
 * Nested to match the three inserts the API performs in one transaction:
 * the residents row, its legal identifiers, and its program enrollment.
 */
export interface OnboardResidentPayload {
  personal_info: {
    first_name: string;
    middle_initial?: string;
    last_name: string;
    /** `YYYY-MM-DD` */
    date_of_birth: string;
    sex: string;
    nationality: string;
    citizenship_status: string;
    race_ethnicity?: string;
  };
  identifiers: {
    identifier_type: string;
    identifier_value: string;
    issuing_country?: string;
    is_primary?: boolean;
  }[];
  enrollment?: {
    program_id: number;
    resident_status?: string;
    position_type?: string;
    year_in_program?: number;
    start_date?: string;
    expected_completion_date?: string;
    previous_education_documented?: boolean;
    prior_training_years?: number;
    comments?: string;
  };
}

/** The body `POST /residents/onboard` returns. */
export interface OnboardResidentResult {
  resident_id: number;
  enrollment_id: number | null;
  first_name: string;
  last_name: string;
  status: string;
}

export interface LongitudinalClinicType {
  id: number;
  program_id: number;
  clinic_code: string;
  clinic_name: string;
  default_day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  requires_release_letter: number;
  is_active: number;
}

export interface LongitudinalAssignment {
  longitudinal_assignment_id: number;
  resident_id: number;
  clinic_type_id: number;
  clinic_code: string;
  clinic_name: string;
  site_name: string | null;
  supervisor_name: string | null;
  faculty_supervisor_id: number | null;
  day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  start_date: CalendarDateString | IsoDateString | null;
  end_date: CalendarDateString | IsoDateString | null;
  is_active: number;
  requires_release_letter?: number;
  release_letter_generated?: number;
  notes?: string | null;
  pgy_level?: number | null;
  resident_name?: string;
}

export interface FacultySupervisor {
  id: number;
  program_id: number;
  first_name: string;
  last_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_active: number;
}

export interface LongitudinalClinicSlot {
  id: number;
  clinic_type_id: number;
  slot_number: number;
  slot_label: string;
  day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  site_name: string | null;
  notes: string | null;
  is_active: number;
}

export interface LongitudinalSupervisorAssignment {
  id: number;
  program_id: number;
  clinic_type_id: number;
  clinic_code: string;
  clinic_name: string;
  longitudinal_assignment_id: number | null;
  longitudinal_clinic_slot_id: number | null;
  faculty_supervisor_id: number;
  faculty_supervisor_name: string;
  faculty_title: string | null;
  resident_id: number | null;
  resident_name: string | null;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
  rotation_period_months: number;
  is_primary: number;
  is_active: number;
  notes: string | null;
}

/**
 * `GET /rotations/assignments/cohort` — one row per resident per academic block.
 *
 * The query is driven from `rotation_blocks` and LEFT JOINed to assignments, so
 * the row grain is resident/block and *every* cell is present: an unassigned cell
 * arrives as a row whose assignment columns are null and `is_assigned` is 0.
 * A cell can also hold more than one assignment (a partial block split across
 * two rotations), which `assignment_count` reports so a client pivoting
 * residents-by-blocks can tell a split block from a duplicated row.
 *
 * `academic_year` comes back in the canonical hyphenated form ("2026-2027")
 * whatever shape the caller sent, so a client must never compare it against its
 * own "2026/2027" string.
 */
export interface CohortGridCell {
  resident_id: number;
  resident_name: string;
  first_name: string;
  last_name: string;
  /** The resident's primary identifier, i.e. their employee id. */
  employee_id: string | null;
  /**
   * The resident's contact number, when one is recorded.
   *
   * `residents` has no phone column; this resolves the first identifier whose
   * type looks like a phone number and is `null` for every resident until that
   * data exists. The grid renders "Not recorded" rather than hiding the column.
   */
  contact_number: string | null;
  pgy_level: number | null;
  resident_status: string;
  program_id: number;
  program_code: string;
  week_start_day: string | null;
  block_id: number;
  block_number: number;
  block_name: string;
  academic_year: string;
  block_start_date: IsoDateString;
  block_end_date: IsoDateString;
  /** Timezone-safe `YYYY-MM-DD` copies of the block window. */
  block_start_date_iso: CalendarDateString;
  block_end_date_iso: CalendarDateString;
  block_start_day: string;
  block_end_day: string;
  block_days: number;
  assignment_id: number | null;
  rotation_id: number | null;
  rotation_code: string | null;
  rotation_name: string | null;
  department_name: string | null;
  start_date: IsoDateString | null;
  end_date: IsoDateString | null;
  assignment_start_date_iso: CalendarDateString | null;
  assignment_end_date_iso: CalendarDateString | null;
  assigned_weeks: Numeric | null;
  assignment_type: AssignmentType | null;
  notes: string | null;
  /** MySQL boolean expression: 1 when the cell has an assignment, 0 when not. */
  is_assigned: number;
  /** How many assignments share this resident/block cell. */
  assignment_count: number;
}

export interface RotationAssignmentDetail {
  assignment_id: number;
  resident_id: number;
  resident_name: string;
  first_name: string;
  last_name: string;
  middle_initial: string | null;
  employee_id: string | null;
  phone_mobile: string | null;
  pgy_level: number | null;
  block_id: number;
  block_name: string;
  block_number: number;
  academic_year: string;
  block_start_date: IsoDateString;
  block_end_date: IsoDateString;
  rotation_id: number;
  rotation_name: string;
  department_name: string | null;
  rotation_code: string;
  start_date: IsoDateString;
  end_date: IsoDateString;
  assigned_weeks: Numeric;
  assignment_type: AssignmentType;
  notes: string | null;
}
