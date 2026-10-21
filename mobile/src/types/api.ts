/**
 * Response shapes for the MedResidency API (src/server.js).
 *
 * Two MySQL-to-JSON quirks drive several of the types below:
 *  - `DECIMAL` columns (total_hours, assigned_weeks) are sent as JSON strings.
 *  - `DATE` columns are sent as a UTC instant at the server's local midnight,
 *    while the leave and release-letter queries DATE_FORMAT them to `YYYY-MM-DD`.
 *    Both forms are in use, so date fields are typed loosely as strings and
 *    normalised by `src/utils/format.ts`.
 *
 * Duty-hour clock values are the exception: they are DATE_FORMATted to
 * `YYYY-MM-DD HH:MM` so no seconds and no timezone ever reach the client.
 */

/** A `DATETIME`/`DATE` column serialised as an ISO-8601 string. */
export type IsoDateString = string;

/** A `DATE` column serialised by `DATE_FORMAT(..., '%Y-%m-%d')`. */
export type CalendarDateString = string;

/** A `DATETIME` column serialised by `DATE_FORMAT(..., '%Y-%m-%d %H:%i')`. */
export type MinuteDateTimeString = string;

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
  /**
   * The resident's corporate id, email and mobile, resolved from
   * `resident_identifiers` by the list query. They are `null` until such an
   * identifier has been recorded, and back the roster card and its search box.
   */
  corporate_id?: string | null;
  email?: string | null;
  mobile?: string | null;
}

/** `GET /programs` and the create/update responses. */
export interface Program {
  id: number;
  program_code: string;
  program_name: string;
  specialty_name: string | null;
  institution_name: string | null;
  coordinator_email: string | null;
  /** 1 = offered on the sign-in picker, 0 = deactivated. */
  is_active: number;
  /** Actively enrolled residents (`ACTIVE_FULL_TIME` / `ACTIVE_PART_TIME`). */
  resident_count: number;
  created_at: IsoDateString;
  updated_at: IsoDateString;
}

/** Body of `POST /programs`. `name` and `code` are the only required fields. */
export interface CreateProgramPayload {
  program_name: string;
  program_code: string;
  coordinator_email: string;
  specialty_name?: string | null;
  institution_name?: string | null;
  country_code?: string | null;
  is_active?: number;
}

/** Body of `PUT /programs/:id` — every field optional, only what changed. */
export interface UpdateProgramPayload {
  program_name?: string;
  program_code?: string;
  coordinator_email?: string;
  specialty_name?: string | null;
  institution_name?: string | null;
  is_active?: number;
}

/** `DELETE /programs/:id` — reports whether the row was removed or deactivated. */
export interface DeleteProgramResult {
  id: number;
  deleted: boolean;
  deactivated: boolean;
  resident_count: number;
  program: Program | null;
}

/** The kinds of partnership a programme may declare. Mirrors the server enum. */
export type ProgramConnectionType =
  | 'HOSPITAL_ROTATION'
  | 'CLINIC_EXCHANGE'
  | 'ACADEMIC_PARTNERSHIP';

/** One declared partnership between two programmes. */
export interface ProgramConnection {
  id: number;
  source_program_id: number;
  source_program_name: string;
  source_program_code?: string;
  target_program_id: number;
  target_program_name: string;
  target_program_code?: string;
  connection_type: ProgramConnectionType;
  /** 1 = active, 0 = withdrawn. */
  is_active: number;
  created_at?: IsoDateString;
}

/** A programme as a node on the citywide map, with its place and its traffic. */
export interface NetworkNode {
  id: number;
  program_code: string;
  program_name: string;
  specialty_name: string | null;
  institution_name: string | null;
  resident_count: number;
  /** Percentage coordinates (0–100), so the layout scales to any screen. */
  position: { x: number; y: number };
  /** Residents from this programme currently posted into another programme. */
  residents_out: number;
  /** Residents from other programmes currently posted into this one. */
  residents_in: number;
  partner_count: number;
}

