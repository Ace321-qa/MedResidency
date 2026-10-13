import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Minus, Pencil, Plus, Shuffle, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  Divider,
  IconButton,
  ImportTools,
  Screen,
  SearchInput,
  SectionHeader,
  Sheet,
  SheetSelectField,
  Text,
  TextField,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  createClinicType,
  deleteClinicType,
  fetchClinicTypes,
  fetchCycleSchedule,
  fetchFacultySupervisors,
  randomizeSupervisors,
  updateBackupFaculty,
  updateClinicType,
  updateCycleHeader,
  updateCycleSlot,
  createFacultySupervisor,
  updateFacultySupervisor,
  deleteFacultySupervisor,
} from '../../../services/longitudinal';
import { fetchResidentList } from '../../../services/residents';
import { uploadFacultySupervisors } from '../../../services/excelTemplates';
import { CCC_SCHEDULE_ROWS, dayOfWeekMatches } from '../../../utils/cccMatrix';
import { formatPgy } from '../../../utils/insights';
import {
  PRIMARY_CARE_CLINIC_CATALOG,
  clinicNameKey,
  type ClinicCatalogEntry,
} from '../../../utils/primaryCareClinics';
import { residentFullName } from '../../../utils/residents';
import { colors, radius, spacing } from '../../../theme';
import { goBack } from '../../../navigation/back';
import type {
  LongitudinalClinicType,
  PrimaryCareClinicSlot,
  PrimaryCareCycle,
  PrimaryCareDailyHeader,
} from '../../../types/api';

/**
 * The CCC weekly schedule.
 *
 * A five-day by twelve-clinic grid is wider than any phone, so the whole table
 * scrolls horizontally while the day column stays pinned. Every cell is a
 * single tap away from editing; the cycle header, per-day boundaries and the
 * backup pools sit below it.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'] as const;
type DayName = (typeof DAYS)[number];

/** Only these days carry a catchup pool, per the programme rules. */
const BACKUP_DAYS: DayName[] = ['Sunday', 'Monday', 'Wednesday'];

const DAY_SHORT: Record<DayName, string> = {
  Sunday: 'Sun',
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
};

const DAY_CONFIG: Record<DayName, { shift: string; pgy: string }> = {
  Sunday: { shift: '10:30 – 2:00', pgy: 'PGY-3' },
  Monday: { shift: '10:30 – 2:00', pgy: 'PGY-2' },
  Tuesday: { shift: '07:00 – 2:00', pgy: 'FMC' },
  Wednesday: { shift: '10:30 – 2:00', pgy: 'PGY-1' },
  Thursday: { shift: '07:00 – 2:00', pgy: 'FMC' },
};

interface MatrixColumn {
  key: string;
  title: string;
  subtitle: string | null;
  clinicNumber: number;
  special: boolean;
}

const CLINIC_COLUMNS: MatrixColumn[] = Array.from({ length: 10 }, (_, index) => ({
  key: `clinic-${index + 1}`,
  title: `Clinic ${index + 1}`,
  subtitle: null,
  clinicNumber: index + 1,
  special: false,
}));

const SPECIAL_COLUMNS: MatrixColumn[] = [
  { key: 'wbc', title: 'WBC', subtitle: 'Well Baby Clinic', clinicNumber: 11, special: true },
  { key: 'leaves', title: 'Leaves', subtitle: 'Away', clinicNumber: 12, special: true },
];

const MATRIX_COLUMNS: MatrixColumn[] = [...CLINIC_COLUMNS, ...SPECIAL_COLUMNS];

const BACKUP_POOL_MIN = 3;
const BACKUP_POOL_MAX = 4;

/** Web pins the day column; React Native has no sticky positioning. */
const stickyPosition: 'relative' = Platform.OS === 'web' ? ('sticky' as any) : 'relative';

/** The days a header may be reassigned to, in the order the week runs. */
const DAY_OPTIONS: SelectOption<DayName>[] = DAYS.map((day) => ({ value: day, label: day }));

