import { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Plus, Shuffle, Trash2 } from 'lucide-react-native';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  DateField,
  IconButton,
  Screen,
  SectionHeader,
  Sheet,
  SheetSelectField,
  Text,
  TextField,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  fetchCycleSchedule,
  fetchFacultySupervisors,
  randomizeSupervisors,
  updateBackupFaculty,
  updateCycleHeader,
  updateCycleSlot,
} from '../../../services/longitudinal';
import { fetchResidentList } from '../../../services/residents';
import { dayOfWeekMatches } from '../../../utils/cccMatrix';
import { residentFullName } from '../../../utils/residents';
import { colors, spacing } from '../../../theme';
import { goBack } from '../../../navigation/back';
import type {
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

export default function LongitudinalMatrixScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const schedule = useApiResource(() => fetchCycleSchedule(programId), [programId]);
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
  const [rationale, setRationale] = useState('');

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

  function withCurrent(options: SelectOption<string>[], current: string): SelectOption<string>[] {
    const trimmed = current.trim();
    if (!trimmed || options.some((option) => option.value === trimmed)) return options;
    return [{ value: trimmed, label: trimmed }, ...options];
  }

  const isLoading = schedule.isLoading && !data;

  return (
    <Screen onRefresh={schedule.refresh} refreshing={schedule.isRefreshing}>
      <AppHeader
        title="Primary Care Clinics (CCC)"
        subtitle="Weekly clinic matrix, supervisors and backup faculty"
        onBack={goBack}
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
              label="Save Cycle Header"
              onPress={saveHeader}
              loading={saving}
              disabled={saving}
            />
          </Card>

          <Card padded={false}>
            <View style={styles.cardPad}>
              <SectionHeader title="Weekly Clinic Matrix" trailing={`${DAYS.length} days`} />
              <Text variant="caption" tone="muted">
                Tap a day&apos;s header to edit its day, shift time, PGY level and In-Charge faculty.
                Tap any cell to assign up to two residents and supervising faculty. WBC and Leaves are
                the eleventh and twelfth columns.
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
                        tone="danger"
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
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const DAY_COLUMN_WIDTH = 132;
const CLINIC_COLUMN_WIDTH = 104;

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
});