/**
 * A cross-programme posting actually standing today: residents enrolled in one
 * programme and assigned to a rotation owned by another. Derived, never stored.
 */
export interface NetworkCrossRotation {
  home_program_id: number;
  home_program_name: string;
  host_program_id: number;
  host_program_name: string;
  resident_count: number;
  assignment_count: number;
  rotation_names: string[];
  department_names: string[];
  latest_block_number: number | null;
}

/** `GET /programs/network` — the whole city at a glance. */
export interface ResidencyNetwork {
  nodes: NetworkNode[];
  connections: ProgramConnection[];
  cross_rotations: NetworkCrossRotation[];
  totals: {
    programmes: number;
    connections: number;
    cross_rotations: number;
    residents_on_cross_rotation: number;
  };
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
   * Whether the coordinator has declared this block's schedule settled.
   *
   * A draft block may still be edited; only a finalized block's notices are
   * meant to be dispatched. Optional so fixtures written before finalization
   * existed still type-check — absent is read as "draft", which is the safe
   * default, because treating an unmarked block as sendable is the mistake this
   * flag exists to prevent.
   */
  is_finalized?: number | boolean | null;
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
  /** Departmental seat limit; `null` or `0` means unlimited. */
  max_capacity?: number | null;
  /** True when the limit is a hard departmental stop no rationale can clear. */
  capacity_locked?: number;
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
  /**
   * The registered programme account this rotation is hosted by — e.g. the
   * Internal Medicine Residency Program behind an "Internal Medicine" ward
   * rotation. `null` for a rotation that is not linked to any programme (every
   * rotation before this column existed, and anything created by the Excel
   * import), which is why the picker can be left empty.
   */
  target_program_id?: number | null;
  full_name: string;
  department: string;
  abbreviation: string;
  default_duration_weeks: number;
  is_active: number;
  /** Departmental seat limit; `null` or `0` means unlimited. */
  max_capacity: number | null;
  /** 1 when the limit is a hard departmental stop. */
  capacity_locked: number;
  coordinator_email: string | null;
  created_at: IsoDateString | null;
  updated_at: IsoDateString | null;
}

/** `POST /rotations/catalogue` / `PUT /rotations/catalogue/:id` — the form. */
export interface CatalogueRotationPayload {
  program_id: number;
  full_name: string;
  department: string;
  /** The programme the rotation is hosted by; `null` or omitted means none. */
  target_program_id?: number | null;
  /** Sent upper-cased; the API enforces one per programme. */
  abbreviation: string;
  /** `null` or omitted means unlimited. */
  max_capacity?: number | null;
  /** Locks the limit so no exception can clear it. */
  capacity_locked?: boolean;
  coordinator_email?: string | null;
}

/**
 * One weekly occupancy verdict from the seat-limit engine.
 *
 * Mirrors `src/utils/occupancy.js` on the server, which is the authority: this
 * type describes what the API already decided, not a rule the client re-derives.
 */
export interface OccupancyWeek {
  week_start: CalendarDateString;
  week_end: CalendarDateString;
  count: number;
  over_by: number;
}

export type OccupancyStatus = 'GREEN' | 'AMBER' | 'REVIEW' | 'RED' | 'BLOCKED';

