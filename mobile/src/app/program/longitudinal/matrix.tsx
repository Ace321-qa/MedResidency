import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Check, Download, Minus, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Divider,
  ExportMenu,
  IconButton,
  ImportTools,
  ScheduleReportView,
  Screen,
  SearchInput,
  SectionHeader,
  SegmentedControl,
  SelectField,
  Sheet,
  SheetSelectField,
  StatusBadge,
  Text,
  TextField,
  type SegmentedOption,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  addClinicColumn,
  deleteClinicColumn,
  fetchCycleSchedule,
  fetchCycles,
  fetchFacultySupervisors,
  randomizeSupervisors,
  renameClinicColumn,
  updateBackupFaculty,
  updateCycleHeader,
  addCycleDayHeader,
  deleteCycleDayHeader,
  updateCycleSlot,
  updateDayAbsences,
  createFacultySupervisor,
  updateFacultySupervisor,
  deleteFacultySupervisor,
} from '../../../services/longitudinal';
import { fetchResidentList } from '../../../services/residents';
import { downloadScheduleReport } from '../../../services/scheduleExport';
import { buildCccMatrixReport } from '../../../utils/scheduleExport';
import { uploadFacultySupervisors } from '../../../services/excelTemplates';
import {
  CCC_SCHEDULE_ROWS,
  dayOfWeekMatches,
  formatCycleMetadataBanner,
  numericLabelValue,
  pgyLevelFromLabel,
  splitShiftRange,
  weekdayIndex,
  weekdayName,
} from '../../../utils/cccMatrix';
import { rotationWindowForMonths } from '../../../utils/masterGridCalendar';
import {
  DAY_NAMES,
  dateForWeekDay,
  dayNameOf,
  formatWeekSpan,
  weekDayDate,
  weekDaySequence,
} from '../../../utils/dateCalc';
import type { DayName } from '../../../utils/dateCalc';
import { formatShortDate } from '../../../utils/format';
import { formatPgy } from '../../../utils/insights';
import { residentFullName } from '../../../utils/residents';
import {
  ADMINISTRATIVE_ROLE_HINT,
  ADMINISTRATIVE_ROLE_OPTIONS,
  CLINICAL_TITLE_HINT,
  CLINICAL_TITLE_OPTIONS,
  FACULTY_APPOINTMENT_HINT,
  FACULTY_APPOINTMENT_OPTIONS,
  facultyBadges,
} from '../../../utils/faculty';
import { colors, radius, spacing } from '../../../theme';
import { goBack } from '../../../navigation/back';
import { LEAVE_TYPES } from '../../../types/api';
import type {
  PrimaryCareAbsence,
  PrimaryCareClinicSlot,
  PrimaryCareCycle,
  PrimaryCareDailyHeader,
} from '../../../types/api';

/**
 * The CCC weekly schedule.
 *
 * A five-day grid of numbered clinic columns is wider than any phone, so the
 * whole table scrolls horizontally while the day column stays pinned. The clinic
 * columns are numbered positions a coordinator can add to, rename or remove;
 * the final Leaves column records who is away each day. Every cell is a single
 * tap away from editing; the cycle header, per-day boundaries and the backup
 * pools sit below it.
 */

/** Every weekday, Sunday-first. A cycle's own rotation is a slice of this. */
const DAYS = DAY_NAMES;

/** Only these days carry a catchup pool, per the programme rules. */
const BACKUP_DAYS: DayName[] = ['Sunday', 'Monday', 'Wednesday'];

const DAY_SHORT: Record<DayName, string> = {
  Sunday: 'Sun',
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
};

/**
 * The default shift and PGY level each weekday starts with. A day row the
 * coordinator adds is seeded from here, and a row with nothing saved falls back
 * to it, so Friday and Saturday are first-class days rather than an afterthought.
 */
const DAY_CONFIG: Record<DayName, { shift: string; pgy: string }> = {
  Sunday: { shift: '10:30 – 2:00', pgy: 'PGY-3' },
  Monday: { shift: '10:30 – 2:00', pgy: 'PGY-2' },
  Tuesday: { shift: '07:00 – 2:00', pgy: 'FMC' },
  Wednesday: { shift: '10:30 – 2:00', pgy: 'PGY-1' },
  Thursday: { shift: '07:00 – 2:00', pgy: 'FMC' },
  Friday: { shift: '10:30 – 2:00', pgy: 'FMC' },
  Saturday: { shift: '10:30 – 2:00', pgy: 'FMC' },
};

interface MatrixColumn {
  key: string;
  title: string;
  subtitle: string | null;
  /**
   * Which `primary_care_clinic_slots.clinic_number` this column reads and
   * writes. `0`/unused for the Leaves column, which is not a clinic slot.
   */
  clinicNumber: number;
  special: boolean;
  /** The single Leaves column, backed by the absence registry. */
  isLeaves: boolean;
}

/**
 * Build the matrix columns from the numbered clinic columns the server holds.
 *
 * The grid's clinic columns are numbered positions (`Clinic 1..N`), each with an
 * optional coordinator-set label; slot data lives under `clinic_number`, so
 * renaming never moves a column's data and adding/removing never shifts others.
 * The Leaves column is pinned to the end and is not a slot.
 */
function buildMatrixColumns(raw: { clinic_number: number; label: string | null }[]): MatrixColumn[] {
  const columns: MatrixColumn[] = (raw ?? [])
    .filter((entry) => entry.clinic_number >= 1)
    .sort((a, b) => a.clinic_number - b.clinic_number)
    .map((entry) => ({
      key: `clinic-${entry.clinic_number}`,
      clinicNumber: entry.clinic_number,
      title: entry.label?.trim() || `Clinic ${entry.clinic_number}`,
      subtitle: null,
      special: false,
      isLeaves: false,
    }));
  columns.push({
    key: 'leaves',
    clinicNumber: 0,
    title: 'Leaves',
    subtitle: 'Away',
    special: true,
    isLeaves: true,
  });
  return columns;
}

/** The default label a column has before a coordinator renames it. */
function defaultColumnLabel(clinicNumber: number): string {
  return `Clinic ${clinicNumber}`;
}

