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
  actual_start_day: string;
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
 * `POST /rotations/blocks` — creates one academic block.
 *
 * Every field is required. The controller answers 409 for a duplicate
 * `block_number` within an `academic_year`, and 400 when `end_date` precedes
 * `start_date`.
 *
 * `week_start_day` is intentionally absent even though the column exists and
 * `GET /rotations/blocks` returns it: `RotationService.createBlock` does not
 * include it in its INSERT, so sending it is accepted and discarded. Adding it
 * here would advertise a field that cannot be saved.
 */
export interface CreateBlockPayload {
  program_id: number;
  academic_year: string;
  block_number: number;
  block_name: string;
  start_date: CalendarDateString;
  end_date: CalendarDateString;
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