export interface CapacityVerdict {
  status: OccupancyStatus;
  capacity: number | null;
  locked: boolean;
  allowed: boolean;
  requires_exception: boolean;
  peak: number;
  peak_weeks: string[];
  over_by: number;
  sustained_weeks: number;
  weeks: OccupancyWeek[];
  worst_week: OccupancyWeek | null;
  message: string;
  /** Present on the preview endpoint, which echoes the rotation it checked. */
  rotation_id?: number;
  rotation_name?: string;
  department_name?: string | null;
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
  /**
   * The block's sequence number — the safe thing to label a rotation with.
   * `block_name` beside it is coordinator-typed free text and has held a
   * rotation category ("Pediatrics"), so screens read `block_number` first and
   * only fall back to the name when there is no number.
   */
  block_number: number | null;
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
  clock_in: MinuteDateTimeString | null;
  clock_out: MinuteDateTimeString | null;
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
  /**
   * `YYYY-MM-DD HH:MM` (seconds are discarded server-side). A bare `HH:MM`
   * is accepted too and paired with `shift_date`.
   */
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

/**
 * One calendar day of a timesheet.
 *
 * `clock_in` / `clock_out` are bare `HH:MM` times on `shift_date` (a legacy
 * `YYYY-MM-DD HH:MM` is accepted too, and a bare `HH:MM` is paired with the
 * date). `24:00` is the end of the day, so an overnight shift is sent as two
 * rows — `08:00 → 24:00` then the next day's `00:00 → 08:00`.
 */
export interface TimesheetRowInput {
  shift_date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  total_hours?: number | null;
  attendance_status: AttendanceStatus;
  /** Required by the API when the status is `OTHER_LEAVE`. */
  other_leave_specify?: string | null;
  notes?: string | null;
}

/** A continuous-duty period the batch write found to run past the rule cap. */
export interface DutyHourBreach {
  /** First calendar day of the chain, where the violation is recorded. */
  anchor_log_id: number;
  total_hours: number;
  /** How many calendar rows the chain spans. */
  rows: number;
  details: string;
}

/** `POST /attendance/batch`. */
export interface LogTimesheetBatchResult {
  added: number[];
  count: number;
  /** Every row id that belongs to a breaching chain. */
  flagged: number[];
  breaches: {
    flagged: number[];
    violations: DutyHourBreach[];
  };
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
  /**
   * Optional programme-wide defaults the merge falls back on when a dispatch
   * does not name its own officials / destination preceptor.
   */
  coordinator_name?: string | null;
  program_director_name?: string | null;
  destination_supervising_faculty?: string | null;
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
  /**
   * The catalogue rotation behind the request, when the resident picked one
   * from the list rather than typing a department. Nullable, because a typed
   * department has no row to point at yet — approval matches it by name then.
   */
  rotation_id: number | null;
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
export const LETTER_SENT_STATUSES = ['DRAFT', 'SENT', 'DELIVERED', 'REVOKED'] as const;

export type LetterSentStatus = (typeof LETTER_SENT_STATUSES)[number];

/**
 * `GET /letters/resident/:resident_id` and `GET /letters?program_id=`.
 *
 * A letter is anchored to either a clinic assignment or a rotation assignment,
 * so the clinic fields are nullable and a rotation-anchored letter carries
 * `rotation_name` instead. Both shapes arrive through the same endpoint — the
 * resident's list and the coordinator's dispatch log are the same rows.
 */
export interface ReleaseLetter {
  letter_id: number;
  resident_name: string;
  longitudinal_assignment_id: number | null;
  rotation_assignment_id: number | null;
  site_name: string | null;
  day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  supervisor_name: string | null;
  clinic_name: string | null;
  rotation_name: string | null;
  year_in_program: number | null;
  program_name: string | null;
  specialty_name: string | null;
  institution_name: string | null;
  template_id: number;
  template_code: string;
  template_name: string;
  /**
   * Which programme merged this letter (its template), i.e. the *sender*.
   * In the Sent box this is the signed-in programme; in the Inbox it names
   * the partner programme whose notice arrived, and the two companion fields
   * back the "From" line on an inbox row.
   */
  dispatching_program_id?: number | null;
  dispatching_program_name?: string | null;
  dispatching_program_code?: string | null;
  /** The programme owning the rotation this letter is anchored to (the host). */
  host_program_id?: number | null;
  /** The resident's home programme from their latest enrolment. */
  resident_program_id?: number | null;
  /**
   * The dual-inbox mailbox this row is filed in. `mailbox_program_id` is the
   * row's owner — for an inbox copy that is the *receiving* programme, not the
   * one whose template merged the letter — and `mailbox_folder` is 'SENT' or
   * 'INBOX'.
   */
  mailbox_program_id?: number | null;
  mailbox_folder?: string | null;
  /** Which action produced the row, e.g. `FINALIZED_MASTER_GRID`. */
  dispatch_type?: string | null;
  recipient_coord_email?: string | null;
  sent_by_user_id?: number | null;
  letter_subject: string;
  recipient_dept_head: string;
  hospital_department_name: string | null;
  /** Hospital preceptor supervising the resident during the rotation, when assigned. */
  supervising_faculty: string | null;
  /**
   * The preceptor supervising the resident at the *receiving* hospital
   * department — the destination-side counterpart of the programme's own
   * `supervisor_name`. Prefer this over `supervising_faculty`.
   */
  destination_supervising_faculty: string | null;
  /** Name of the Program Coordinator who dispatched the letter. */
  coordinator_name: string | null;
  /** Name of the dispatching Program Director. */
  program_director_name: string | null;
  /** The day the letter was issued — today when generated, never the rotation start. */
  letter_issue_date: CalendarDateString | null;
  generated_letter_body: string;
  sent_status: LetterSentStatus;
  sent_at: IsoDateString | null;
  created_at: IsoDateString | null;
  /** Always present: a letter is anchored to at least one dated assignment. */
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
  /** Anchor the letter to the weekly clinic release. Auto-resolved when both ids are omitted. */
  longitudinal_assignment_id?: number;
  /** Anchor the letter to a hospital rotation instead (or as well). */
  rotation_assignment_id?: number;
  template_code?: string;
  template_id?: number;
  /** Recipient department head / chair the letter is addressed to. */
  recipient_dept_head?: string;
  hospital_department_name?: string;
  /** Optional hospital preceptor supervising the resident on this rotation. */
  supervising_faculty?: string;
  /** Preceptor supervising the resident at the receiving department (destination side). */
  destination_supervising_faculty?: string;
  /** Date of dispatch, `YYYY-MM-DD`. Defaults to today — not the release start date. */
  letter_issue_date?: CalendarDateString;
  /** Program Coordinator sending the letter; fills `{{COORDINATOR_NAME}}`. */
  coordinator_name?: string;
  /** Program Director of the dispatching programme; fills `{{PROGRAM_DIRECTOR_NAME}}`. */
  program_director_name?: string;
  /** DRAFT | SENT | DELIVERED | REVOKED. Defaults to SENT (dispatched). */
  sent_status?: LetterSentStatus;
  /** Supersede a live letter already issued for the same assignment. */
  regenerate?: boolean;
}

/** The merged letter, exactly as it will be stored, returned by generate and preview. */
export interface MergedLetterResult {
  letter_id?: number;
  supersedes_letter_id?: number | null;
  existing_letter_id?: number | null;
  resident_id: number;
  resident_name: string;
  pgy_level: string | null;
  longitudinal_assignment_id: number | null;
  rotation_assignment_id: number | null;
  template_id: number;
  template_code: string;
  template_name: string;
  recipient_dept_head: string | null;
  hospital_department_name: string | null;
  supervising_faculty: string | null;
  destination_supervising_faculty: string | null;
  coordinator_name: string | null;
  program_director_name: string | null;
  letter_issue_date: CalendarDateString | null;
  sent_status?: LetterSentStatus;
  letter_subject: string;
  generated_letter_body: string;
  merge_values: Record<string, string | null>;
  unresolved_placeholders: string[];
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
  /**
   * The exception that excuses an over-capacity placement, required by the API
   * whenever the verdict is AMBER, REVIEW or RED. All three parts are needed:
   * the reason says what the exception was, the approver says who owns it, and
   * the faculty confirmation is the educational half of the same question.
   */
  exception_reason?: string;
  exception_approver?: string;
  faculty_supervision_confirmed?: boolean;
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
 * `POST /rotations/blocks/generate` — complete an academic year's calendar.
 *
 * Idempotent: running it on a complete year returns `created: []`. `skipped`
 * lists a block number the server refused to guess dates for because the gap
 * was too small — never silently overlapped.
 */
export interface GenerateBlocksResult {
  academic_year: string;
  duration_weeks: number;
  created: Pick<RotationBlock, 'block_id' | 'block_number' | 'block_name' | 'start_date' | 'end_date'>[];
  skipped: number[];
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
  /**
   * Stable matrix column position. Each active clinic maps to one clinic column
   * and the slot stored at `primary_care_clinic_slots.clinic_number` equal to
   * this order, so renaming a clinic never moves its column and deleting one
   * never re-numbers the rest.
   */
  display_order?: number | null;
  default_day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  requires_release_letter: number;
  is_active: number;
  /**
   * 1 when the clinic was created by cloning the standard CCC grid, in which
   * case it owns a full matrix of its own (`primary_care_cycles.clinic_type_id`).
   */
  is_template_clone?: number | null;
  /** The template a clone was copied from, e.g. `CCC`. */
  source_template_code?: string | null;
  /** The name the coordinator typed when cloning. */
  custom_clinic_name?: string | null;
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
  clinical_title: string | null;
  faculty_appointment: string | null;
  administrative_role: string | null;
  email: string | null;
  phone: string | null;
  is_active: number;
  /** Server-concatenated name carrying the institutional `Dr.` title. */
  display_name?: string;
  specialty?: string | null;
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
  /**
   * The resident's email address from `resident_identifiers`, or null.
   *
   * The Master Rotation Grid export prints it under the Email column, so the
   * cohort query resolves it the same correlated-subquery way as the roster.
   * Optional so older fixtures that predate the column still type-check.
   */
  email?: string | null;
  pgy_level: number | null;
  resident_status: string;
  /**
   * Cross-programme provenance. `is_external` is 1 when the resident is
   * enrolled in a *different* programme and rotates into this one's
   * department; the home-programme name and code back the visiting badge
   * ("FM Resident") the grid draws beside the name. Internal rows carry 0 and
   * nulls, so a client can split sections without a second request.
   */
  is_external?: number | boolean;
  home_program_id?: number | null;
  host_program_id?: number | null;
  home_program_name?: string | null;
  home_program_code?: string | null;
  program_id: number;
  program_code: string;
  week_start_day: string | null;
  block_id: number;
  block_number: number;
  block_name: string;
  academic_year: string;
  /** Whether this block's schedule has been declared settled by the coordinator. */
  is_finalized?: number | boolean | null;
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
  /**
   * Concurrent clinic releases overlapping this block — a *different* thing from
   * the hospital assignment the rest of the cell describes.
   *
   * An approved clinic request never overwrites the block's rotation (it is a
   * release, not a posting), so the cell carries both: the hospital rotation as
   * its badge, and these releases as a secondary notation. `clinic_count` is how
   * many there are; `concurrent_clinic_label` is the ready-to-print summary, e.g.
   * `+ ANC (Wed)`; `clinic_source` says whether they came from an approved
   * request or were written straight onto a clinic's matrix.
   */
  clinic_count?: number;
  clinic_source?: 'CLINIC_REQUEST' | 'MATRIX' | null;
  concurrent_clinic_label?: string | null;
  clinic_releases?: CohortClinicRelease[];
  /**
   * The rotation's departmental seat limit, and how many residents stand in it
   * during this block.
   *
   * `rotation_max_capacity` is `null` for a rotation with no limit — the ordinary
   * case — so a cell shows a tag only when there is a limit worth showing.
   * `rotation_block_occupancy` is the distinct-resident count across the block,
   * which is what the tag reads as `(n/capacity)`.
   */
  rotation_max_capacity?: number | null;
  rotation_capacity_locked?: number | null;
  rotation_block_occupancy?: number | null;
}

/**
 * `GET /residents/external?program_id=` — one row per visiting resident.
 *
 * The person enrolled in *another* programme who rotates into this one's
 * departments, projected for the Roster's visiting tab: home-programme
 * identity plus an aggregate of where they rotate here (distinct departments
 * and rotations, assignment count, and the full date span of their postings).
 */
export interface VisitingResident {
  resident_id: number;
  first_name: string;
  middle_initial: string | null;
  last_name: string;
  /** Their PGY level *at the home programme* — e.g. PGY-5 at Family Medicine. */
  pgy_level: number | null;
  resident_status: string;
  home_program_id: number;
  home_program_code: string | null;
  home_program_name: string;
  home_specialty_name: string | null;
  corporate_id?: string | null;
  email?: string | null;
  mobile?: string | null;
  assignment_count: number;
  /** `·`-separated department names this resident rotates into here. */
  department_names: string | null;
  /** `·`-separated rotation names for those postings. */
  rotation_names: string | null;
  /** `YYYY-MM-DD` span across every posting here, e.g. one Block 6 visit. */
  assignment_start_date: CalendarDateString | null;
  assignment_end_date: CalendarDateString | null;
}

/** One recurring clinic release riding alongside a resident's block rotation. */
export interface CohortClinicRelease {
  /** The clinic's coordinator-facing code, or `''` for an uncatalogued clinic. */
  code: string;
  /** The first weekday, in enum form. */
  day: string;
  /** Every weekday the release covers, in enum form. */
  days: string[];
  /** The request's own words, e.g. `Clinic release: ANC (Wed)`. */
  summary: string;
  /** A badge-sized clinic name derived from the code or the summary. */
  name?: string;
  /** Where in the block the release sits, e.g. `B5.2`. */
  at?: string;
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

/**
 * Continuity of Care Clinics (CCC) cycle-schedule records.
 *
 * These mirror the four `primary_care_*` tables: a cycle, one header per
 * academic day, twelve fixed clinic slots per day (ten clinics plus WBC and
 * Leaves), and a per-day backup / catchup faculty pool.
 */
export interface PrimaryCareCycle {
  id: number;
  program_id: number;
  /**
   * Which clinic's grid this cycle belongs to. `0` is the programme's own
   * standard CCC matrix; a clinic id selects a cloned specialized clinic's grid.
   */
  clinic_type_id?: number;
  cycle_number: string;
  week_number: string;
  /** Plain `YYYY-MM-DD`, normalised server-side. */
  start_date: string;
  /** Derived server-side from `start_date`, e.g. `2026-2027`. */
  academic_year?: string | null;
  /** The rotation window in calendar months; `months × 4` = total_weeks. */
  rotation_window_months?: number | null;
  /** Whole weeks the cycle runs, derived from rotation_window_months. */
  total_weeks?: number | null;
  /** Inclusive `YYYY-MM-DD` end date, derived as start + (total_weeks × 7 − 1). */
  end_date?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * `GET /longitudinal/cycles` — the programme's CCC cycles for week navigation,
 * oldest first. Same shape as `PrimaryCareCycle` with `start_date` pre-normalised.
 */
export type PrimaryCareCycleSummary = PrimaryCareCycle;

export interface PrimaryCareDailyHeader {
  id: number;
  cycle_id: number;
  day_of_week: string;
  shift_time: string | null;
  pgy_level: string | null;
  in_charge_faculty_id: number | null;
  in_charge_faculty_name: string | null;
}

export interface PrimaryCareClinicSlot {
  id: number;
  daily_header_id: number;
  clinic_number: number;
  resident_1_name: string | null;
  resident_2_name: string | null;
  faculty_name: string | null;
  faculty_id: number | null;
}

export interface PrimaryCareBackupFaculty {
  id: number;
  daily_header_id: number;
  day_of_week: string;
  faculty_name: string | null;
  faculty_id: number | null;
  priority_order: number;
}

/**
 * One person absent from a CCC day, resident or faculty. Written by the Leaves
 * column and surfaced as that day's leave badge. Resident absences are mirrored
 * into the attendance log server-side.
 */
export interface PrimaryCareAbsence {
  id: number;
  program_id: number;
  cycle_id: number | null;
  daily_header_id: number | null;
  day_of_week: string;
  /** Plain `YYYY-MM-DD`, normalised server-side; `null` when the cycle is unknown. */
  absence_date: string | null;
  person_type: 'RESIDENT' | 'FACULTY';
  resident_id: number | null;
  faculty_id: number | null;
  person_name: string;
  leave_type: string;
  coverage_notes: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Payload for `POST /longitudinal/cycle-schedule/absences`. */
export interface PrimaryCareAbsenceInput {
  program_id: number;
  cycle_id?: number | null;
  day_of_week: string;
  leave_type?: string;
  coverage_notes?: string | null;
  residents?: { resident_id?: number; resident_name?: string; leave_type?: string }[];
  faculty?: { faculty_id?: number; faculty_name?: string; leave_type?: string }[];
}

/**
 * One numbered clinic column of the CCC grid (`Clinic 1..N`). `clinic_number` is
 * also the `PrimaryCareClinicSlot.clinic_number` it reads and writes; `label` is
 * the coordinator-set name, or null to render as "Clinic <number>".
 */
export interface PrimaryCareMatrixColumn {
  clinic_number: number;
  label: string | null;
}

export interface PrimaryCareCycleSchedule {
  cycle: PrimaryCareCycle;
  dailyHeaders: PrimaryCareDailyHeader[];
  slots: PrimaryCareClinicSlot[];
  backups: Record<string, PrimaryCareBackupFaculty[]>;
  absences?: PrimaryCareAbsence[];
  /** The numbered clinic columns of the grid. */
  columns?: PrimaryCareMatrixColumn[];
}

export interface RandomizeSupervisorsResult {
  updated: number;
  days: { day_of_week: string; reassigned: number }[];
  rationale?: string | null;
  rotation_months?: number;
  reason?: string;
}

/**
 * A specialized clinic created by cloning the standard CCC grid.
 *
 * It is an ordinary clinic catalog row (`LongitudinalClinicType`) marked
 * `is_template_clone = 1`, plus the cycle of the matrix it owns — which is what
 * lets the CCC view list it beside the standard grid and open its own.
 */
export interface SpecializedClinic extends LongitudinalClinicType {
  is_template_clone: number;
  source_template_code: string | null;
  custom_clinic_name: string | null;
  /** The cycle whose headers and slots are this clinic's grid. */
  cycle_id: number | null;
  cycle_number: string | null;
  week_number?: string | null;
  /** Plain `YYYY-MM-DD`, or null when the clinic has no cycle yet. */
  start_date: string | null;
}

/** The payload for `POST /longitudinal/specialized-clinics/clone`. */
export interface CloneSpecializedClinicPayload {
  program_id: number;
  custom_name: string;
  /** Defaults server-side to a code derived from the name. */
  clinic_code?: string;
  /** The grid template to copy; only `CCC` is supported today. */
  source_template?: string;
  /** Subset of the template's days to clone; omit for every day. */
  days?: string[];
  /** Uniform shift start (`HH:MM`), overriding the template's per-day shifts. */
  start_time?: string;
  /** Uniform shift end (`HH:MM`). */
  end_time?: string;
  /** One PGY level for every cloned day, overriding the template's. */
  pgy_level?: string;
}

/** What the clone engine copied, so the UI can say exactly what the new grid holds. */
export interface CloneSpecializedClinicResult {
  clinic: SpecializedClinic;
  cycle: PrimaryCareCycle;
  cloned: { columns: number; headers: number; slots: number };
}

/** Mirrors the `type` enum on `notifications`. */
export const NOTIFICATION_TYPES = [
  'DUTY_HOUR_BREACH',
  'LEAVE_STATUS',
  'ROTATION_APPROVAL',
  'SYSTEM_ALERT',
  'GENERAL',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** One row of `GET /notifications/resident/:resident_id`. */
export interface Notification {
  id: number;
  user_id: number;
  title: string;
  message: string;
  type: NotificationType;
  /** Id of the row that raised this (violation, leave request, assignment). */
  reference_id: number | null;
  /** Table the reference points at, e.g. `resident_leave_requests`. */
  reference_type: string | null;
  is_read: boolean;
  created_at: MinuteDateTimeString;
  read_at: MinuteDateTimeString | null;
}

/** `GET /notifications/resident/:resident_id` — list plus badge totals. */
export interface NotificationPage extends ApiListResponse<Notification> {
  total: number;
  unread: number;
  limit: number;
  offset: number;
}

/** `GET /notifications/resident/:resident_id/unread-count`. */
export interface NotificationUnreadCount {
  success: boolean;
  unread: number;
}

/** `PATCH /notifications/resident/:resident_id/read-all`. */
export interface NotificationReadAllResult {
  success: boolean;
  message: string;
  changed: number;
  unread: number;
}

/**
 * `POST /rotations/grid/notices/preview` and `.../send-notices`.
 *
 * The preview and the send share one shape deliberately: the confirmation the
 * coordinator reads and the run they trigger are computed by the same planner,
 * so the counts cannot drift apart between agreeing and acting.
 */

/** One receiving department the run would address. */
export interface RotationNoticeDepartment {
  department_name: string;
  resident_count: number;
  /** The `Block N` numbers this department would be written about. */
  block_numbers: number[];
  /**
   * The coordinator address this department resolves to, or null when none is
   * on file. `has_recipient` says so outright, because a notice that is stored
   * without an address is not a notice that was delivered.
   */
  recipient_coord_email: string | null;
  recipient_coord_name: string | null;
  has_recipient: boolean;
}

/** One resident a run would touch. */
export interface RotationNoticeResident {
  resident_id: number;
  resident_name: string;
  pgy_level: string | null;
  assignment_count: number;
}

/** The confirmation summary, before anything is written. */
export interface RotationNoticePlan {
  targets: unknown[];
  departments: RotationNoticeDepartment[];
  residents: RotationNoticeResident[];
  block_ids: number[];
  finalized_block_ids: number[];
  draft_block_ids: number[];
  template_code: string;
}

/** One stored letter from a completed dispatch. */
export interface RotationNoticeLetter {
  letter_id: number;
  resident_id: number;
  resident_name: string;
  pgy_level: string | null;
  rotation_assignment_id: number;
  rotation_name: string;
  hospital_department_name: string;
  block_id: number;
  block_number: number;
  release_start_date: string | null;
  release_end_date: string | null;
  recipient_coord_email: string | null;
  has_recipient: boolean;
  sent_status: string;
  dispatched_to_coordinator: boolean;
  /**
   * The copy filed in the *receiving* programme's inbox when this letter
   * crossed a programme boundary; `null` for an internal posting, where there
   * is no second mailbox to file into.
   */
  inbox_letter_id?: number | null;
  /** Tokens the merge could not fill; a letter with any is not sendable as-is. */
  unresolved_placeholders: string[];
}

/** An assignment the run left out, with the reason it was left out. */
export interface RotationNoticeSkip {
  rotation_assignment_id: number;
  resident_id: number;
  resident_name: string;
  reason: string;
  existing_letter_id?: number;
}

/** The result of a dispatch. */
export interface RotationNoticeDispatchResult {
  program_id: number;
  template_code: string;
  dispatch_type: string;
  sent_by_user_id: number | null;
  block_ids: number[];
  finalized_block_ids: number[];
  draft_block_ids: number[];
  send_to_coordinators: boolean;
  notify_residents: boolean;
  departments: RotationNoticeDepartment[];
  letters: RotationNoticeLetter[];
  letters_sent: number;
  /** Letters stored with no address to send them to. */
  letters_without_recipient: number;
  residents_notified: number;
  notifications: { notification_id: number; resident_id: number; resident_name: string }[];
  /** Partner-programme coordinators told their visiting resident is expected. */
  coordinators_notified?: number;
  cross_program_notices?: {
    host_program_id: number;
    host_program_name: string | null;
    resident_id: number;
    resident_name: string;
    /** The row filed in the receiving programme's inbox, when one was filed. */
    inbox_letter_id?: number | null;
    notification_id: number | null;
  }[];
  skipped: RotationNoticeSkip[];
}

/** `PATCH /rotations/blocks/:block_id/finalized`. */
export interface BlockFinalizationResult {
  block_id: number;
  block_number: number;
  academic_year: string;
  is_finalized: boolean;
}