/** Human label for a `leave_type` enum, e.g. `SICK_LEAVE` -> "Sick Leave". */
function humanizeLeaveType(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const LEAVE_TYPE_OPTIONS: SelectOption<string>[] = LEAVE_TYPES.map((type) => ({
  value: type,
  label: humanizeLeaveType(type),
}));

/** The user-facing name for a stored leave type, falling back to the raw value. */
function leaveTypeLabel(value: string | null | undefined): string {
  if (!value) return 'Leave';
  return humanizeLeaveType(value);
}

const BACKUP_POOL_MIN = 3;
const BACKUP_POOL_MAX = 4;

/** Web pins the day column; React Native has no sticky positioning. */
const stickyPosition: 'relative' = Platform.OS === 'web' ? ('sticky' as any) : 'relative';

/** The days a header may be reassigned to, in the cycle's own rotation order. */
function dayOptionsFor(sequence: readonly DayName[]): SelectOption<DayName>[] {
  return sequence.map((day) => ({ value: day, label: day }));
}

/** The PGY levels / contexts a day can carry. A custom value is kept too. */
const PGY_OPTIONS: SelectOption<string>[] = [
  { value: 'PGY-3', label: 'PGY-3' },
  { value: 'PGY-2', label: 'PGY-2' },
  { value: 'PGY-1', label: 'PGY-1' },
  { value: 'FMC', label: 'FMC' },
];

/** The cycle-number picker: the twelve cycles a programme year can hold. */
const CYCLE_NUMBER_OPTIONS: SelectOption<string>[] = Array.from({ length: 12 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/** The week-number picker: four weeks to a rotation month. */
const WEEK_NUMBER_OPTIONS: SelectOption<string>[] = Array.from({ length: 4 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/**
 * The cycle & schedule metadata the top header bar edits.
 *
 * Kept separate from the per-day `HeaderForm`: this one sets the week up — its
 * cycle and week numbers, the day it opens on and the session the header bar
 * reads — while the day editor tunes one row at a time.
 */
interface MetadataForm {
  cycleNumber: string;
  weekNumber: string;
  firstDay: DayName;
  startDate: string;
  shiftStart: string;
  shiftEnd: string;
  pgyLevel: string;
}

interface SlotEdit {
  /** The stored slot, or null for a cell the schedule has not materialised yet. */
  slot: PrimaryCareClinicSlot | null;
  day: DayName;
  /** Column header, e.g. "Clinic 3" or "WBC". */
  columnLabel: string;
  clinicNumber: number;
  shiftTime: string | null;
  pgyLevel: string | null;
}

interface SlotForm {
  resident1: string;
  resident2: string;
  faculty: string;
}

/**
 * The row a coordinator tapped the header of.
 *
 * `day` is the row's own position in the week; `header` is its stored record,
 * or null for a day the backend has not materialised yet.
 */
interface HeaderEdit {
  day: DayName;
  header: PrimaryCareDailyHeader | null;
}

interface HeaderForm {
  dayOfWeek: DayName;
  shiftTime: string;
  pgyLevel: string;
  inChargeFaculty: string;
}

const NONE_RESIDENT = '';
const NONE_FACULTY = '';

/**
 * A resident as the slot dropdowns need them: title-free name, the training
 * level they are enrolled at, and whether they are currently active. Built once
 * so every day's filtered dropdown reads from the same list.
 */
interface ResidentRosterEntry {
  name: string;
  pgyLevel: number | null;
  active: boolean;
}

/** Statuses that count as enrolled and assignable to a clinic slot. */
const ACTIVE_RESIDENT_STATUSES = new Set(['ACTIVE_FULL_TIME', 'ACTIVE_PART_TIME']);

/**
 * Faculty are always shown and stored with exactly one `Dr. ` prefix, matching
 * the server's own normalisation. Stripping first means a display name that
 * already carries the title is not turned into `Dr. Dr. Areen`.
 */
function withDoctorTitle(name: string | null | undefined): string {
  const base = String(name ?? '')
    .trim()
    .replace(/^Dr\.?\s+/i, '')
    .trim();
  return base ? `Dr. ${base}` : '';
}



/**
 * Resolve whatever spelling the backend holds — "SUNDAY", "Sun", "Sunday" —
 * to the canonical `DayName`, or null when it names no CCC day.
 *
 * The row a header belongs to is decided by its `day_of_week`, so a stored
 * "SUNDAY" must still light up the Sunday row rather than silently falling back
 * to its default shift and PGY level.
 */
function canonicalDay(value: string | null | undefined): DayName | null {
  if (!value) return null;
  return DAYS.find((day) => dayOfWeekMatches(value, DAYS.indexOf(day))) ?? null;
}

/** A compact pill for a PGY level or an FMC session context. */
function PgyBadge({ label }: { label: string }) {
  return (
    <View style={styles.pgyBadge}>
      <Text variant="label" tone="brand">
        {label}
      </Text>
    </View>
  );
}

/** The two ways a coordinator can read the weekly clinic grid. */
type ViewMode = 'matrix' | 'roster';

interface ViewModeOption {
  value: ViewMode;
  label: string;
}

const VIEW_MODE_OPTIONS: ViewModeOption[] = [
  { value: 'matrix', label: 'Matrix Grid' },
  { value: 'roster', label: 'Operational Roster' },
];

export default function LongitudinalMatrixScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  /**
   * The cycle-history selector. `selectedCycleId` is the stored cycle the
   * coordinator chose, or null for the programme's current (latest) cycle. A
   * past cycle is shown read-only: the schedule is a record of what happened, so
   * the edit affordances are disabled rather than silently writing to the
   * current cycle.
   */
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const cycles = useApiResource(() => fetchCycles(programId), [programId]);
  const schedule = useApiResource(
    () => fetchCycleSchedule(programId, selectedCycleId ?? undefined),
    [programId, selectedCycleId],
  );
  const facultyResource = useApiResource(() => fetchFacultySupervisors(programId), [programId]);
  const residentsResource = useApiResource(
    () => fetchResidentList({ programId, limit: 200 }),
    [programId],
  );

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [slotEdit, setSlotEdit] = useState<SlotEdit | null>(null);
  const [slotForm, setSlotForm] = useState<SlotForm>({
    resident1: NONE_RESIDENT,
    resident2: NONE_RESIDENT,
    faculty: NONE_FACULTY,
  });

  const [headerEdit, setHeaderEdit] = useState<HeaderEdit | null>(null);
  const [headerForm, setHeaderForm] = useState<HeaderForm>({
    dayOfWeek: DAYS[0],
    shiftTime: '',
    pgyLevel: '',
    inChargeFaculty: NONE_FACULTY,
  });

  const [backupEditDay, setBackupEditDay] = useState<DayName | null>(null);
  const [backupDraft, setBackupDraft] = useState<string[]>([]);

  const [rotationMonths, setRotationMonths] = useState('3');
  const [rotationTouched, setRotationTouched] = useState(false);
  const [rationale, setRationale] = useState('');

  /** Which of the two clinic-grid renderings is active. */
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');

  /** Export chooser and the offscreen report the image formats capture. */
  const [exportOpen, setExportOpen] = useState(false);
  const reportRef = useRef<View>(null);

  /** The clinic catalog add / rename / remove controls. */
  const [facultyMgrOpen, setFacultyMgrOpen] = useState(false);
  const [facultyForm, setFacultyForm] = useState({ firstName: "", lastName: "", email: "", phone: "", specialty: "", clinicalTitle: "", facultyAppointment: "", administrativeRole: "" });
  const [facultyEditing, setFacultyEditing] = useState<any | null>(null);
  const [savingFaculty, setSavingFaculty] = useState(false);
  const [deletingFaculty, setDeletingFaculty] = useState(false);
  const [facultyDeleteTarget, setFacultyDeleteTarget] = useState<any | null>(null);

  /** The numbered clinic-column editor: rename a column's label, or remove it. */
  const [columnManage, setColumnManage] = useState<MatrixColumn | null>(null);
  const [columnLabelValue, setColumnLabelValue] = useState('');
  const [savingColumn, setSavingColumn] = useState(false);
  const [removingColumn, setRemovingColumn] = useState(false);

  /** The Leaves column editor: one CCC day's resident and faculty absences. */
  const [leavesEditDay, setLeavesEditDay] = useState<DayName | null>(null);
  const [leavesLeaveType, setLeavesLeaveType] = useState<string>('SICK_LEAVE');
  const [leavesNotes, setLeavesNotes] = useState('');
  const [leavesResidentNames, setLeavesResidentNames] = useState<string[]>([]);
  const [leavesFacultyNames, setLeavesFacultyNames] = useState<string[]>([]);
  const [leavesResidentQuery, setLeavesResidentQuery] = useState('');
  const [leavesFacultyQuery, setLeavesFacultyQuery] = useState('');
  const [savingLeaves, setSavingLeaves] = useState(false);

  /**
   * The variable-day-row controls. `dayAddOpen` drives the "+ Add Day Row"
   * sheet, `dayRemoveTarget` the "- Remove Row" confirmation, and `savingDay`
   * disables both while a write is in flight.
   */
  const [dayAddOpen, setDayAddOpen] = useState(false);
  const [dayAddForm, setDayAddForm] = useState<{
    dayOfWeek: DayName;
    shiftTime: string;
    pgyLevel: string;
    inChargeFaculty: string;
  }>({ dayOfWeek: 'Sunday', shiftTime: '', pgyLevel: '', inChargeFaculty: NONE_FACULTY });
  const [dayRemoveTarget, setDayRemoveTarget] = useState<DayName | null>(null);
  const [savingDay, setSavingDay] = useState(false);

  /**
   * The top header bar's cycle & schedule metadata editor. `metadataOpen`
   * drives the sheet, `savingMetadata` disables it while a write is in flight.
   */
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [metadataForm, setMetadataForm] = useState<MetadataForm>({
    cycleNumber: '1',
    weekNumber: '1',
    firstDay: DAYS[0],
    startDate: '',
    shiftStart: '',
    shiftEnd: '',
    pgyLevel: '',
  });

  const data = schedule.data;
  const cycle: PrimaryCareCycle | null = data?.cycle ?? null;

  const cycleList = useMemo(() => cycles.data ?? [], [cycles.data]);
  const latestCycleId = cycleList.length > 0 ? cycleList[cycleList.length - 1].id : null;
  /** True when a past cycle is on screen, so every edit control is inert. */
  const historyMode = selectedCycleId !== null && selectedCycleId !== latestCycleId;

  const cycleOptions = useMemo<SegmentedOption[]>(() => {
    const currentLabel =
      cycle?.academic_year ?? (cycle ? formatShortDate(cycle.start_date) : 'current');
    const options: SegmentedOption[] = [{ value: '', label: `Current · ${currentLabel}` }];
    for (const item of [...cycleList].reverse()) {
      if (item.id === latestCycleId) continue;
      const year = item.academic_year ?? formatShortDate(item.start_date);
      options.push({ value: String(item.id), label: `${year} · C${item.cycle_number}` });
    }
    return options;
  }, [cycleList, latestCycleId, cycle]);

  /**
   * The week's day order, rotated to begin on the cycle's Week Start Date. A
   * Sunday-start cycle runs Sunday–Saturday; pick Monday 2026-10-12 and the
   * same week reads Monday–Sunday across every control on this screen.
   */
  const daySequence = useMemo<DayName[]>(
    () => weekDaySequence(cycle?.start_date ?? null),
    [cycle?.start_date],
  );

  /** The weekdays that actually have a stored row on this cycle. */
  const persistedDays = useMemo<DayName[]>(() => {
    const seen = new Set<DayName>();
    const list: DayName[] = [];
    for (const header of data?.dailyHeaders ?? []) {
      const name = weekdayName(header.day_of_week);
      if (name && !seen.has(name)) {
        seen.add(name);
        list.push(name);
      }
    }
    return list;
  }, [data?.dailyHeaders]);

  /**
   * The rows the grid renders — the stored days, in rotation order. A day the
   * coordinator has not added yet is simply absent, which is what makes the
   * number of rows variable; before the first load the sequence stands in.
   */
  const activeDays = useMemo<DayName[]>(() => {
    if (persistedDays.length === 0) return daySequence;
    return daySequence.filter((day) => persistedDays.includes(day));
  }, [daySequence, persistedDays]);

  /** The weekdays still available to add, in rotation order. */
  const missingDays = useMemo<DayName[]>(
    () => daySequence.filter((day) => !activeDays.includes(day)),
    [daySequence, activeDays],
  );

  const dayOptions = useMemo<SelectOption<DayName>[]>(
    () => dayOptionsFor(daySequence),
    [daySequence],
  );

  // The rotation input is a free-typed draft until the coordinator touches it;
  // once a saved cycle carries its own window, that value wins instead. Deriving
  // (rather than syncing in an effect) keeps the field, the badge, the end date
  // and the randomize payload reading the same source on every render.
  const rotationValue = rotationTouched
    ? rotationMonths
    : cycle?.rotation_window_months != null
      ? String(cycle.rotation_window_months)
      : rotationMonths;

  /** The whole calendar window the current rotation covers. */
  const rotation = useMemo(
    () => rotationWindowForMonths(cycle?.start_date ?? null, Number(rotationValue)),
    [cycle?.start_date, rotationValue],
  );

  const facultyOptions = useMemo<SelectOption<string>[]>(() => {
    // Non-hierarchical: preceptors are listed alphabetically by name, never by
    // rank or appointment, so the dropdown never implies a supervision order.
    const options = (facultyResource.data ?? [])
      .map((faculty) => {
        const value = withDoctorTitle(
          faculty.display_name ?? `${faculty.first_name} ${faculty.last_name}`,
        );
        if (!value) return null;
        const badges = facultyBadges(faculty)
          .map((badge) => badge.label)
          .join(' • ');
        return { value, label: badges ? `${value} • ${badges}` : value };
      })
      .filter((option): option is SelectOption<string> => option !== null)
      .sort((a, b) => a.value.localeCompare(b.value));

    return [{ value: NONE_FACULTY, label: '— None —' }, ...options];
  }, [facultyResource.data]);

  const facultyIdByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const faculty of facultyResource.data ?? []) {
      const value = withDoctorTitle(faculty.display_name ?? `${faculty.first_name} ${faculty.last_name}`);
      if (!value) continue;
      map.set(value, faculty.id);
    }
    return map;
  }, [facultyResource.data]);

  const residentRoster = useMemo<ResidentRosterEntry[]>(() => {
    const seen = new Set<string>();
    const roster: ResidentRosterEntry[] = [];
    for (const resident of residentsResource.data ?? []) {
      const name = residentFullName(resident).replace(/^Dr\.?\s+/i, '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      roster.push({
        name,
        pgyLevel: resident.pgy_level ?? null,
        active: ACTIVE_RESIDENT_STATUSES.has(resident.resident_status),
      });
    }
    return roster;
  }, [residentsResource.data]);

  const residentOptions = useMemo<SelectOption<string>[]>(
    () => [
      { value: NONE_RESIDENT, label: '— Unassigned —' },
      ...residentRoster.map((entry) => ({ value: entry.name, label: entry.name })),
    ],
    [residentRoster],
  );

  /** Title-free display name -> resident id, so absences can be written back. */
  const residentIdByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const resident of residentsResource.data ?? []) {
      const name = residentFullName(resident).replace(/^Dr\.?\s+/i, '').trim();
      if (!name || map.has(name)) continue;
      map.set(name, resident.resident_id);
    }
    return map;
  }, [residentsResource.data]);

  function headerForDay(day: DayName): PrimaryCareDailyHeader | null {
    const weekday = weekdayIndex(day);
    return data?.dailyHeaders.find((header) => dayOfWeekMatches(header.day_of_week, weekday)) ?? null;
  }

  function slotFor(day: DayName, clinicNumber: number): PrimaryCareClinicSlot | null {
    const header = headerForDay(day);
    if (!header) return null;
    return (
      data?.slots.find(
        (slot) => slot.daily_header_id === header.id && slot.clinic_number === clinicNumber,
      ) ?? null
    );
  }

  function updateCycleField(patch: Partial<PrimaryCareCycle>) {
    schedule.setData((current) =>
      current ? { ...current, cycle: { ...current.cycle, ...patch } } : current,
    );
  }

  /** Patch one day's stored header in place, without refetching the schedule. */
  function patchDailyHeader(id: number, patch: Partial<PrimaryCareDailyHeader>) {
    schedule.setData((current) =>
      current
        ? {
            ...current,
            dailyHeaders: current.dailyHeaders.map((header) =>
              header.id === id ? { ...header, ...patch } : header,
            ),
          }
        : current,
    );
  }

  async function saveHeader() {
    if (!programId || !data || !cycle) return;
    setSaving(true);
    setActionError(null);
    setFeedback(null);
    try {
      await updateCycleHeader({
        program_id: programId,
        cycle_id: cycle.id,
        cycle_number: cycle.cycle_number,
        week_number: cycle.week_number,
        start_date: cycle.start_date,
        rotation_window_months: Number(rotationValue) || undefined,
        dailyHeaders: data.dailyHeaders.map((header) => ({
          id: header.id,
          day_of_week: header.day_of_week,
          shift_time: header.shift_time,
          pgy_level: header.pgy_level,
          in_charge_faculty_name: header.in_charge_faculty_name,
          in_charge_faculty_id: header.in_charge_faculty_id,
        })),
      });
      setFeedback('Cycle header and day boundaries saved.');
      schedule.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the cycle header.');
    } finally {
      setSaving(false);
    }
  }

  /** Seed the daily-header form from the tapped row, falling back to defaults. */
  function openHeader(day: DayName) {
    if (historyMode) return;
    const header = headerForDay(day);
    setHeaderEdit({ day, header });
    setHeaderForm({
      dayOfWeek: canonicalDay(header?.day_of_week) ?? day,
      shiftTime: header?.shift_time ?? DAY_CONFIG[day].shift,
      pgyLevel: header?.pgy_level ?? DAY_CONFIG[day].pgy,
      inChargeFaculty: header?.in_charge_faculty_name ?? NONE_FACULTY,
    });
    setActionError(null);
    setFeedback(null);
  }

  function closeHeader() {
    setHeaderEdit(null);
  }

  async function saveDailyHeader() {
    if (!headerEdit) return;
    if (!programId || !cycle) {
      setActionError('The cycle has not loaded yet. Refresh and try again.');
      return;
    }
    if (!headerEdit.header) {
      setActionError('This day has not been created on the schedule yet. Refresh and try again.');
      return;
    }

    const headerId = headerEdit.header.id;
    const facultyName = withDoctorTitle(headerForm.inChargeFaculty);
    const patch: Partial<PrimaryCareDailyHeader> = {
      day_of_week: headerForm.dayOfWeek,
      shift_time: headerForm.shiftTime.trim() || null,
      pgy_level: headerForm.pgyLevel.trim() || null,
      in_charge_faculty_name: facultyName || null,
      in_charge_faculty_id: facultyName ? facultyIdByName.get(facultyName) ?? null : null,
    };

    setSaving(true);
    setActionError(null);
    setFeedback(null);
    try {
      await updateCycleHeader({
        program_id: programId,
        cycle_id: cycle.id,
        dailyHeaders: [{ id: headerId, ...patch }],
      });
      // Patch the saved header into local state in place, so the row updates
      // without a full page refresh.
      patchDailyHeader(headerId, patch);
      setFeedback('Daily header and In-Charge faculty saved.');
      setHeaderEdit(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the daily header.');
    } finally {
      setSaving(false);
    }
  }

  /** Open the "+ Add Day Row" sheet, seeded from the first still-missing day. */
  function openAddDay() {
    if (historyMode) return;
    const next = missingDays[0] ?? daySequence[0] ?? 'Sunday';
    setDayAddForm({
      dayOfWeek: next,
      shiftTime: DAY_CONFIG[next].shift,
      pgyLevel: DAY_CONFIG[next].pgy,
      inChargeFaculty: NONE_FACULTY,
    });
    setActionError(null);
    setFeedback(null);
    setDayAddOpen(true);
  }

  function closeAddDay() {
    if (savingDay) return;
    setDayAddOpen(false);
  }

  /**
   * Append a new day row to the cycle. The server inserts it with curriculum
   * defaults and materialises its clinic slots; the returned header and slots
   * are patched into local state so the new row is editable immediately.
   */
  async function saveNewDay() {
    if (!programId || !cycle) {
      setActionError('The cycle has not loaded yet. Refresh and try again.');
      return;
    }
    const facultyName = withDoctorTitle(dayAddForm.inChargeFaculty);
    setSavingDay(true);
    setActionError(null);
    setFeedback(null);
    try {
      const result = await addCycleDayHeader({
        program_id: programId,
        cycle_id: cycle.id,
        day_of_week: dayAddForm.dayOfWeek,
        shift_time: dayAddForm.shiftTime.trim() || null,
        pgy_level: dayAddForm.pgyLevel.trim() || null,
        in_charge_faculty_name: facultyName || null,
        in_charge_faculty_id: facultyName ? facultyIdByName.get(facultyName) ?? null : null,
      });
      schedule.setData((current) =>
        current
          ? {
              ...current,
              dailyHeaders: result.headers.length > 0 ? result.headers : current.dailyHeaders,
              slots: [...current.slots, ...result.slots],
            }
          : current,
      );
      setFeedback(`${dayAddForm.dayOfWeek} row added to the CCC week.`);
      setDayAddOpen(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not add this day.');
    } finally {
      setSavingDay(false);
    }
  }

  /** Remove one day row from the cycle. The grid must keep at least one day. */
  async function confirmRemoveDay() {
    if (!programId || !dayRemoveTarget || !cycle) return;
    const header = headerForDay(dayRemoveTarget);
    if (!header) {
      setActionError('This day has not been created on the schedule yet. Refresh and try again.');
      setDayRemoveTarget(null);
      return;
    }
    const removedDay = dayRemoveTarget;
    const removedId = header.id;
    const removedWeekday = weekdayIndex(removedDay);
    setSavingDay(true);
    setActionError(null);
    setFeedback(null);
    try {
      const result = await deleteCycleDayHeader(programId, removedId);
      schedule.setData((current) =>
        current
          ? {
              ...current,
              dailyHeaders:
                result.headers && result.headers.length > 0
                  ? result.headers
                  : current.dailyHeaders.filter((entry) => entry.id !== removedId),
              slots: current.slots.filter((slot) => slot.daily_header_id !== removedId),
              absences: (current.absences ?? []).filter(
                (row) =>
                  row.daily_header_id !== removedId &&
                  !dayOfWeekMatches(row.day_of_week, removedWeekday),
              ),
              backups: Object.fromEntries(
                Object.entries(current.backups ?? {}).filter(([key]) => key !== removedDay),
              ) as typeof current.backups,
            }
          : current,
      );
      setFeedback(`${removedDay} row removed from the CCC week.`);
      setDayRemoveTarget(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not remove this day.');
    } finally {
      setSavingDay(false);
    }
  }

  /**
   * Seed the metadata sheet from the cycle and its opening session.
   *
   * The bar reads the week's first persisted day, so the editor starts from
   * that same day's shift and PGY level — the values the banner is already
   * showing — rather than from an unrelated default.
   */
  function openMetadata() {
    if (historyMode) return;
    const first = activeDays[0] ?? daySequence[0] ?? DAYS[0];
    const header = headerForDay(first);
    const range = splitShiftRange(header?.shift_time ?? DAY_CONFIG[first].shift);
    setMetadataForm({
      cycleNumber: numericLabelValue(cycle?.cycle_number) || '1',
      weekNumber: numericLabelValue(cycle?.week_number) || '1',
      firstDay: first,
      startDate: cycle?.start_date ?? '',
      shiftStart: range?.[0] ?? '',
      shiftEnd: range?.[1] ?? '',
      pgyLevel: header?.pgy_level ?? DAY_CONFIG[first].pgy,
    });
    setActionError(null);
    setFeedback(null);
    setMetadataOpen(true);
  }

  function closeMetadata() {
    if (savingMetadata) return;
    setMetadataOpen(false);
  }

  /**
   * Move the week's first day. The start date follows to that weekday within
   * the same week, and the session fields reseed from the new day so the sheet
   * never shows one day's times under another day's name.
   */
  function changeMetadataFirstDay(day: DayName) {
    setMetadataForm((previous) => {
      const header = headerForDay(day);
      const range = splitShiftRange(header?.shift_time ?? DAY_CONFIG[day].shift);
      const movedStart = previous.startDate
        ? dateForWeekDay(previous.startDate, day)
        : previous.startDate;
      return {
        ...previous,
        firstDay: day,
        startDate: movedStart ?? previous.startDate,
        shiftStart: range?.[0] ?? '',
        shiftEnd: range?.[1] ?? '',
        pgyLevel: header?.pgy_level ?? DAY_CONFIG[day].pgy,
      };
    });
  }

  /**
   * Save the cycle & schedule metadata and patch it into local state.
   *
   * The cycle fields and the opening day's session go up in one request; the
   * response's cycle and the values we sent are merged locally so the header
   * bar updates in place without a full refetch. The shift is stored in the
   * same `HH:MM - HH:MM` shape the day editor uses.
   */
  async function saveMetadata() {
    if (!programId || !cycle) {
      setActionError('The cycle has not loaded yet. Refresh and try again.');
      return;
    }
    const header = headerForDay(metadataForm.firstDay);
    const start = metadataForm.shiftStart.trim();
    const end = metadataForm.shiftEnd.trim();
    const shiftTime = start && end ? `${start} - ${end}` : null;
    const pgy = metadataForm.pgyLevel.trim() || null;

    setSavingMetadata(true);
    setActionError(null);
    setFeedback(null);
    try {
      const updated = await updateCycleHeader({
        program_id: programId,
        cycle_id: cycle.id,
        cycle_number: metadataForm.cycleNumber,
        week_number: metadataForm.weekNumber,
        start_date: metadataForm.startDate || cycle.start_date,
        dailyHeaders: header
          ? [{ id: header.id, shift_time: shiftTime, pgy_level: pgy }]
          : undefined,
      });
      updateCycleField(updated);
      if (header) patchDailyHeader(header.id, { shift_time: shiftTime, pgy_level: pgy });
      setFeedback('Cycle & schedule metadata saved.');
      setMetadataOpen(false);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Could not save the cycle metadata.',
      );
    } finally {
      setSavingMetadata(false);
    }
  }

  function openSlot(edit: SlotEdit) {
    if (historyMode) return;
    setSlotEdit(edit);
    setSlotForm({
      resident1: edit.slot?.resident_1_name ?? NONE_RESIDENT,
      resident2: edit.slot?.resident_2_name ?? NONE_RESIDENT,
      faculty: edit.slot?.faculty_name ?? NONE_FACULTY,
    });
    setActionError(null);
    setFeedback(null);
  }

  function closeSlot() {
    setSlotEdit(null);
  }

  async function saveSlot() {
    if (!slotEdit) return;
    if (!slotEdit.slot) {
      setActionError('This clinic slot has not been created on the schedule yet. Refresh and try again.');
      return;
    }
    setSaving(true);
    setActionError(null);
    setFeedback(null);
    try {
      const result = await updateCycleSlot(slotEdit.slot.id, {
        program_id: programId,
        resident_1_name: slotForm.resident1.trim() || null,
        resident_2_name: slotForm.resident2.trim() || null,
        faculty_name: slotForm.faculty.trim() || null,
        faculty_id: facultyIdByName.get(slotForm.faculty.trim()) ?? null,
      });
      // Patch the saved row into local state so the cell updates in place,
      // without a full page refresh.
      schedule.setData((current) =>
        current
          ? {
              ...current,
              slots: current.slots.map((slot) => (slot.id === result.slot.id ? result.slot : slot)),
            }
          : current,
      );
      setFeedback(
        result.warnings.length > 0
          ? `Clinic slot saved. ${result.warnings.join(' ')}`
          : 'Clinic slot saved.',
      );
      setSlotEdit(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the clinic slot.');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Open the Leaves editor for a day, seeding it from the recorded absences so a
   * coordinator sees and can amend exactly what is already there.
   */
  function openLeaves(day: DayName) {
    if (historyMode) return;
    const rows = absencesForDay(day);
    setLeavesResidentNames(
      rows.filter((row) => row.person_type === 'RESIDENT').map((row) => row.person_name.replace(/^Dr\.?\s+/i, '').trim()),
    );
    setLeavesFacultyNames(
      rows.filter((row) => row.person_type === 'FACULTY').map((row) => row.person_name.trim()),
    );
    const firstType = rows.find((row) => row.leave_type)?.leave_type;
    setLeavesLeaveType(firstType || 'SICK_LEAVE');
    setLeavesNotes(rows.find((row) => row.coverage_notes)?.coverage_notes ?? '');
    setLeavesResidentQuery('');
    setLeavesFacultyQuery('');
    setLeavesEditDay(day);
    setActionError(null);
    setFeedback(null);
  }

  function closeLeaves() {
    if (savingLeaves) return;
    setLeavesEditDay(null);
  }

  function toggleLeavesResident(name: string) {
    setLeavesResidentNames((previous) =>
      previous.includes(name) ? previous.filter((entry) => entry !== name) : [...previous, name],
    );
  }

  function toggleLeavesFaculty(name: string) {
    setLeavesFacultyNames((previous) =>
      previous.includes(name) ? previous.filter((entry) => entry !== name) : [...previous, name],
    );
  }

  /**
   * Save the day's Leaves: replace the registry rows for that day and patch the
   * result into the schedule so the cell and the slot dropdowns update in place.
   */
  async function saveLeaves() {
    if (!programId || !leavesEditDay) return;
    setSavingLeaves(true);
    setActionError(null);
    setFeedback(null);
    try {
      const day = leavesEditDay;
      const updated = await updateDayAbsences({
        program_id: programId,
        cycle_id: cycle?.id ?? null,
        day_of_week: day,
        leave_type: leavesLeaveType,
        coverage_notes: leavesNotes.trim() || null,
        residents: leavesResidentNames.map((name) => ({
          resident_id: residentIdByName.get(name),
          resident_name: name,
        })),
        faculty: leavesFacultyNames.map((name) => ({
          faculty_id: facultyIdByName.get(name),
          faculty_name: name,
        })),
      });
      const weekday = weekdayIndex(day);
      schedule.setData((current) =>
        current
          ? {
              ...current,
              absences: [
                ...(current.absences ?? []).filter((row) => !dayOfWeekMatches(row.day_of_week, weekday)),
                ...updated,
              ],
            }
          : current,
      );
      const total = updated.length;
      setFeedback(total > 0 ? `${day} leave saved: ${total} person(s) away.` : `${day} leave cleared.`);
      setLeavesEditDay(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the leave record.');
    } finally {
      setSavingLeaves(false);
    }
  }

  function openBackups(day: DayName) {
    if (historyMode) return;
    const existing = (data?.backups[day] ?? []).map((entry) => entry.faculty_name ?? '');
    const draft = [...existing];
    while (draft.length < BACKUP_POOL_MIN) draft.push('');
    setBackupDraft(draft.slice(0, BACKUP_POOL_MAX));
    setBackupEditDay(day);
    setActionError(null);
    setFeedback(null);
  }

  async function saveBackups() {
    if (!programId || !backupEditDay) return;
    setSaving(true);
    setActionError(null);
    setFeedback(null);
    try {
      const facultyList = backupDraft
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ faculty_name: name, faculty_id: facultyIdByName.get(name) ?? null }));
      await updateBackupFaculty({
        program_id: programId,
        cycle_id: cycle?.id,
        day_of_week: backupEditDay,
        faculty_list: facultyList,
      });
      setFeedback(`${backupEditDay} backup pool saved.`);
      setBackupEditDay(null);
      schedule.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save the backup pool.');
    } finally {
      setSaving(false);
    }
  }

  async function runRandomize(day?: DayName) {
    if (!programId) return;
    setSaving(true);
    setActionError(null);
    setFeedback(null);
    try {
      const result = await randomizeSupervisors({
        program_id: programId,
        cycle_id: cycle?.id,
        day_of_week: day,
        rotation_months: Number(rotationValue) || 3,
        randomize: true,
        rationale: rationale.trim() || undefined,
      });
      const scope = day ? `${day}` : 'every CCC day';
      setFeedback(`Rotation refreshed across ${scope}. ${result.updated} slot(s) updated.`);
      schedule.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not rotate supervisors.');
    } finally {
      setSaving(false);
    }
  }


  async function refreshFacultyList() {
    try {
      const list = await fetchFacultySupervisors(programId, { includeInactive: true });
      facultyResource.setData(list as any);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not load faculty list.');
    }
  }

  /**
   * After a bulk upload, re-pull the programme's faculty so the new preceptors
   * populate every In-Charge and Supervising Faculty dropdown without a reload.
   */
  async function handleFacultyImported() {
    await refreshFacultyList();
  }

  function openFacultyManager() {
    if (historyMode) return;
    setFacultyMgrOpen(true);
    setFacultyEditing(null);
    setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '', clinicalTitle: '', facultyAppointment: '', administrativeRole: '' });
    setFacultyDeleteTarget(null);
    setActionError(null);
    setFeedback(null);
    void refreshFacultyList();
  }

  function closeFacultyManager() {
    if (savingFaculty || deletingFaculty) return;
    setFacultyMgrOpen(false);
  }

  function startEditFaculty(f: any) {
    setFacultyEditing(f);
    setFacultyForm({
      firstName: f.first_name ?? '',
      lastName: f.last_name ?? '',
      email: f.email ?? '',
      phone: f.phone ?? '',
      specialty: f.specialty ?? '',
      clinicalTitle: f.clinical_title ?? '',
      facultyAppointment: f.faculty_appointment ?? '',
      administrativeRole: f.administrative_role ?? '',
    });
  }

  function cancelEditFaculty() {
    setFacultyEditing(null);
    setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '', clinicalTitle: '', facultyAppointment: '', administrativeRole: '' });
  }

  async function saveFaculty() {
    if (!programId) return;
    setSavingFaculty(true);
    setActionError(null);
    setFeedback(null);
    try {
      if (facultyEditing) {
        const updated = await updateFacultySupervisor(facultyEditing.id, {
          program_id: programId,
          first_name: facultyForm.firstName,
          last_name: facultyForm.lastName,
          email: facultyForm.email || null,
          phone: facultyForm.phone || null,
          specialty: facultyForm.specialty || null,
          clinical_title: facultyForm.clinicalTitle || null,
          faculty_appointment: facultyForm.facultyAppointment || null,
          administrative_role: facultyForm.administrativeRole || null,
        });
        facultyResource.setData((current: any) => (current ?? []).map((x: any) => (x.id === updated.id ? updated : x)) as any);
        setFeedback('Faculty updated.');
        cancelEditFaculty();
      } else {
        const created = await createFacultySupervisor({
          program_id: programId,
          first_name: facultyForm.firstName,
          last_name: facultyForm.lastName,
          email: facultyForm.email || null,
          phone: facultyForm.phone || null,
          specialty: facultyForm.specialty || null,
          clinical_title: facultyForm.clinicalTitle || null,
          faculty_appointment: facultyForm.facultyAppointment || null,
          administrative_role: facultyForm.administrativeRole || null,
          is_active: 1,
        });
        facultyResource.setData((current: any) => [created, ...(current ?? [])] as any);
        setFeedback('Faculty added.');
        setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '', clinicalTitle: '', facultyAppointment: '', administrativeRole: '' });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not save faculty.');
    } finally {
      setSavingFaculty(false);
    }
  }

  async function confirmDeleteFaculty() {
    if (!facultyDeleteTarget || !programId) return;
    setDeletingFaculty(true);
    setActionError(null);
    setFeedback(null);
    try {
      await deleteFacultySupervisor(facultyDeleteTarget.id, programId);
      facultyResource.setData((current: any) =>
        (current ?? []).map((x: any) => (x.id === facultyDeleteTarget.id ? { ...x, is_active: 0 } : x)) as any,
      );
      setFeedback('Faculty deactivated.');
      setFacultyDeleteTarget(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete faculty.');
    } finally {
      setDeletingFaculty(false);
    }
  }

  function withCurrent(options: SelectOption<string>[], current: string): SelectOption<string>[] {
    const trimmed = current.trim();
    if (!trimmed || options.some((option) => option.value === trimmed)) return options;
    return [{ value: trimmed, label: trimmed }, ...options];
  }

  /**
   * The 24-hour session window for a day, straight from the curriculum rows —
   * e.g. "10:30 – 14:00". The roster shows this unless the stored daily header
   * carries its own shift time.
   */
  function sessionWindow(day: DayName): string {
    const weekday = weekdayIndex(day);
    const curriculum = CCC_SCHEDULE_ROWS.find((row) => row.weekday === weekday);
    return `${curriculum?.startTime ?? '10:30'} – ${curriculum?.endTime ?? '14:00'}`;
  }

  /** Title-free display name -> PGY level, so the roster can badge each resident. */
  const residentPgyByName = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const resident of residentsResource.data ?? []) {
      const name = residentFullName(resident).replace(/^Dr\.?\s+/i, '').trim();
      if (!name || map.has(name)) continue;
      map.set(name, resident.pgy_level ?? null);
    }
    return map;
  }, [residentsResource.data]);

  /**
   * The matrix columns: the numbered clinic columns from the schedule, plus the
   * Leaves column at the end. Recomputed so an add, rename or remove is shown
   * immediately after a schedule refresh.
   */
  const matrixColumns = useMemo(
    () => buildMatrixColumns(data?.columns ?? []),
    [data?.columns],
  );

  /** The absences recorded for one CCC day, residents and faculty together. */
  function absencesForDay(day: DayName): PrimaryCareAbsence[] {
    const weekday = weekdayIndex(day);
    return (data?.absences ?? []).filter((row) => dayOfWeekMatches(row.day_of_week, weekday));
  }

  /** Resident names marked away on a day, title-free to match the dropdowns. */
  function absentResidentNamesForDay(day: DayName): Set<string> {
    return new Set(
      absencesForDay(day)
        .filter((row) => row.person_type === 'RESIDENT')
        .map((row) => row.person_name.replace(/^Dr\.?\s+/i, '').trim()),
    );
  }

  /** Faculty names marked away on a day, kept in their stored `Dr.` form. */
  function absentFacultyNamesForDay(day: DayName): Set<string> {
    return new Set(
      absencesForDay(day)
        .filter((row) => row.person_type === 'FACULTY')
        .map((row) => row.person_name.trim()),
    );
  }

  /**
   * The resident dropdown for one clinic slot.
   *
   * A CCC day carries a training level (PGY-1/2/3). Its slots may draw only from
   * residents enrolled at that exact level, so a PGY-3 Sunday cannot be staffed
   * by a PGY-1. A mixed session — FMC, ALL or an unrecognised value — is not a
   * single level, so every active resident is offered. Anyone recorded absent
   * that day is hidden, and so is anyone not currently active.
   */
  function residentOptionsForSlot(
    day: DayName,
    pgyLevel: string | null | undefined,
  ): SelectOption<string>[] {
    const absent = absentResidentNamesForDay(day);
    const level = pgyLevelFromLabel(pgyLevel);
    return [
      { value: NONE_RESIDENT, label: '— Unassigned —' },
      ...residentRoster
        .filter((entry) => entry.active)
        .filter((entry) => level === null || entry.pgyLevel === level)
        .filter((entry) => !absent.has(entry.name))
        .map((entry) => ({ value: entry.name, label: entry.name })),
    ];
  }

  /**
   * The empty-state sentence for a slot whose day names a level no active
   * resident is enrolled at, or null while the list is worth showing.
   */
  function slotResidentNotice(pgyLevel: string | null | undefined): string | null {
    const level = pgyLevelFromLabel(pgyLevel);
    if (level === null) return null;
    const hasLevel = residentRoster.some((entry) => entry.active && entry.pgyLevel === level);
    return hasLevel ? null : `No active ${formatPgy(level)} residents found for this program`;
  }

  /** The faculty dropdown for a day, minus anyone recorded as away that day. */
  function facultyOptionsForDay(day: DayName): SelectOption<string>[] {
    const absent = absentFacultyNamesForDay(day);
    if (absent.size === 0) return facultyOptions;
    return facultyOptions.filter((option) => option.value === NONE_FACULTY || !absent.has(option.value));
  }

  /** Append a new numbered clinic column at the end of the grid. */
  async function addMatrixColumn() {
    if (!programId) return;
    setSavingColumn(true);
    setActionError(null);
    setFeedback(null);
    try {
      await addClinicColumn(programId);
      setFeedback('A new clinic column was added at the end. Tap its header to rename it.');
      schedule.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not add a clinic column.');
    } finally {
      setSavingColumn(false);
    }
  }

  /** Open the rename/remove sheet for one clinic column. */
  function openColumnManage(column: MatrixColumn) {
    if (historyMode) return;
    setColumnManage(column);
    setColumnLabelValue(
      column.title === defaultColumnLabel(column.clinicNumber) ? '' : column.title,
    );
    setActionError(null);
    setFeedback(null);
  }

  function closeColumnManage() {
    if (savingColumn || removingColumn) return;
    setColumnManage(null);
  }

  /** Rename the column being edited; an empty label reverts to "Clinic N". */
  async function saveColumnRename() {
    if (!programId || !columnManage) return;
    setSavingColumn(true);
    setActionError(null);
    setFeedback(null);
    try {
      await renameClinicColumn(programId, columnManage.clinicNumber, columnLabelValue.trim());
      setFeedback(`${columnManage.title} column updated.`);
      setColumnManage(null);
      schedule.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Could not rename this clinic column.',
      );
    } finally {
      setSavingColumn(false);
    }
  }

  /** Remove the column being edited. Its historical slots are preserved. */
  async function confirmRemoveColumn() {
    if (!programId || !columnManage) return;
    setRemovingColumn(true);
    setActionError(null);
    setFeedback(null);
    try {
      await deleteClinicColumn(programId, columnManage.clinicNumber);
      setFeedback(`${columnManage.title} column removed. Its historical slots are preserved.`);
      setColumnManage(null);
      schedule.refresh();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'Could not remove this clinic column.',
      );
    } finally {
      setRemovingColumn(false);
    }
  }

  const isLoading = schedule.isLoading && !data;

  /** The rotation-window badge, e.g. `12 Weeks (Sun, Oct 11, 2026 – Sat, Jan 02, 2027)`. */
  const durationBadge = rotation
    ? formatWeekSpan(rotation.totalWeeks, rotation.startDate, rotation.endDate)
    : null;

  /**
   * The matrix header bar's one-line summary of the cycle. The session shown is
   * the week's opening day — the same day the "Starts:" fragment names.
   */
  const headerBarDay = activeDays[0] ?? daySequence[0] ?? DAYS[0];
  const headerBarHeader = headerForDay(headerBarDay);
  const headerBarText = formatCycleMetadataBanner({
    cycleNumber: cycle?.cycle_number,
    weekNumber: cycle?.week_number,
    startsOn: dayNameOf(cycle?.start_date ?? null),
    startDate: cycle?.start_date,
    shiftTime: headerBarHeader?.shift_time ?? DAY_CONFIG[headerBarDay].shift,
    pgyLevel: headerBarHeader?.pgy_level ?? DAY_CONFIG[headerBarDay].pgy,
  });

  /** The level-filtered resident list for the slot sheet currently open. */
  const slotResidentOptions = slotEdit
    ? residentOptionsForSlot(slotEdit.day, slotEdit.pgyLevel)
    : residentOptions;
  const slotResidentNoticeText = slotEdit ? slotResidentNotice(slotEdit.pgyLevel) : null;

  // Built from the same cycle-schedule payload the matrix renders, so the
  // exported file lists the same days, clinics and leaves as the screen.
  const reportModel = useMemo(
    () =>
      data
        ? buildCccMatrixReport({
            schedule: data,
            programLabel: session?.programLabel ?? 'Programme',
            programCode: session?.programCode ?? null,
          })
        : null,
    [data, session?.programLabel, session?.programCode],
  );

  async function handleExport(format: Parameters<typeof downloadScheduleReport>[1]) {
    if (!reportModel) throw new Error('There is no cycle schedule to export yet.');
    const { confirmation } = await downloadScheduleReport(reportModel, format, reportRef);
    return confirmation;
  }

  return (
    <Screen
      onRefresh={() => {
        schedule.refresh();
        cycles.refresh();
        facultyResource.refresh();
      }}
      refreshing={schedule.isRefreshing || cycles.isRefreshing || facultyResource.isRefreshing}
    >
      <AppHeader
        title="Continuity Care Clinics"
        subtitle="Weekly clinic matrix, supervisors and backup faculty"
        onBack={goBack}
      />

      {cycleOptions.length > 1 ? (
        <SegmentedControl
          label="Cycle history"
          value={selectedCycleId === null ? '' : String(selectedCycleId)}
          onChange={(value) => setSelectedCycleId(value === '' ? null : Number(value))}
          options={cycleOptions}
          scroll
          hint="Pick a past cycle to review it as it was run. Past cycles open read-only, so an edit can never land on the wrong week."
        />
      ) : null}

      {historyMode ? (
        <Banner
          tone="info"
          title="Viewing a past cycle"
          message="This cycle is shown read-only. Switch to Current to edit the live clinic schedule."
        />
      ) : null}

      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Clinic schedule view"
        style={styles.viewToggle}
      >
        {VIEW_MODE_OPTIONS.map((option) => {
          const active = viewMode === option.value;
          return (
            <Pressable
              key={option.value}
              onPress={() => setViewMode(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.viewToggleOption,
                active ? styles.viewToggleOptionActive : null,
                pressed && !active ? styles.viewToggleOptionPressed : null,
              ]}
            >
              <Text variant="button" align="center" tone={active ? 'brand' : 'secondary'}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Button
        label="Export & download"
        variant="secondary"
        icon={Download}
        onPress={() => setExportOpen(true)}
        disabled={!reportModel}
        accessibilityHint="Download this CCC clinic matrix as Excel, PDF, Word or an image."
      />

      {actionError ? (
        <Banner tone="danger" title="Something went wrong" message={actionError} />
      ) : null}
      {feedback ? <Banner tone="success" title="Saved" message={feedback} /> : null}
      {schedule.error ? (
        <Banner tone="danger" title="Could not load the schedule" message={schedule.error.message} />
      ) : null}

      {isLoading ? (
        <Card>
          <Text variant="bodySmall" tone="secondary">
            Loading the current cycle…
          </Text>
        </Card>
      ) : null}

      {data ? (
        <>
          <Card>
            <SectionHeader title="Supervisor Randomisation & Rotation" />
            <Text variant="caption" tone="muted" style={styles.note}>
              Cycle metadata, the rotation window and each day&apos;s boundary are saved together.
              Week End Date and Total Weeks follow the master rotation rule of four weeks per
              month; randomisation then redistributes supervising faculty across clinic slots and
              records every reassignment with your rationale.
            </Text>
            <View style={styles.row}>
              <View style={styles.half}>
                <TextField
                  label="Cycle Number"
                  value={cycle?.cycle_number ?? ''}
                  onChangeText={(value) => updateCycleField({ cycle_number: value })}
                  editable={!historyMode}
                  placeholder="1"
                />
              </View>
              <View style={styles.half}>
                <TextField
                  label="Week Number"
                  value={cycle?.week_number ?? ''}
                  onChangeText={(value) => updateCycleField({ week_number: value })}
                  editable={!historyMode}
                  placeholder="1"
                />
              </View>
            </View>

            <View style={styles.row}>
              <View style={styles.half}>
                <TextField
                  label="Rotation Window (Months)"
                  value={rotationValue}
                  onChangeText={(value) => {
                    setRotationTouched(true);
                    setRotationMonths(value);
                  }}
                  editable={!historyMode}
                  keyboardType="number-pad"
                  placeholder="3"
                  hint="Converted at 4 weeks per month."
                />
              </View>
              <View style={styles.half}>
                <Text variant="label" tone="secondary" uppercase>
                  Duration / Total Weeks
                </Text>
                <View style={styles.durationBadge}>
                  <Text variant="label" tone="brand">
                    {durationBadge ?? (rotation ? `${Math.round(rotation.totalWeeks)} Weeks` : 'Not set')}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.dateRangeRow}>
              <View style={styles.half}>
                <DateField
                  label="Week Start Date"
                  value={cycle?.start_date ?? ''}
                  onChangeText={(value) => updateCycleField({ start_date: value })}
                  editable={!historyMode}
                  weekStartDay="SUNDAY"
                  durationWeeks={rotation ? Math.round(rotation.totalWeeks) : null}
                  placeholder="YYYY-MM-DD"
                  hint="First day of the academic week this cycle opens on."
                />
              </View>
              <View style={styles.half}>
                <TextField
                  label="Week End Date"
                  value={rotation?.endDate ?? ''}
                  onChangeText={() => undefined}
                  editable={false}
                  placeholder="YYYY-MM-DD"
                  hint={
                    rotation
                      ? `Starts on ${rotation.startsOn}, ends on ${rotation.endsOn}.`
                      : 'Set a start date and rotation window.'
                  }
                />
              </View>
            </View>

            <TextField
              label="Rationale"
              value={rationale}
              onChangeText={setRationale}
              multiline
              placeholder="e.g. Q3 fair rotation across PGY-2 faculty"
              hint="Recorded against every reassignment when you randomize."
            />

            <View style={styles.actionRow}>
              <Button
                label="Randomize All Days"
                icon={Shuffle}
                onPress={() => runRandomize()}
                loading={saving}
                disabled={saving || historyMode}
                style={styles.flex1}
              />
              <Button
                label="Save Cycle Header"
                onPress={saveHeader}
                loading={saving}
                disabled={saving || historyMode}
                style={styles.flex1}
              />
            </View>
            <Button
              label="Manage Faculty Preceptors"
              variant="outline"
              onPress={openFacultyManager}
              disabled={saving || historyMode}
              style={{ marginTop: spacing.sm }}
            />
            <Text variant="label" tone="secondary" uppercase style={styles.scopeLabel}>
              Rotate a single day
            </Text>
            <View style={styles.actionRow}>
              {activeDays.map((day) => (
                <Button
                  key={day}
                  label={DAY_SHORT[day]}
                  variant="outline"
                  fullWidth={false}
                   onPress={() => runRandomize(day)}
                   disabled={saving || historyMode}
                />
              ))}
            </View>
          </Card>

          {viewMode === 'matrix' ? (
            <Card padded={false}>
              <View style={styles.cardPad}>
                <Pressable
                  onPress={openMetadata}
                  disabled={historyMode}
                  accessibilityRole="button"
                  accessibilityLabel={`Cycle and schedule metadata: ${headerBarText}`}
                  accessibilityState={{ disabled: historyMode }}
                  accessibilityHint="Opens a sheet to edit the cycle, week, first day, start date and session times"
                  style={({ pressed }) => [
                    styles.metadataBanner,
                    pressed ? styles.cellPressed : null,
                  ]}
                >
                  <View style={styles.metadataBannerText}>
                    <Text variant="label" tone="secondary" uppercase>
                      Cycle & Schedule Metadata
                    </Text>
                    <Text variant="bodySmall" style={styles.metadataBannerSummary}>
                      {headerBarText}
                    </Text>
                  </View>
                  <Pencil color={colors.primary} size={16} />
                </Pressable>
                <Button
                  label="EDIT CYCLE & SCHEDULE METADATA"
                  icon={Pencil}
                  variant="outline"
                  onPress={openMetadata}
                  disabled={savingMetadata || historyMode}
                  style={styles.metadataEditButton}
                />
                <SectionHeader title="Weekly Clinic Matrix" trailing={`${activeDays.length} days`} />
                <Text variant="caption" tone="muted">
                  The week runs from the cycle&apos;s Week Start Date, so a Monday start reads
                  Monday–Sunday. Tap a day&apos;s header to edit its day, shift time, PGY level and
                  In-Charge faculty; use Add day to extend the week or Remove row to drop one. Tap a
                  clinic cell to assign up to two residents and supervising faculty. The columns are
                  numbered clinic positions — add one, or tap a column header to rename or remove it.
                  The final Leaves column records who is away, and anyone marked away is hidden from
                  that day&apos;s dropdowns.
                </Text>
                <Button
                  label={savingColumn ? 'Adding…' : 'Add clinic column'}
                  icon={Plus}
                  variant="outline"
                  fullWidth={false}
                  onPress={addMatrixColumn}
                  disabled={savingColumn || historyMode}
                  style={styles.matrixAddColumnButton}
                />
              </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.matrixScroll}
            >
              <View>
                <View style={styles.matrixHeaderRow}>
                  <View style={[styles.dayCol, styles.frozen, styles.headerCell]}>
                    <Text variant="label" tone="secondary" uppercase>
                      Day
                    </Text>
                    <Pressable
                      onPress={openAddDay}
                      disabled={missingDays.length === 0 || savingDay || historyMode}
                      accessibilityRole="button"
                      accessibilityLabel="Add a day row to the CCC week"
                      accessibilityState={{ disabled: missingDays.length === 0 }}
                      style={({ pressed }) => [
                        styles.addDayButton,
                        missingDays.length === 0 ? styles.dayActionDisabled : null,
                        pressed && missingDays.length > 0 ? styles.cellPressed : null,
                      ]}
                    >
                      <Plus color={missingDays.length > 0 ? colors.primary : colors.textMuted} size={12} />
                      <Text
                        variant="caption"
                        tone={missingDays.length > 0 ? 'brand' : 'muted'}
                      >
                        Add day
                      </Text>
                    </Pressable>
                  </View>
                  {matrixColumns.map((column) => {
                    const inner = (
                      <>
                        <Text variant="label" numberOfLines={2} align="center">
                          {column.title}
                        </Text>
                        {column.subtitle ? (
                          <Text variant="caption" tone="secondary" numberOfLines={1} align="center">
                            {column.subtitle}
                          </Text>
                        ) : null}
                      </>
                    );
                    if (column.isLeaves) {
                      return (
                        <View
                          key={column.key}
                          style={[styles.colHeader, styles.headerCell, styles.specialColumn]}
                        >
                          {inner}
                        </View>
                      );
                    }
                    return (
                      <Pressable
                        key={column.key}
                        onPress={() => openColumnManage(column)}
                        accessibilityRole="button"
                        accessibilityLabel={`Manage ${column.title} clinic column`}
                        accessibilityHint="Opens a sheet to rename or remove this clinic column"
                        style={({ pressed }) => [
                          styles.colHeader,
                          styles.headerCell,
                          pressed ? styles.cellPressed : null,
                        ]}
                      >
                        {inner}
                      </Pressable>
                    );
                  })}
                </View>

                {activeDays.map((day) => {
                  const header = headerForDay(day);
                  const shiftLabel = header?.shift_time || DAY_CONFIG[day].shift;
                  const pgyLabel = header?.pgy_level || DAY_CONFIG[day].pgy;
                  const inCharge = withDoctorTitle(header?.in_charge_faculty_name);
                  const rowNumber = activeDays.indexOf(day) + 1;
                  const dayDate = weekDayDate(cycle?.start_date ?? null, rowNumber - 1);
                  return (
                    <View key={day} style={styles.matrixRow}>
                      <View style={[styles.dayCol, styles.frozen, styles.bodyCell, styles.dayCellBlock]}>
                        <Pressable
                          onPress={() => openHeader(day)}
                          accessibilityRole="button"
                          accessibilityLabel={`${day} daily header, day ${rowNumber} of ${activeDays.length}. Shift ${shiftLabel}. ${pgyLabel}. Faculty in charge ${
                            inCharge || 'unassigned'
                          }. Opens the daily header editor.`}
                          accessibilityHint="Opens a sheet to edit the day, shift time, PGY level and In-Charge faculty"
                          style={({ pressed }) => [
                            styles.dayCellMain,
                            pressed ? styles.cellPressed : null,
                          ]}
                        >
                          <Text variant="bodySmall" style={styles.dayName}>
                            {DAY_SHORT[day]}
                          </Text>
                          <Text variant="caption" tone="secondary" numberOfLines={1}>
                            {formatShortDate(dayDate)}
                          </Text>
                          <Text variant="caption" tone="secondary" numberOfLines={1}>
                            {shiftLabel}
                          </Text>
                          <Text variant="caption" tone="brand" numberOfLines={1}>
                            {pgyLabel}
                          </Text>
                          <Text
                            variant="caption"
                            tone={inCharge ? 'secondary' : 'muted'}
                            numberOfLines={2}
                            style={styles.inCharge}
                          >
                            {`Faculty In-charge: ${inCharge || 'Unassigned'}`}
                          </Text>
                        </Pressable>
                        {activeDays.length > 1 ? (
                          <Pressable
                            onPress={() => setDayRemoveTarget(day)}
                            disabled={savingDay || historyMode}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove the ${day} row from the CCC week`}
                            style={({ pressed }) => [
                              styles.dayRemoveRow,
                              pressed && !savingDay ? styles.cellPressed : null,
                            ]}
                          >
                            <Minus color={colors.danger} size={12} />
                            <Text variant="caption" tone="danger">
                              Remove row
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>

                      {matrixColumns.map((column) => {
                        if (column.isLeaves) {
                          const dayAbsences = absencesForDay(day);
                          const awayNames = dayAbsences.map((row) => row.person_name);
                          const hasAbsences = awayNames.length > 0;
                          return (
                            <Pressable
                              key={column.key}
                              onPress={() => openLeaves(day)}
                              accessibilityRole="button"
                              accessibilityLabel={`${day} Leaves. ${
                                hasAbsences ? `${awayNames.length} away: ${awayNames.join(', ')}` : 'No one away'
                              }. Opens the leave editor.`}
                              style={({ pressed }) => [
                                styles.cell,
                                styles.bodyCell,
                                styles.specialColumn,
                                pressed ? styles.cellPressed : null,
                              ]}
                            >
                              <Text
                                variant="bodySmall"
                                tone={hasAbsences ? 'primary' : 'disabled'}
                                numberOfLines={1}
                              >
                                {hasAbsences ? `${awayNames.length} away` : 'No leave'}
                              </Text>
                              {hasAbsences ? (
                                <Text
                                  variant="caption"
                                  tone="secondary"
                                  numberOfLines={3}
                                  style={styles.cellFaculty}
                                >
                                  {awayNames.join(', ')}
                                </Text>
                              ) : null}
                            </Pressable>
                          );
                        }

                        const slot =
                          column.clinicNumber == null ? null : slotFor(day, column.clinicNumber);
                        const residents = [slot?.resident_1_name, slot?.resident_2_name].filter(
                          (name): name is string => Boolean(name),
                        );
                        const faculty = slot?.faculty_name ?? null;
                        const hasResidents = residents.length > 0;
                        return (
                          <Pressable
                            key={column.key}
                            onPress={() =>
                              openSlot({
                                slot,
                                day,
                                columnLabel: column.title,
                                clinicNumber: column.clinicNumber ?? 0,
                                shiftTime: header?.shift_time ?? DAY_CONFIG[day].shift,
                                pgyLevel: header?.pgy_level ?? DAY_CONFIG[day].pgy,
                              })
                            }
                            accessibilityRole="button"
                            accessibilityLabel={`${day} ${column.title}. ${
                              hasResidents ? residents.join(', ') : 'Unassigned'
                            }${faculty ? `, supervised by ${faculty}` : ''}. Opens the editor.`}
                            style={({ pressed }) => [
                              styles.cell,
                              styles.bodyCell,
                              column.special ? styles.specialColumn : null,
                              pressed ? styles.cellPressed : null,
                            ]}
                          >
                            <Text
                              variant="bodySmall"
                              tone={hasResidents ? 'primary' : 'disabled'}
                              numberOfLines={3}
                            >
                              {hasResidents ? residents.join(' / ') : 'Unassigned'}
                            </Text>
                            {faculty ? (
                              <Text
                                variant="caption"
                                tone="secondary"
                                numberOfLines={2}
                                style={styles.cellFaculty}
                              >
                                {faculty}
                              </Text>
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          </Card>
        ) : (
          <Card padded={false}>
            <View style={styles.cardPad}>
              <SectionHeader title="Operational Roster" trailing={`${activeDays.length} sessions`} />
              <Text variant="caption" tone="muted">
                Rows are grouped into session blocks under one day/time heading. Tap any row to assign
                up to two residents and supervising faculty.
              </Text>
            </View>
            <View style={styles.rosterHeaderRow}>
              <View style={[styles.rosterHeaderCell, styles.rosterHeaderDay]}>
                <Text variant="label" tone="secondary" uppercase>
                  Day / Time & Session
                </Text>
              </View>
              <View style={[styles.rosterHeaderCell, styles.rosterHeaderClinic]}>
                <Text variant="label" tone="secondary" uppercase>
                  Clinic
                </Text>
              </View>
              <View style={[styles.rosterHeaderCell, styles.rosterHeaderResidents]}>
                <Text variant="label" tone="secondary" uppercase>
                  Resident(s) & PGY
                </Text>
              </View>
              <View style={[styles.rosterHeaderCell, styles.rosterHeaderFaculty]}>
                <Text variant="label" tone="secondary" uppercase>
                  Supervising Faculty
                </Text>
              </View>
            </View>
            {activeDays.map((day) => {
              const header = headerForDay(day);
              const shiftLabel = header?.shift_time || sessionWindow(day);
              const pgyLabel = header?.pgy_level || DAY_CONFIG[day].pgy;
              return (
                <View key={day}>
                  {matrixColumns.map((column, columnIndex) => {
                    const isLeaves = column.isLeaves;
                    const dayAbsences = isLeaves ? absencesForDay(day) : [];
                    const slot =
                      column.clinicNumber == null ? null : slotFor(day, column.clinicNumber);
                    const residents = isLeaves
                      ? dayAbsences.map((row) => row.person_name)
                      : [slot?.resident_1_name, slot?.resident_2_name].filter(
                          (name): name is string => Boolean(name),
                        );
                    const faculty = withDoctorTitle(slot?.faculty_name);
                    const facultySummary = isLeaves
                      ? Array.from(new Set(dayAbsences.map((row) => leaveTypeLabel(row.leave_type)))).join(', ')
                      : faculty;
                    const inCharge = withDoctorTitle(header?.in_charge_faculty_name);
                    const isSessionStart = columnIndex === 0;
                    const clinicLabel = isLeaves
                      ? 'Leaves'
                      : column.special && column.subtitle
                        ? column.subtitle
                        : column.title;
                    return (
                      <View key={column.key} style={styles.rosterRow}>
                        {/* Column 1 is the session block: the day, its PGY badge
                            and the daily in-charge faculty, with the exact same
                            prefix the Matrix grid uses. Tapping it opens the
                            daily header editor; the other columns open the slot
                            editor, so the two are separate pressables rather
                            than one nested target. */}
                        {isSessionStart ? (
                          <Pressable
                            onPress={() => openHeader(day)}
                            accessibilityRole="button"
                            accessibilityLabel={`${day} session, ${shiftLabel}, ${pgyLabel}. Faculty in charge ${
                              inCharge || 'unassigned'
                            }. Opens the daily header editor.`}
                            accessibilityHint="Opens a sheet to edit the day, shift time, PGY level and In-Charge faculty"
                            style={({ pressed }) => [
                              styles.rosterDayCell,
                              styles.rosterSessionStart,
                              pressed ? styles.cellPressed : null,
                            ]}
                          >
                            <Text variant="bodySmall" style={styles.rosterDayText}>
                              {day}, {shiftLabel}
                            </Text>
                            <PgyBadge label={pgyLabel} />
                            <Text
                              variant="caption"
                              tone={inCharge ? 'secondary' : 'muted'}
                              numberOfLines={2}
                              style={styles.inCharge}
                            >
                              {`Faculty In-charge: ${inCharge || 'Unassigned'}`}
                            </Text>
                          </Pressable>
                        ) : (
                          <View style={styles.rosterDayCell} />
                        )}
                        <Pressable
                          onPress={() =>
                            isLeaves
                              ? openLeaves(day)
                              : openSlot({
                                  slot,
                                  day,
                                  columnLabel: clinicLabel,
                                  clinicNumber: column.clinicNumber ?? 0,
                                  shiftTime: header?.shift_time ?? DAY_CONFIG[day].shift,
                                  pgyLevel: header?.pgy_level ?? DAY_CONFIG[day].pgy,
                                })
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`${day} ${clinicLabel}. ${
                            residents.length ? residents.join(', ') : 'Unassigned'
                          }${facultySummary ? `, ${facultySummary}` : ''}. Opens the editor.`}
                          accessibilityHint={
                            isLeaves
                              ? 'Opens the leave editor for this day'
                              : 'Opens a sheet to edit residents and supervising faculty'
                          }
                          style={({ pressed }) => [
                            styles.rosterRest,
                            pressed ? styles.cellPressed : null,
                          ]}
                        >
                          <View style={styles.rosterClinicCell}>
                            <Text variant="bodySmall" tone="primary" numberOfLines={2}>
                              {clinicLabel}
                            </Text>
                          </View>
                          <View style={styles.rosterResidentsCell}>
                            {residents.length > 0 ? (
                              residents.map((name, residentIndex) => (
                                <View key={`${name}-${residentIndex}`} style={styles.residentLine}>
                                  <Text variant="bodySmall" numberOfLines={1}>
                                    {name}
                                  </Text>
                                  {!isLeaves && residentPgyByName.get(name) != null ? (
                                    <PgyBadge label={formatPgy(residentPgyByName.get(name) ?? null)} />
                                  ) : null}
                                </View>
                              ))
                            ) : (
                              <Text variant="bodySmall" tone="disabled">
                                {isLeaves ? 'No one away' : 'Unassigned'}
                              </Text>
                            )}
                          </View>
                          <View style={styles.rosterFacultyCell}>
                            {facultySummary ? (
                              <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
                                {facultySummary}
                              </Text>
                            ) : (
                              <Text variant="bodySmall" tone="muted">
                                {isLeaves ? '—' : '— None —'}
                              </Text>
                            )}
                          </View>
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </Card>
        )}

        <Card>
          <SectionHeader title="Backup / Catchup Faculty Pools" />
            <Text variant="caption" tone="muted" style={styles.note}>
              Backup faculty are exempt from regular supervision unless a scheduled supervisor is
              absent, in which case they cover the slot.
            </Text>
            {BACKUP_DAYS.map((day) => {
              const pool = data.backups[day] ?? [];
              const names = pool
                .map((entry) => entry.faculty_name)
                .filter((name): name is string => Boolean(name));
              return (
                <View key={day} style={styles.backupRow}>
                  <View style={styles.flex1}>
                    <Text variant="bodySmall">{day} catchup</Text>
                    <Text variant="caption" tone="secondary" numberOfLines={2}>
                      {names.length ? names.join('  |  ') : 'No backup faculty set yet.'}
                    </Text>
                  </View>
                  <Button
                    label={backupEditDay === day ? 'Editing' : 'Edit'}
                    variant="outline"
                    fullWidth={false}
                    onPress={() => openBackups(day)}
                    disabled={saving}
                  />
                </View>
              );
            })}

            {backupEditDay ? (
              <View style={styles.backupEditor}>
                <Text variant="label" tone="secondary" uppercase>
                  {backupEditDay} backup pool ({BACKUP_POOL_MIN}–{BACKUP_POOL_MAX})
                </Text>
                {backupDraft.map((name, index) => (
                  <View key={`${backupEditDay}-${index}`} style={styles.backupRowInner}>
                    <View style={styles.flex1}>
                      <SheetSelectField
                        label={`Backup ${index + 1}`}
                        value={name || NONE_FACULTY}
                        options={withCurrent(facultyOptions, name)}
                        onChange={(value) =>
                          setBackupDraft((previous) =>
                            previous.map((entry, position) => (position === index ? value : entry)),
                          )
                        }
                        placeholder="— None —"
                      />
                    </View>
                    {backupDraft.length > 1 ? (
                      <IconButton
                        icon={Trash2}
                        
                        accessibilityLabel={`Remove backup ${index + 1}`}
                        onPress={() =>
                          setBackupDraft((previous) =>
                            previous.filter((_, position) => position !== index),
                          )
                        }
                        style={styles.backupRemove}
                      />
                    ) : null}
                  </View>
                ))}
                <View style={styles.actionRow}>
                  {backupDraft.length < BACKUP_POOL_MAX ? (
                    <Button
                      label="Add backup"
                      variant="outline"
                      icon={Plus}
                      fullWidth={false}
                      onPress={() => setBackupDraft((previous) => [...previous, ''])}
                      style={styles.flex1}
                    />
                  ) : null}
                  <Button
                    label="Save pool"
                    onPress={saveBackups}
                    loading={saving}
                    disabled={saving}
                    fullWidth={false}
                    style={styles.flex1}
                  />
                  <Button
                    label="Cancel"
                    variant="outline"
                    fullWidth={false}
                    onPress={() => setBackupEditDay(null)}
                    style={styles.flex1}
                  />
                </View>
              </View>
            ) : null}
          </Card>
        </>
      ) : null}

      <Sheet
        visible={Boolean(headerEdit)}
        onClose={closeHeader}
        title="EDIT DAILY HEADER & IN-CHARGE FACULTY"
        subtitle={headerEdit ? `${headerEdit.day} · weekly CCC day` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label="Save Header"
              onPress={saveDailyHeader}
              loading={saving}
              disabled={saving}
              style={styles.flex1}
            />
            <Button label="Cancel" variant="outline" onPress={closeHeader} style={styles.flex1} />
          </View>
        }
      >
        {headerEdit ? (
          <>
            <SheetSelectField
              label="Day of Week"
              value={headerForm.dayOfWeek}
              options={dayOptions}
              onChange={(value) => setHeaderForm((previous) => ({ ...previous, dayOfWeek: value }))}
              placeholder="Choose a day"
              hint={`The CCC week runs ${daySequence[0]} to ${daySequence[daySequence.length - 1]}.`}
            />
            <TextField
              label="Shift Time"
              value={headerForm.shiftTime}
              onChangeText={(value) => setHeaderForm((previous) => ({ ...previous, shiftTime: value }))}
              placeholder={DAY_CONFIG[headerEdit.day].shift}
              autoCapitalize="none"
              hint="e.g. 10:30 - 2:00 or 07:00 - 2:00"
            />
            <SheetSelectField
              label="PGY Level / Context"
              value={headerForm.pgyLevel || null}
              options={withCurrent(PGY_OPTIONS, headerForm.pgyLevel)}
              onChange={(value) => setHeaderForm((previous) => ({ ...previous, pgyLevel: value }))}
              placeholder="Choose a level"
            />
            <SheetSelectField
              label="Faculty In-charge"
              value={headerForm.inChargeFaculty || NONE_FACULTY}
              options={withCurrent(facultyOptions, headerForm.inChargeFaculty)}
              onChange={(value) =>
                setHeaderForm((previous) => ({ ...previous, inChargeFaculty: value }))
              }
              placeholder="— Unassigned —"
              hint="A 'Dr.' title is applied automatically."
            />
            <Button
              label="+ Add / Rename Faculty"
              variant="outline"
              onPress={openFacultyManager}
              fullWidth={false}
              style={{ marginTop: spacing.xs }}
            />
          </>
        ) : null}
      </Sheet>

      <Sheet
        visible={Boolean(slotEdit)}
        onClose={closeSlot}
        title="EDIT CLINIC SLOT"
        subtitle={slotEdit ? `${slotEdit.day} · ${slotEdit.columnLabel}` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label="Save Slot"
              onPress={saveSlot}
              loading={saving}
              disabled={saving}
              style={styles.flex1}
            />
            <Button label="Cancel" variant="outline" onPress={closeSlot} style={styles.flex1} />
          </View>
        }
      >
        {slotEdit ? (
          <>
            <Text variant="caption" tone="secondary" style={styles.note}>
              {(slotEdit.shiftTime || DAY_CONFIG[slotEdit.day].shift) +
                ' · ' +
                (slotEdit.pgyLevel || DAY_CONFIG[slotEdit.day].pgy)}
            </Text>
            {slotResidentNoticeText ? (
              <Banner tone="warning" title="No matching residents" message={slotResidentNoticeText} />
            ) : null}
            <SheetSelectField
              label="Resident 1"
              value={slotForm.resident1 || NONE_RESIDENT}
              options={withCurrent(slotResidentOptions, slotForm.resident1)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, resident1: value }))}
              placeholder="— Unassigned —"
              hint="Only residents at this day's training level are listed. Anyone away that day is hidden."
            />
            <SheetSelectField
              label="Resident 2 (optional)"
              value={slotForm.resident2 || NONE_RESIDENT}
              options={withCurrent(slotResidentOptions, slotForm.resident2)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, resident2: value }))}
              placeholder="— Unassigned —"
              hint="Only residents at this day's training level are listed."
            />
            <SheetSelectField
              label="Supervising Faculty"
              value={slotForm.faculty || NONE_FACULTY}
              options={withCurrent(facultyOptionsForDay(slotEdit.day), slotForm.faculty)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, faculty: value }))}
              placeholder="— None —"
              hint="A 'Dr.' title is applied automatically to faculty members. Faculty away that day are hidden."
            />
            <Button
              label="+ Add New Faculty"
              variant="outline"
              onPress={openFacultyManager}
              fullWidth={false}
              style={{ marginTop: spacing.xs }}
            />
          </>
        ) : null}
      </Sheet>

      <Sheet
        visible={Boolean(leavesEditDay)}
        onClose={closeLeaves}
        title="EDIT LEAVES & ABSENCES"
        subtitle={leavesEditDay ? `${leavesEditDay} · who is away` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label="Save Leaves"
              onPress={saveLeaves}
              loading={savingLeaves}
              disabled={savingLeaves}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={closeLeaves}
              disabled={savingLeaves}
              style={styles.flex1}
            />
          </View>
        }
      >
        {leavesEditDay ? (
          <>
            <Text variant="caption" tone="secondary" style={styles.note}>
              {`Mark everyone away on ${leavesEditDay}. Residents and faculty recorded here are hidden from that day's clinic dropdowns.`}
            </Text>
            <SheetSelectField
              label="Leave reason"
              value={leavesLeaveType}
              options={LEAVE_TYPE_OPTIONS}
              onChange={(value) => setLeavesLeaveType(value)}
              placeholder="Choose a reason"
              hint="Applied to everyone selected below."
            />
            <TextField
              label="Coverage notes (optional)"
              value={leavesNotes}
              onChangeText={setLeavesNotes}
              placeholder="e.g. Dr. X covering; swap arranged"
              multiline
            />

            <SectionHeader
              title="Residents"
              trailing={`${leavesResidentNames.length} selected`}
            />
            <SearchInput
              value={leavesResidentQuery}
              onChangeText={setLeavesResidentQuery}
              placeholder="Search residents"
              accessibilityLabel="Search residents to mark away"
            />
            <View style={styles.catalogList}>
              {residentOptions
                .filter((option) => option.value !== NONE_RESIDENT)
                .filter((option) =>
                  option.value.toLowerCase().includes(leavesResidentQuery.trim().toLowerCase()),
                )
                .map((option) => {
                  const selected = leavesResidentNames.includes(option.value);
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => toggleLeavesResident(option.value)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`Mark ${option.value} away`}
                      style={({ pressed }) => [
                        styles.catalogRow,
                        selected ? styles.catalogRowSelected : null,
                        pressed ? styles.catalogRowPressed : null,
                      ]}
                    >
                      <View style={styles.catalogText}>
                        <Text variant="bodySmall" numberOfLines={1}>
                          {option.value}
                        </Text>
                      </View>
                      {selected ? <Check color={colors.primary} size={18} /> : null}
                    </Pressable>
                  );
                })}
            </View>

            <SectionHeader
              title="Faculty"
              trailing={`${leavesFacultyNames.length} selected`}
            />
            <SearchInput
              value={leavesFacultyQuery}
              onChangeText={setLeavesFacultyQuery}
              placeholder="Search faculty"
              accessibilityLabel="Search faculty to mark away"
            />
            <View style={styles.catalogList}>
              {facultyOptions
                .filter((option) => option.value !== NONE_FACULTY)
                .filter((option) =>
                  option.value.toLowerCase().includes(leavesFacultyQuery.trim().toLowerCase()),
                )
                .map((option) => {
                  const selected = leavesFacultyNames.includes(option.value);
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => toggleLeavesFaculty(option.value)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      accessibilityLabel={`Mark ${option.value} away`}
                      style={({ pressed }) => [
                        styles.catalogRow,
                        selected ? styles.catalogRowSelected : null,
                        pressed ? styles.catalogRowPressed : null,
                      ]}
                    >
                      <View style={styles.catalogText}>
                        <Text variant="bodySmall" numberOfLines={1}>
                          {option.value}
                        </Text>
                      </View>
                      {selected ? <Check color={colors.primary} size={18} /> : null}
                    </Pressable>
                  );
                })}
            </View>
          </>
        ) : null}
      </Sheet>

      <Sheet
        visible={columnManage !== null}
        onClose={closeColumnManage}
        title="Manage Clinic Column"
        subtitle={columnManage ? `${columnManage.title} · clinic column ${columnManage.clinicNumber}` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={savingColumn ? 'Saving…' : 'Save label'}
              onPress={saveColumnRename}
              loading={savingColumn}
              disabled={savingColumn}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={closeColumnManage}
              disabled={savingColumn}
              style={styles.flex1}
            />
          </View>
        }
      >
        <TextField
          label="Column label"
          value={columnLabelValue}
          onChangeText={setColumnLabelValue}
          placeholder={columnManage ? defaultColumnLabel(columnManage.clinicNumber) : 'Clinic N'}
          autoCapitalize="words"
          hint="Blank restores the default name. Renaming never moves this column's slots or assignments."
        />
        <Button
          label={removingColumn ? 'Removing…' : 'Remove column'}
          variant="outline"
          onPress={confirmRemoveColumn}
          disabled={columnManage === null || savingColumn}
          loading={removingColumn}
          style={{ marginTop: spacing.md }}
        />
        <Text variant="caption" tone="muted" style={styles.note}>
          Removing deletes the column from the grid. Its historical slots are preserved.
        </Text>
      </Sheet>
    
      <Sheet
        visible={facultyMgrOpen}
        onClose={closeFacultyManager}
        title="Manage Faculty Preceptors"
        subtitle="Add, edit, rename, or deactivate supervising faculty"
        footer={
          <View style={styles.actionRow}>
            <Button
              label={facultyEditing ? 'Save Faculty' : 'Add Faculty'}
              onPress={saveFaculty}
              loading={savingFaculty}
              disabled={savingFaculty}
              style={styles.flex1}
            />
            <Button label="Close" variant="outline" onPress={closeFacultyManager} style={styles.flex1} />
          </View>
        }
      >
        <ImportTools
          template="faculty"
          downloadLabel="Download Excel Template (.xlsx)"
          uploadLabel="Upload Faculty List (.xlsx)"
          upload={(file) => uploadFacultySupervisors(file, programId)}
          onImported={() => void handleFacultyImported()}
          autoDismissSuccessMs={6000}
          hint="Eight columns: First Name, Last Name, Email, Phone, Specialty, Clinical Title, Faculty Appointment, Admin Role. First and Last Name are required; Specialty defaults to Family Medicine."
        />

        <View style={styles.facultyDivider}>
          <Divider />
          <Text variant="label" tone="secondary" uppercase style={styles.facultyDividerLabel}>
            Or add individual faculty manually
          </Text>
        </View>

        <Card padded>
          <Text variant="label" tone="secondary" uppercase>
            {facultyEditing ? 'Edit Faculty' : 'Add New Faculty'}
          </Text>
          <TextField label="First Name" value={facultyForm.firstName} onChangeText={(v) => setFacultyForm((p) => ({ ...p, firstName: v }))} />
          <TextField label="Last Name" value={facultyForm.lastName} onChangeText={(v) => setFacultyForm((p) => ({ ...p, lastName: v }))} />
          <TextField label="Email" value={facultyForm.email} onChangeText={(v) => setFacultyForm((p) => ({ ...p, email: v }))} autoCapitalize="none" keyboardType="email-address" />
          <TextField label="Phone" value={facultyForm.phone} onChangeText={(v) => setFacultyForm((p) => ({ ...p, phone: v }))} keyboardType="phone-pad" />
          <TextField label="Specialty" value={facultyForm.specialty} onChangeText={(v) => setFacultyForm((p) => ({ ...p, specialty: v }))} />
          <SelectField
            label="Clinical Title"
            hint={CLINICAL_TITLE_HINT}
            value={facultyForm.clinicalTitle || null}
            options={CLINICAL_TITLE_OPTIONS}
            onChange={(v) => setFacultyForm((p) => ({ ...p, clinicalTitle: v }))}
          />
          <SelectField
            label="Faculty Appointment"
            hint={FACULTY_APPOINTMENT_HINT}
            value={facultyForm.facultyAppointment || null}
            options={FACULTY_APPOINTMENT_OPTIONS}
            onChange={(v) => setFacultyForm((p) => ({ ...p, facultyAppointment: v }))}
          />
          <SelectField
            label="Administrative / Leadership Role"
            hint={ADMINISTRATIVE_ROLE_HINT}
            value={facultyForm.administrativeRole || null}
            options={ADMINISTRATIVE_ROLE_OPTIONS}
            onChange={(v) => setFacultyForm((p) => ({ ...p, administrativeRole: v }))}
          />
          {facultyEditing ? (
            <Button label="Cancel Edit" variant="outline" onPress={cancelEditFaculty} style={{ marginTop: spacing.sm }} />
          ) : null}
        </Card>
        <Card padded={false}>
          <View style={styles.cardPad}>
            <Text variant="label" tone="secondary" uppercase>
              Faculty List
            </Text>
          </View>
          {(facultyResource.data ?? []).map((f: any) => (
            <View key={f.id} style={styles.clinicRow}>
              <View style={styles.flex1}>
                <View style={styles.facultyNameRow}>
                  <Text variant="bodySmall">{`Dr. ${f.first_name} ${f.last_name}`}</Text>
                  {facultyBadges(f).map((badge) => (
                    <StatusBadge key={badge.label} label={badge.label} tone={badge.tone} />
                  ))}
                </View>
                <Text variant="caption" tone="muted">
                  {[f.clinical_title, f.specialty].filter(Boolean).join(' • ') ||
                    f.email ||
                    (f.is_active === 0 ? 'Inactive' : '')}
                </Text>
              </View>
              <IconButton icon={Pencil} accessibilityLabel={`Edit ${f.first_name}`} onPress={() => startEditFaculty(f)} />
              {f.is_active === 1 ? (
                <IconButton icon={Minus}  accessibilityLabel={`Deactivate ${f.first_name}`} onPress={() => setFacultyDeleteTarget(f)} />
              ) : null}
            </View>
          ))}
        </Card>
      </Sheet>

      <Sheet
        visible={Boolean(facultyDeleteTarget)}
        onClose={() => !deletingFaculty && setFacultyDeleteTarget(null)}
        title="Deactivate Faculty"
        footer={
          <View style={styles.actionRow}>
            <Button label="Deactivate"  onPress={confirmDeleteFaculty} loading={deletingFaculty} disabled={deletingFaculty} style={styles.flex1} />
            <Button label="Cancel" variant="outline" onPress={() => setFacultyDeleteTarget(null)} disabled={deletingFaculty} style={styles.flex1} />
          </View>
        }
      >
        <Text variant="bodySmall" tone="secondary">
          {`Are you sure you want to deactivate ${facultyDeleteTarget ? `Dr. ${facultyDeleteTarget.first_name} ${facultyDeleteTarget.last_name}` : 'this faculty member'}? They will be removed from active dropdowns but historical records will be preserved.`}
        </Text>
      </Sheet>

      <Sheet
        visible={dayAddOpen}
        onClose={closeAddDay}
        title="ADD DAY ROW"
        subtitle={dayAddForm ? `${dayAddForm.dayOfWeek} · weekly CCC day` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={savingDay ? 'Adding…' : 'Add day'}
              onPress={saveNewDay}
              loading={savingDay}
              disabled={savingDay}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={closeAddDay}
              disabled={savingDay}
              style={styles.flex1}
            />
          </View>
        }
      >
        <Text variant="caption" tone="secondary" style={styles.note}>
          {`Add another day to the CCC week. The week follows the Week Start Date, so it currently runs ${daySequence[0]} to ${daySequence[daySequence.length - 1]}.`}
        </Text>
        <SheetSelectField
          label="Day of Week"
          value={dayAddForm.dayOfWeek}
          options={missingDays.length > 0 ? dayOptionsFor(missingDays) : dayOptions}
          onChange={(value) => setDayAddForm((previous) => ({ ...previous, dayOfWeek: value }))}
          placeholder="Choose a day"
          hint="Days already on the week are not listed."
        />
        <TextField
          label="Shift Time"
          value={dayAddForm.shiftTime}
          onChangeText={(value) => setDayAddForm((previous) => ({ ...previous, shiftTime: value }))}
          placeholder={DAY_CONFIG[dayAddForm.dayOfWeek].shift}
          autoCapitalize="none"
          hint="e.g. 10:30 - 2:00 or 07:00 - 2:00"
        />
        <SheetSelectField
          label="PGY Level / Context"
          value={dayAddForm.pgyLevel || null}
          options={withCurrent(PGY_OPTIONS, dayAddForm.pgyLevel)}
          onChange={(value) => setDayAddForm((previous) => ({ ...previous, pgyLevel: value }))}
          placeholder="Choose a level"
        />
        <SheetSelectField
          label="Faculty In-charge"
          value={dayAddForm.inChargeFaculty || NONE_FACULTY}
          options={withCurrent(facultyOptions, dayAddForm.inChargeFaculty)}
          onChange={(value) => setDayAddForm((previous) => ({ ...previous, inChargeFaculty: value }))}
          placeholder="— None —"
          hint="A 'Dr.' title is applied automatically."
        />
      </Sheet>

      <Sheet
        visible={dayRemoveTarget !== null}
        onClose={() => {
          if (!savingDay) setDayRemoveTarget(null);
        }}
        title="REMOVE DAY ROW"
        subtitle={dayRemoveTarget ? `${dayRemoveTarget} · remove from this CCC week` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={savingDay ? 'Removing…' : 'Remove row'}
              onPress={confirmRemoveDay}
              loading={savingDay}
              disabled={savingDay}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={() => setDayRemoveTarget(null)}
              disabled={savingDay}
              style={styles.flex1}
            />
          </View>
        }
      >
        <Text variant="bodySmall" tone="secondary">
          {`Remove ${dayRemoveTarget ?? 'this day'} from the CCC week? Its clinic slots, backup pool and leave records are removed with it. The week must keep at least one day.`}
        </Text>
      </Sheet>

      <Sheet
        visible={metadataOpen}
        onClose={closeMetadata}
        title="EDIT CYCLE & SCHEDULE METADATA"
        subtitle={headerBarText}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={savingMetadata ? 'Saving…' : 'Save metadata'}
              onPress={saveMetadata}
              loading={savingMetadata}
              disabled={savingMetadata}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={closeMetadata}
              disabled={savingMetadata}
              style={styles.flex1}
            />
          </View>
        }
      >
        <Text variant="caption" tone="secondary" style={styles.note}>
          Set the cycle and week this CCC grid belongs to, the day it opens on, and the session the
          header bar reads. The session time and PGY context apply to the opening day&apos;s row.
        </Text>
        <View style={styles.row}>
          <View style={styles.half}>
            <SheetSelectField
              label="Cycle Number"
              value={metadataForm.cycleNumber}
              options={CYCLE_NUMBER_OPTIONS}
              onChange={(value) => setMetadataForm((previous) => ({ ...previous, cycleNumber: value }))}
              placeholder="1"
              hint="Cycle 1–12."
            />
          </View>
          <View style={styles.half}>
            <SheetSelectField
              label="Week Number"
              value={metadataForm.weekNumber}
              options={WEEK_NUMBER_OPTIONS}
              onChange={(value) => setMetadataForm((previous) => ({ ...previous, weekNumber: value }))}
              placeholder="1"
              hint="Week 1–4."
            />
          </View>
        </View>
        <SheetSelectField
          label="First Day of Week"
          value={metadataForm.firstDay}
          options={dayOptions}
          onChange={changeMetadataFirstDay}
          placeholder="Choose a day"
          hint="The CCC week runs from this day."
        />
        <DateField
          label="Start Date"
          value={metadataForm.startDate}
          onChangeText={(value) =>
            setMetadataForm((previous) => ({
              ...previous,
              startDate: value,
              firstDay: dayNameOf(value) ?? previous.firstDay,
            }))
          }
          weekStartDay={metadataForm.firstDay.toUpperCase()}
          placeholder="YYYY-MM-DD"
          hint="The date the cycle opens on."
        />
        <View style={styles.row}>
          <View style={styles.half}>
            <TextField
              label="Shift Start"
              value={metadataForm.shiftStart}
              onChangeText={(value) => setMetadataForm((previous) => ({ ...previous, shiftStart: value }))}
              autoCapitalize="none"
              placeholder="10:30"
              hint="24-hour, e.g. 10:30."
            />
          </View>
          <View style={styles.half}>
            <TextField
              label="Shift End"
              value={metadataForm.shiftEnd}
              onChangeText={(value) => setMetadataForm((previous) => ({ ...previous, shiftEnd: value }))}
              autoCapitalize="none"
              placeholder="14:00"
              hint="24-hour, e.g. 14:00."
            />
          </View>
        </View>
        <SheetSelectField
          label="PGY Level / Context"
          value={metadataForm.pgyLevel || null}
          options={withCurrent(PGY_OPTIONS, metadataForm.pgyLevel)}
          onChange={(value) => setMetadataForm((previous) => ({ ...previous, pgyLevel: value }))}
          placeholder="Choose a level"
          hint="Applied to the opening day's session."
        />
      </Sheet>

      {reportModel ? (
        <>
          <ExportMenu
            visible={exportOpen}
            onClose={() => setExportOpen(false)}
            subtitle={headerBarText}
            onExport={handleExport}
          />
          {/*
            The full-width matrix, mounted out of sight. The JPEG/PNG export
            captures this node rather than the horizontally-scrolling on-screen
            grid, so no clinic column is clipped.
          */}
          <View
            style={styles.hiddenReport}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <ScheduleReportView ref={reportRef} report={reportModel} />
          </View>
        </>
      ) : null}

    </Screen>
  );
}

const DAY_COLUMN_WIDTH = 132;
const CLINIC_COLUMN_WIDTH = 104;

/** Fixed roster columns; the resident and faculty columns flex to fill the width. */
const ROSTER_DAY_COLUMN_WIDTH = 132;
const ROSTER_CLINIC_COLUMN_WIDTH = 92;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  half: {
    flex: 1,
  },
  flex1: {
    flex: 1,
  },
  note: {
    marginBottom: spacing.md,
  },
  dateRangeRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: spacing.md,
  },
  durationBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: spacing.sm,
  },
  cardPad: {
    padding: spacing.lg,
    paddingBottom: 0,
  },
  facultyDivider: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  facultyDividerLabel: {
    textAlign: 'center',
  },
  matrixScroll: {
    paddingBottom: spacing.lg,
  },
  matrixHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  matrixRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  headerCell: {
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  bodyCell: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  /**
   * The day column cell is a container rather than one Pressable: the day label
   * area and the "- Remove Row" control are separate touch targets so neither
   * swallows the other.
   */
  dayCellBlock: {
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  dayCellMain: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  dayRemoveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.xxs,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  addDayButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxs,
    marginTop: spacing.xs,
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
    alignSelf: 'flex-start',
  },
  dayActionDisabled: {
    opacity: 0.5,
  },
  dayCol: {
    width: DAY_COLUMN_WIDTH,
    borderRightWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  frozen: {
    position: stickyPosition,
    left: 0,
    zIndex: 2,
  },
  colHeader: {
    width: CLINIC_COLUMN_WIDTH,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
  dayName: {
    fontWeight: '600',
    marginBottom: spacing.xxs,
  },
  specialColumn: {
    backgroundColor: colors.primarySoft,
  },
  cell: {
    width: CLINIC_COLUMN_WIDTH,
    minHeight: 64,
    borderRightWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  cellPressed: {
    backgroundColor: colors.primarySoft,
  },
  cellFaculty: {
    marginTop: spacing.xxs,
  },
  inCharge: {
    marginTop: spacing.xxs,
  },
  pgyBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  viewToggle: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xxs,
    padding: spacing.xxs,
    marginBottom: spacing.md,
  },
  viewToggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
  },
  viewToggleOptionActive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
  },
  viewToggleOptionPressed: {
    backgroundColor: colors.surface,
  },
  rosterHeaderRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  rosterHeaderCell: {
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  rosterHeaderDay: {
    width: ROSTER_DAY_COLUMN_WIDTH,
  },
  rosterHeaderClinic: {
    width: ROSTER_CLINIC_COLUMN_WIDTH,
  },
  rosterHeaderResidents: {
    flex: 1,
  },
  rosterHeaderFaculty: {
    flex: 1,
  },
  rosterRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: colors.border,
    alignItems: 'stretch',
  },
  rosterRest: {
    flex: 1,
    flexDirection: 'row',
  },
  rosterDayCell: {
    width: ROSTER_DAY_COLUMN_WIDTH,
    minHeight: 52,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    gap: spacing.xxs,
    borderRightWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rosterSessionStart: {
    backgroundColor: colors.surfaceMuted,
  },
  rosterDayText: {
    fontWeight: '600',
  },
  rosterClinicCell: {
    width: ROSTER_CLINIC_COLUMN_WIDTH,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRightWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rosterResidentsCell: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    gap: spacing.xs,
    borderRightWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rosterFacultyCell: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  residentLine: {
    gap: spacing.xxs,
  },
  backupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  backupEditor: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderColor: colors.borderStrong,
  },
  backupRowInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  backupRemove: {
    marginBottom: spacing.lg,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  scopeLabel: {
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  matrixAddColumnButton: {
    marginBottom: spacing.md,
    marginTop: spacing.xs,
  },
  metadataBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  metadataBannerText: {
    flex: 1,
    gap: spacing.xxs,
  },
  metadataBannerSummary: {
    fontWeight: '600',
  },
  metadataEditButton: {
    marginBottom: spacing.md,
  },
  clinicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  facultyNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  catalogList: {
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  catalogRowPressed: {
    backgroundColor: colors.primarySoft,
  },
  catalogRowSelected: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primarySoft,
  },
  catalogText: {
    flex: 1,
    gap: spacing.xxs,
  },
  hiddenReport: {
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: 0.01,
    zIndex: -1,
  },
});