/** The PGY levels / contexts a day can carry. A custom value is kept too. */
const PGY_OPTIONS: SelectOption<string>[] = [
  { value: 'PGY-3', label: 'PGY-3' },
  { value: 'PGY-2', label: 'PGY-2' },
  { value: 'PGY-1', label: 'PGY-1' },
  { value: 'FMC', label: 'FMC' },
];

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

/** A catalog entry's supporting line: the session, and whether a letter is needed. */
function describeCatalogEntry(entry: ClinicCatalogEntry): string {
  const parts: string[] = [];
  if (entry.defaultDay) {
    parts.push(
      `${titleCaseDay(entry.defaultDay)}${
        entry.startTime && entry.endTime ? ` ${entry.startTime}–${entry.endTime}` : ''
      }`,
    );
  } else if (entry.startTime && entry.endTime) {
    parts.push(`Any day ${entry.startTime}–${entry.endTime}`);
  } else {
    parts.push('No fixed day');
  }
  if (entry.requiresReleaseLetter) parts.push('Release letter required');
  return parts.join(' · ');
}

/** The one-line summary shown under a catalogued clinic's name. */
function describeClinicType(clinic: LongitudinalClinicType): string {
  const parts: string[] = [clinic.clinic_code];
  if (clinic.default_day_of_week) {
    parts.push(
      `${titleCaseDay(clinic.default_day_of_week)}${
        clinic.start_time && clinic.end_time ? ` ${clinic.start_time.slice(0, 5)}–${clinic.end_time.slice(0, 5)}` : ''
      }`,
    );
  } else {
    parts.push('No fixed day');
  }
  if (clinic.requires_release_letter === 1) parts.push('Release letter');
  return parts.join(' · ');
}

function titleCaseDay(day: string): string {
  const lower = day.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
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

  const schedule = useApiResource(() => fetchCycleSchedule(programId), [programId]);
  const facultyResource = useApiResource(() => fetchFacultySupervisors(programId), [programId]);
  const residentsResource = useApiResource(
    () => fetchResidentList({ programId, limit: 200 }),
    [programId],
  );
  /**
   * The programme's clinic catalog, including inactive rows.
   *
   * Inactive rows still count as "known": a clinic moved out of the default pool
   * must not be offered a second time by the add sheet, because the server would
   * only reactivate the row it already has.
   */
  const clinicTypes = useApiResource(
    () => fetchClinicTypes(programId, { includeInactive: true }),
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
  const [rationale, setRationale] = useState('');

  /** Which of the two clinic-grid renderings is active. */
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');

  /** The clinic catalog add / rename / remove controls. */
  const [facultyMgrOpen, setFacultyMgrOpen] = useState(false);
  const [facultyForm, setFacultyForm] = useState({ firstName: "", lastName: "", email: "", phone: "", specialty: "" });
  const [facultyEditing, setFacultyEditing] = useState<any | null>(null);
  const [savingFaculty, setSavingFaculty] = useState(false);
  const [deletingFaculty, setDeletingFaculty] = useState(false);
  const [facultyDeleteTarget, setFacultyDeleteTarget] = useState<any | null>(null);

  const [addClinicOpen, setAddClinicOpen] = useState(false);
  const [addClinicQuery, setAddClinicQuery] = useState('');
  const [customClinicName, setCustomClinicName] = useState('');
  const [addingClinic, setAddingClinic] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LongitudinalClinicType | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [savingClinicRename, setSavingClinicRename] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LongitudinalClinicType | null>(null);
  const [deletingClinic, setDeletingClinic] = useState(false);

  const data = schedule.data;
  const cycle: PrimaryCareCycle | null = data?.cycle ?? null;

  const facultyOptions = useMemo<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [{ value: NONE_FACULTY, label: '— None —' }];
    for (const faculty of facultyResource.data ?? []) {
      const value = withDoctorTitle(faculty.display_name ?? `${faculty.first_name} ${faculty.last_name}`);
      if (!value) continue;
      options.push({ value, label: value });
    }
    return options;
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

  const residentOptions = useMemo<SelectOption<string>[]>(() => {
    const options: SelectOption<string>[] = [{ value: NONE_RESIDENT, label: '— Unassigned —' }];
    const seen = new Set<string>();
    for (const resident of residentsResource.data ?? []) {
      const name = residentFullName(resident).replace(/^Dr\.?\s+/i, '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      options.push({ value: name, label: name });
    }
    return options;
  }, [residentsResource.data]);

  function headerForDay(day: DayName): PrimaryCareDailyHeader | null {
    const weekday = DAYS.indexOf(day);
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

  function openSlot(edit: SlotEdit) {
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

  function openBackups(day: DayName) {
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
        rotation_months: Number(rotationMonths) || 3,
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
    setFacultyMgrOpen(true);
    setFacultyEditing(null);
    setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '' });
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
    });
  }

  function cancelEditFaculty() {
    setFacultyEditing(null);
    setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '' });
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
          is_active: 1,
        });
        facultyResource.setData((current: any) => [created, ...(current ?? [])] as any);
        setFeedback('Faculty added.');
        setFacultyForm({ firstName: '', lastName: '', email: '', phone: '', specialty: '' });
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
    const weekday = DAYS.indexOf(day);
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

  /** The clinics selectable right now; inactive rows stay out of the catalog. */
  const activeClinics = useMemo(
    () => (clinicTypes.data ?? []).filter((clinic) => clinic.is_active === 1),
    [clinicTypes.data],
  );

  /** Clinics already on record for the programme, active or not. */
  const knownClinicKeys = useMemo(
    () => new Set((clinicTypes.data ?? []).map((clinic) => clinicNameKey(clinic.clinic_name))),
    [clinicTypes.data],
  );

  /**
   * The catalog entries not already on record.
   *
   * A clinic that was removed from the pool is still on record, so it is excluded
   * here — picking it would only reactivate the row it already has.
   */
  const clinicCatalogCandidates = useMemo(
    () => PRIMARY_CARE_CLINIC_CATALOG.filter((entry) => !knownClinicKeys.has(clinicNameKey(entry.name))),
    [knownClinicKeys],
  );

  const clinicQueryNeedle = addClinicQuery.trim().toLowerCase();
  const visibleClinicCatalog = clinicQueryNeedle
    ? clinicCatalogCandidates.filter((entry) => entry.name.toLowerCase().includes(clinicQueryNeedle))
    : clinicCatalogCandidates;

  function openAddClinic() {
    setAddClinicQuery('');
    setCustomClinicName('');
    setAddClinicOpen(true);
    setActionError(null);
    setFeedback(null);
  }

  function closeAddClinic() {
    if (addingClinic) return;
    setAddClinicOpen(false);
  }

  /** Add a clinic and patch it into the catalog so the row appears immediately. */
  async function addClinic(payload: {
    clinic_name: string;
    default_day_of_week?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    requires_release_letter?: number;
  }) {
    if (!programId) return;
    setAddingClinic(true);
    setActionError(null);
    setFeedback(null);
    try {
      const created = await createClinicType({ program_id: programId, ...payload });
      clinicTypes.setData((current) => [
        ...(current ?? []).filter((clinic) => clinic.id !== created.id),
        created,
      ]);
      setAddClinicOpen(false);
      setFeedback(`${created.clinic_name} is now available in the clinic catalog.`);
      clinicTypes.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not add this clinic.');
    } finally {
      setAddingClinic(false);
    }
  }

  function addCatalogClinic(entry: ClinicCatalogEntry) {
    void addClinic({
      clinic_name: entry.name,
      default_day_of_week: entry.defaultDay,
      start_time: entry.startTime,
      end_time: entry.endTime,
      requires_release_letter: entry.requiresReleaseLetter ? 1 : 0,
    });
  }

  function addCustomClinic() {
    const name = customClinicName.trim();
    if (!name) return;
    void addClinic({ clinic_name: name });
  }

  function openRenameClinic(clinic: LongitudinalClinicType) {
    setRenameTarget(clinic);
    setRenameValue(clinic.clinic_name);
    setActionError(null);
    setFeedback(null);
  }

  function closeRenameClinic() {
    if (savingClinicRename) return;
    setRenameTarget(null);
    setRenameValue('');
  }

  /** Rename a clinic and patch the row in place, without a page refresh. */
  async function saveClinicRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      setActionError('A clinic name is required.');
      return;
    }
    setSavingClinicRename(true);
    setActionError(null);
    setFeedback(null);
    try {
      const updated = await updateClinicType(renameTarget.id, {
        program_id: programId,
        clinic_name: name,
      });
      clinicTypes.setData((current) =>
        (current ?? []).map((clinic) => (clinic.id === updated.id ? updated : clinic)),
      );
      setRenameTarget(null);
      setRenameValue('');
      setFeedback(`${updated.clinic_name} was renamed.`);
      clinicTypes.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not rename this clinic.');
    } finally {
      setSavingClinicRename(false);
    }
  }

  function askDeleteClinic(clinic: LongitudinalClinicType) {
    setDeleteTarget(clinic);
    setActionError(null);
    setFeedback(null);
  }

  function closeDeleteClinic() {
    if (deletingClinic) return;
    setDeleteTarget(null);
  }

  /** Soft-delete a clinic, then drop it out of the active catalog in place. */
  async function removeClinic() {
    if (!deleteTarget) return;
    setDeletingClinic(true);
    setActionError(null);
    setFeedback(null);
    try {
      await deleteClinicType(deleteTarget.id, programId);
      clinicTypes.setData((current) =>
        (current ?? []).map((clinic) =>
          clinic.id === deleteTarget.id ? { ...clinic, is_active: 0 } : clinic,
        ),
      );
      setDeleteTarget(null);
      setFeedback('Clinic removed from the active catalog. Existing history is preserved.');
      clinicTypes.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not remove this clinic.');
    } finally {
      setDeletingClinic(false);
    }
  }

  const isLoading = schedule.isLoading && !data;

  return (
    <Screen
      onRefresh={() => {
        schedule.refresh();
        clinicTypes.refresh();
      }}
      refreshing={schedule.isRefreshing || clinicTypes.isRefreshing}
    >
      <AppHeader
        title="Continuity of Care Clinics (CCC)"
        subtitle="Weekly clinic matrix, supervisors and backup faculty"
        onBack={goBack}
      />

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
            <SectionHeader title="Cycle Header & Metadata" />
            <View style={styles.row}>
              <View style={styles.half}>
                <TextField
                  label="Cycle Number"
                  value={cycle?.cycle_number ?? ''}
                  onChangeText={(value) => updateCycleField({ cycle_number: value })}
                  placeholder="1"
                />
              </View>
              <View style={styles.half}>
                <TextField
                  label="Week Number"
                  value={cycle?.week_number ?? ''}
                  onChangeText={(value) => updateCycleField({ week_number: value })}
                  placeholder="1"
                />
              </View>
            </View>
            <DateField
              label="Week Start Date"
              value={cycle?.start_date ?? ''}
              onChangeText={(value) => updateCycleField({ start_date: value })}
              weekStartDay="SUNDAY"
              placeholder="YYYY-MM-DD"
              hint="First day of the academic week this cycle opens on."
            />
            <Text variant="caption" tone="muted" style={styles.note}>
              Saving applies the cycle metadata together with each day&apos;s shift, PGY level and
              In-Charge lead. Tap a day header in the matrix to edit a single day.
            </Text>
            <Button
              label="Manage Faculty Preceptors"
              variant="outline"
              onPress={openFacultyManager}
              disabled={saving}
              style={{ marginBottom: spacing.sm }}
            />
            <Button
              label="Save Cycle Header"
              onPress={saveHeader}
              loading={saving}
              disabled={saving}
            />
          </Card>

          {viewMode === 'matrix' ? (
            <Card padded={false}>
              <View style={styles.cardPad}>
                <SectionHeader title="Weekly Clinic Matrix" trailing={`${DAYS.length} days`} />
                <Text variant="caption" tone="muted">
                  Tap a day&apos;s header to edit its day, shift time, PGY level and In-Charge faculty.
                  Tap any cell to assign up to two residents and supervising faculty. WBC and Leaves
                  are the eleventh and twelfth columns.
                </Text>
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
                  </View>
                  {MATRIX_COLUMNS.map((column) => (
                    <View
                      key={column.key}
                      style={[
                        styles.colHeader,
                        styles.headerCell,
                        column.special ? styles.specialColumn : null,
                      ]}
                    >
                      <Text variant="label" numberOfLines={1} align="center">
                        {column.title}
                      </Text>
                      {column.subtitle ? (
                        <Text variant="caption" tone="secondary" numberOfLines={1} align="center">
                          {column.subtitle}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>

                {DAYS.map((day) => {
                  const header = headerForDay(day);
                  const shiftLabel = header?.shift_time || DAY_CONFIG[day].shift;
                  const pgyLabel = header?.pgy_level || DAY_CONFIG[day].pgy;
                  const inCharge = withDoctorTitle(header?.in_charge_faculty_name);
                  return (
                    <View key={day} style={styles.matrixRow}>
                      <Pressable
                        onPress={() => openHeader(day)}
                        accessibilityRole="button"
                        accessibilityLabel={`${day} daily header. Shift ${shiftLabel}. ${pgyLabel}. Faculty in charge ${
                          inCharge || 'unassigned'
                        }. Opens the daily header editor.`}
                        accessibilityHint="Opens a sheet to edit the day, shift time, PGY level and In-Charge faculty"
                        style={({ pressed }) => [
                          styles.dayCol,
                          styles.frozen,
                          styles.bodyCell,
                          pressed ? styles.cellPressed : null,
                        ]}
                      >
                        <Text variant="bodySmall" style={styles.dayName}>
                          {DAY_SHORT[day]}
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

                      {MATRIX_COLUMNS.map((column) => {
                        const slot = slotFor(day, column.clinicNumber);
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
                                clinicNumber: column.clinicNumber,
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
              <SectionHeader title="Operational Roster" trailing={`${DAYS.length} sessions`} />
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
            {DAYS.map((day) => {
              const header = headerForDay(day);
              const shiftLabel = header?.shift_time || sessionWindow(day);
              const pgyLabel = header?.pgy_level || DAY_CONFIG[day].pgy;
              return (
                <View key={day}>
                  {MATRIX_COLUMNS.map((column, columnIndex) => {
                    const slot = slotFor(day, column.clinicNumber);
                    const residents = [slot?.resident_1_name, slot?.resident_2_name].filter(
                      (name): name is string => Boolean(name),
                    );
                    const faculty = withDoctorTitle(slot?.faculty_name);
                    const inCharge = withDoctorTitle(header?.in_charge_faculty_name);
                    const isSessionStart = columnIndex === 0;
                    const clinicLabel =
                      column.key === 'leaves'
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
                            openSlot({
                              slot,
                              day,
                              columnLabel: clinicLabel,
                              clinicNumber: column.clinicNumber,
                              shiftTime: header?.shift_time ?? DAY_CONFIG[day].shift,
                              pgyLevel: header?.pgy_level ?? DAY_CONFIG[day].pgy,
                            })
                          }
                          accessibilityRole="button"
                          accessibilityLabel={`${day} ${clinicLabel}. ${
                            residents.length ? residents.join(', ') : 'Unassigned'
                          }${faculty ? `, supervised by ${faculty}` : ''}. Opens the slot editor.`}
                          accessibilityHint="Opens a sheet to edit residents and supervising faculty"
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
                                  {residentPgyByName.get(name) != null ? (
                                    <PgyBadge label={formatPgy(residentPgyByName.get(name) ?? null)} />
                                  ) : null}
                                </View>
                              ))
                            ) : (
                              <Text variant="bodySmall" tone="disabled">
                                Unassigned
                              </Text>
                            )}
                          </View>
                          <View style={styles.rosterFacultyCell}>
                            {faculty ? (
                              <Text variant="bodySmall" tone="secondary" numberOfLines={2}>
                                {faculty}
                              </Text>
                            ) : (
                              <Text variant="bodySmall" tone="muted">
                                — None —
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
          <View style={styles.catalogHeader}>
            <Text variant="label" tone="secondary" uppercase>
              Clinic Catalog
            </Text>
            <IconButton
              icon={Plus}
              tone="primary"
              accessibilityLabel="Add clinic"
              onPress={openAddClinic}
            />
          </View>
          <Text variant="caption" tone="muted" style={styles.note}>
            Add a clinic from the catalog or type a custom name. Use the pencil to rename one and the
            minus to remove it from the active pool; its slots and assignment history stay preserved.
          </Text>
          {activeClinics.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              No clinics are active for this programme yet. Tap + to add the first one.
            </Text>
          ) : (
            activeClinics.map((clinic) => (
              <View key={clinic.id} style={styles.clinicRow}>
                <View style={styles.flex1}>
                  <Text variant="bodySmall" numberOfLines={2}>
                    {clinic.clinic_name}
                  </Text>
                  <Text variant="caption" tone="muted" numberOfLines={1}>
                    {describeClinicType(clinic)}
                  </Text>
                </View>
                <IconButton
                  icon={Pencil}
                  accessibilityLabel={`Rename ${clinic.clinic_name}`}
                  onPress={() => openRenameClinic(clinic)}
                />
                <IconButton
                  icon={Minus}
                  
                  accessibilityLabel={`Remove ${clinic.clinic_name}`}
                  onPress={() => askDeleteClinic(clinic)}
                />
              </View>
            ))
          )}
        </Card>

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

          <Card>
            <SectionHeader title="Supervisor Randomisation & Rotation" />
            <Text variant="caption" tone="muted" style={styles.note}>
              Redistributes supervising faculty across clinic slots so coverage rotates fairly. Each
              reassignment is recorded with the rationale you provide.
            </Text>
            <View style={styles.row}>
              <View style={styles.half}>
                <TextField
                  label="Rotation window (months)"
                  value={rotationMonths}
                  onChangeText={setRotationMonths}
                  keyboardType="number-pad"
                  placeholder="3"
                />
              </View>
            </View>
            <TextField
              label="Rationale"
              value={rationale}
              onChangeText={setRationale}
              multiline
              placeholder="e.g. Q3 fair rotation across PGY-2 faculty"
            />
            <Button
              label="Randomize All Days"
              icon={Shuffle}
              onPress={() => runRandomize()}
              loading={saving}
              disabled={saving}
            />
            <Text variant="label" tone="secondary" uppercase style={styles.scopeLabel}>
              Rotate a single day
            </Text>
            <View style={styles.actionRow}>
              {DAYS.map((day) => (
                <Button
                  key={day}
                  label={DAY_SHORT[day]}
                  variant="outline"
                  fullWidth={false}
                  onPress={() => runRandomize(day)}
                  disabled={saving}
                />
              ))}
            </View>
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
              options={DAY_OPTIONS}
              onChange={(value) => setHeaderForm((previous) => ({ ...previous, dayOfWeek: value }))}
              placeholder="Choose a day"
              hint="The CCC week runs Sunday to Thursday."
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
            <SheetSelectField
              label="Resident 1"
              value={slotForm.resident1 || NONE_RESIDENT}
              options={withCurrent(residentOptions, slotForm.resident1)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, resident1: value }))}
              placeholder="— Unassigned —"
            />
            <SheetSelectField
              label="Resident 2 (optional)"
              value={slotForm.resident2 || NONE_RESIDENT}
              options={withCurrent(residentOptions, slotForm.resident2)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, resident2: value }))}
              placeholder="— Unassigned —"
            />
            <SheetSelectField
              label="Supervising Faculty"
              value={slotForm.faculty || NONE_FACULTY}
              options={withCurrent(facultyOptions, slotForm.faculty)}
              onChange={(value) => setSlotForm((previous) => ({ ...previous, faculty: value }))}
              placeholder="— None —"
              hint="A 'Dr.' title is applied automatically to faculty members."
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
        visible={addClinicOpen}
        onClose={closeAddClinic}
        title="Add Clinic"
        subtitle="Choose a clinic from the catalog or type an exact name."
        footer={
          <Button
            label="Close"
            variant="outline"
            onPress={closeAddClinic}
            disabled={addingClinic}
          />
        }
      >
        <TextField
          label="Other / custom clinic name"
          value={customClinicName}
          onChangeText={setCustomClinicName}
          placeholder="e.g. Al Noor Diabetes Clinic"
          hint="Use this when the clinic is not in the catalog below. It is stored for this programme and offered to every coordinator."
        />
        <Button
          label={addingClinic ? 'Adding…' : 'Add custom clinic'}
          onPress={addCustomClinic}
          disabled={customClinicName.trim().length === 0 || addingClinic}
          loading={addingClinic}
          style={styles.customClinicButton}
        />

        <SectionHeader title="Catalog" trailing={`${visibleClinicCatalog.length} available`} />
        <SearchInput
          value={addClinicQuery}
          onChangeText={setAddClinicQuery}
          placeholder="Search clinics"
          accessibilityLabel="Search the clinic catalog"
        />
        <View style={styles.catalogList}>
          {visibleClinicCatalog.map((entry) => (
            <Pressable
              key={entry.name}
              onPress={() => addCatalogClinic(entry)}
              disabled={addingClinic}
              accessibilityRole="button"
              accessibilityLabel={`Add ${entry.name}`}
              style={({ pressed }) => [
                styles.catalogRow,
                pressed && !addingClinic ? styles.catalogRowPressed : null,
              ]}
            >
              <View style={styles.catalogText}>
                <Text variant="bodySmall" numberOfLines={2}>
                  {entry.name}
                </Text>
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {describeCatalogEntry(entry)}
                </Text>
              </View>
              <Plus color={colors.primary} size={18} />
            </Pressable>
          ))}
          {visibleClinicCatalog.length === 0 ? (
            <Text variant="bodySmall" tone="muted" align="center" style={styles.catalogEmpty}>
              {clinicQueryNeedle
                ? `No catalog clinic matches “${addClinicQuery.trim()}”. Type it above to add it.`
                : 'Every catalog clinic is already in the pool. Type a custom name above to add another.'}
            </Text>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        visible={renameTarget !== null}
        onClose={closeRenameClinic}
        title="Rename Clinic"
        subtitle={renameTarget ? `${renameTarget.clinic_name} · ${renameTarget.clinic_code}` : undefined}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={savingClinicRename ? 'Saving…' : 'Save name'}
              loading={savingClinicRename}
              onPress={saveClinicRename}
              disabled={savingClinicRename}
              style={styles.flex1}
            />
            <Button
              label="Cancel"
              variant="outline"
              onPress={closeRenameClinic}
              disabled={savingClinicRename}
              style={styles.flex1}
            />
          </View>
        }
      >
        <TextField
          label="Clinic name"
          value={renameValue}
          onChangeText={setRenameValue}
          placeholder="e.g. Well Baby Clinic (WBC)"
          autoCapitalize="words"
          hint="Renaming updates the chip everywhere this clinic is shown. Slots and assignment history are preserved."
        />
      </Sheet>

      <Sheet
        visible={deleteTarget !== null}
        onClose={closeDeleteClinic}
        title="Remove Clinic"
        subtitle={deleteTarget?.clinic_name}
        footer={
          <View style={styles.actionRow}>
            <Button
              label={deletingClinic ? 'Removing…' : 'Remove clinic'}
              
              loading={deletingClinic}
              onPress={removeClinic}
              disabled={deletingClinic}
              style={styles.flex1}
            />
            <Button
              label="Keep it"
              variant="outline"
              onPress={closeDeleteClinic}
              disabled={deletingClinic}
              style={styles.flex1}
            />
          </View>
        }
      >
        <Text variant="bodySmall" tone="secondary">
          {`Are you sure you want to remove ${deleteTarget?.clinic_name ?? 'this clinic'}? Existing slots and historical data linked to this clinic will be preserved.`}
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
          hint="Five columns: First Name, Last Name, Email, Phone, Specialty. First and Last Name are required; Specialty defaults to Family Medicine."
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
                <Text variant="bodySmall">{`Dr. ${f.first_name} ${f.last_name}`}</Text>
                <Text variant="caption" tone="muted">
                  {f.specialty || f.email || (f.is_active === 0 ? 'Inactive' : '')}
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
  catalogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  clinicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderColor: colors.border,
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
  catalogText: {
    flex: 1,
    gap: spacing.xxs,
  },
  catalogEmpty: {
    paddingVertical: spacing.lg,
  },
  customClinicButton: {
    marginBottom: spacing.lg,
  },
});
