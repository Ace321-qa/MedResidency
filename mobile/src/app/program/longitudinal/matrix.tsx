import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarX, Check, Pencil, Plus, PlusCircle, Trash2 } from 'lucide-react-native';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ImportTools,
  MatrixTable,
  Screen,
  SearchInput,
  SectionHeader,
  SelectField,
  Sheet,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
  type MatrixColumnDef,
  type MatrixRowDef,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import {
  createClinicType,
  deleteClinicType,
  fetchAllLongitudinalAssignments,
  fetchClinicSlots,
  fetchClinicTypes,
  fetchSupervisorAssignments,
  updateClinicType,
} from '../../../services/longitudinal';
import { uploadCccMatrix } from '../../../services/excelTemplates';
import { useInAppNotifications } from '../../../services/inAppNotifications';
import { getAcademicYears } from '../../../utils/academicYear';
import {
  CCC_FALLBACK_SLOTS,
  CCC_SCHEDULE_ROWS,
  type CccScheduleRow,
  dayOfWeekMatches,
  pgyLevelsForRow,
} from '../../../utils/cccMatrix';
import {
  PRIMARY_CARE_CLINIC_CATALOG,
  clinicNameKey,
  sortClinicOptions,
  type ClinicCatalogEntry,
} from '../../../utils/primaryCareClinics';
import { colors, radius, spacing } from '../../../theme';
import type { LongitudinalAssignment, LongitudinalClinicType } from '../../../types/api';
import { goBack } from '../../../navigation/back';

/**
 * Primary Care Clinics — who is where, on which day, supervised by whom.
 *
 * The programme's clinic pool starts as the five standard Primary Care Clinics
 * and grows as coordinators add others, either from the pre-defined catalog or by
 * typing an exact clinic name. Adding a clinic stores it against the programme
 * (`longitudinal_clinic_types`), so it becomes a selectable chip here and stays
 * available to every coordinator. See `utils/primaryCareClinics.ts` for the pool
 * and `services/longitudinal.createClinicType` for the persistence.
 *
 * ### Why the rows are code and the columns are data
 *
 * A rota grid needs both axes, and this database only reliably holds one of them.
 * `longitudinal_clinic_slots` defines the columns (the ten weekly WBC slots) but
 * holds no rows, and `longitudinal_clinic_types` does not record which academic
 * day each clinic runs on in a form this screen can rely on. Building the grid
 * from the database alone therefore renders an empty table — which reads as
 * "broken", not as "not configured".
 *
 * So the split is deliberate:
 *
 *  - **Rows come from `utils/cccMatrix.ts`.** They are the curriculum: PGY-3 on
 *    Sunday, PGY-2 on Monday, FMC on Tuesday and Thursday, PGY-1 on Wednesday,
 *    with the 10:30-14:00 and 07:00-14:00 sessions the clinic actually runs.
 *  - **Columns come from the API.** `longitudinal_clinic_slots` for the selected
 *    clinic, falling back to the canonical ten numbered slots when none are
 *    recorded, so the columns line up with the slot numbers a coordinator will
 *    assign to.
 *
 * What is never invented: **residents and faculty.** An empty cell says
 * "Unassigned" and the catch-up pool lists who is available. Putting a plausible
 * name in a clinical rota would be worse than an empty one.
 */

/** `'ALL'` means "do not filter by clinic type". */
type ClinicFilter = 'ALL' | string;

interface MatrixColumn {
  key: string;
  slot_number: number;
  title: string;
  subtitle: string | null;
  /** The API id of the real slot, or `null` for a fallback column. */
  slot_id: number | null;
  site_name: string | null;
}

/** One resident's placement, resolved from whichever table mentions them. */
interface Placement {
  /** Stable list key: the pairing row, or the resident when unplaced. */
  key: string;
  residentId: number;
  residentName: string;
  pgyLevel: number | null;
  /** The clinic slot the resident is paired to; 0 when unplaced. */
  slotNumber: number;
  facultyName: string | null;
  isPrimary: boolean;
}

export default function LongitudinalMatrixScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;
  const { notify } = useInAppNotifications();

  const academicYearOptions = useMemo(() => getAcademicYears(7, 3), []);
  const [academicYear, setAcademicYear] = useState(academicYearOptions[0] ?? '');

  /**
   * The programme's clinics, including inactive ones.
   *
   * Inactive rows are what the catalog knows about: a clinic that is on record
   * but was moved out of the default pool must not be offered again, and the
   * server reactivates it by name if a coordinator picks it. The chip pool below
   * filters to the active ones.
   */
  const clinicTypes = useApiResource(
    () => fetchClinicTypes(programId, { includeInactive: true }),
    [programId],
  );
  /**
   * Assignments are scoped by the selected year; supervisor assignments are not.
   *
   * `fetchAllLongitudinalAssignments` takes the year and the server filters by
   * overlap with that year's block window. `fetchSupervisorAssignments` has no
   * year parameter, so the pairings it returns are filtered here instead — by
   * matching each pairing's resident against the year-scoped assignment set. A
   * resident assigned to two clinics across two years appears once, under the
   * year they are actually in.
   */
  const assignments = useApiResource(
    () => fetchAllLongitudinalAssignments(programId, academicYear),
    [programId, academicYear],
  );
  const supervisors = useApiResource(() => fetchSupervisorAssignments(programId), [programId]);

  /** The clinics selectable right now: active, standard five first, then added. */
  const activeClinics = useMemo(
    () => (clinicTypes.data ?? []).filter((clinic) => clinic.is_active === 1),
    [clinicTypes.data],
  );

  /** The clinics selectable right now, in pool order (standard five first). */
  const orderedActiveClinics = useMemo<LongitudinalClinicType[]>(() => {
    const byName = new Map(activeClinics.map((clinic) => [clinicNameKey(clinic.clinic_name), clinic]));
    const ordered = sortClinicOptions(activeClinics.map((clinic) => clinic.clinic_name));
    return ordered.flatMap((name) => {
      const clinic = byName.get(clinicNameKey(name));
      return clinic ? [clinic] : [];
    });
  }, [activeClinics]);
  const [clinicFilter, setClinicFilter] = useState<ClinicFilter>('ALL');

  /**
   * The clinic whose slots become the matrix columns.
   *
   * WBC is the clinic the ten slots belong to, so it wins over whichever clinic
   * happens to be selected: filtering the *rows* by clinic type is a different
   * control from choosing the *columns*. Falls back to the selected clinic, then
   * to the first active clinic so a programme without a WBC row still gets real
   * slots.
   */
  const columnClinic = useMemo(() => {
    const wbc = activeClinics.find(
      (clinic) => /wbc/i.test(clinic.clinic_code ?? '') || /wbc/i.test(clinic.clinic_name ?? ''),
    );
    if (wbc) return wbc;
    if (clinicFilter !== 'ALL') {
      return activeClinics.find((clinic) => String(clinic.id) === clinicFilter) ?? null;
    }
    return activeClinics[0] ?? null;
  }, [activeClinics, clinicFilter]);

  const columnClinicId = columnClinic?.id ?? 0;
  const slots = useApiResource(
    () => (columnClinicId ? fetchClinicSlots(columnClinicId) : Promise.resolve([])),
    [columnClinicId],
  );

  /**
   * Columns: real slots when the clinic records them, canonical ten otherwise.
   *
   * Both carry `slot_number`, so a cell lookup written against slot 3 works
   * whether slot 3 came from the database or from the fallback.
   */
  const columns = useMemo<MatrixColumn[]>(() => {
    const recorded = (slots.data ?? []).filter((slot) => slot.is_active === 1);
    if (recorded.length === 0) {
      return CCC_FALLBACK_SLOTS.map((slot) => ({
        key: `slot-${slot.slot_number}`,
        slot_number: slot.slot_number,
        title: slot.slot_label,
        subtitle: null,
        slot_id: null,
        site_name: null,
      }));
    }
    return recorded.map((slot) => ({
      key: `slot-${slot.id}`,
      slot_number: slot.slot_number,
      title: slot.slot_label || `Clinic ${slot.slot_number}`,
      subtitle: dayOfWeekMatches(slot.day_of_week, CCC_SCHEDULE_ROWS[0].weekday) ? null : slot.day_of_week ?? null,
      slot_id: slot.id,
      site_name: slot.site_name,
    }));
  }, [slots.data]);

  /**
   * Placements, resolved from the supervisor assignments.
   *
   * A `longitudinal_clinic_supervisor_assignments` row is the only place that
   * holds *both* halves of a pairing — a resident and a clinic slot — so it is
   * the matrix's source of truth. `longitudinal_assignments` supplies the names,
   * PGY levels and days for residents who have not been paired yet.
   */
  const { placements, residentsByDay, facultyByRow } = useMemo(() => {
    const residentDetails = new Map<number, LongitudinalAssignment>();
    for (const assignment of assignments.data ?? []) {
      if (!residentDetails.has(assignment.resident_id)) {
        residentDetails.set(assignment.resident_id, assignment);
      }
    }

    const resolved: Placement[] = [];
    for (const [index, supervisor] of (supervisors.data ?? []).entries()) {
      if (supervisor.resident_id === null || supervisor.longitudinal_clinic_slot_id === null) continue;

      const slot = (slots.data ?? []).find((candidate) => candidate.id === supervisor.longitudinal_clinic_slot_id);
      const detail = residentDetails.get(supervisor.resident_id);

      /**
       * Pairings for a resident who is not in the selected year are dropped.
       *
       * `fetchSupervisorAssignments` takes no year, so without this a matrix for
       * 2026/2027 would keep showing a pairing that ended in 2025/2026 — the year
       * filter would change the subtitle and nothing else, which is worse than
       * having no filter at all.
       */
      if (!detail) continue;

      // A supervisor assignment with no matching slot row is reported rather than
      // hidden: a pairing the matrix cannot place is a data problem worth seeing.
      if (!slot) continue;

      resolved.push({
        key: `pairing-${supervisor.id ?? index}`,
        residentId: supervisor.resident_id,
        residentName: supervisor.resident_name ?? detail?.resident_name ?? `Resident ${supervisor.resident_id}`,
        pgyLevel: detail?.pgy_level ?? null,
        slotNumber: slot.slot_number,
        facultyName: supervisor.faculty_supervisor_name ?? null,
        isPrimary: supervisor.is_primary === 1,
      });
    }

    /**
     * Residents available on each academic day.
     *
     * Taken from the longitudinal assignments rather than the pairing table, so a
     * resident with no supervisor yet still appears in the catch-up pool. The day
     * is the assignment's `day_of_week`; PGY is the fallback when a cohort's day
     * is not recorded, since the curriculum fixes which day a PGY attends.
     */
    const byDay = new Map<string, Placement[]>();
    for (const detail of assignments.data ?? []) {
      const row = rowForAssignment(detail);
      if (!row) continue;
      const entry: Placement = {
        key: `unplaced-${row.key}-${detail.resident_id}`,
        residentId: detail.resident_id,
        residentName: detail.resident_name || `Resident ${detail.resident_id}`,
        pgyLevel: detail.pgy_level ?? null,
        slotNumber: 0,
        facultyName: detail.supervisor_name ?? null,
        isPrimary: false,
      };
      const bucket = byDay.get(row.key) ?? [];
      if (!bucket.some((existing) => existing.residentId === entry.residentId)) {
        bucket.push(entry);
      }
      byDay.set(row.key, bucket);
    }

    /** Faculty supervising each row, de-duplicated by name. */
    const faculty = new Map<string, string[]>();
    for (const placement of resolved) {
      if (!placement.facultyName) continue;
      const row = rowForResident(residentDetails.get(placement.residentId));
      if (!row) continue;
      const names = faculty.get(row.key) ?? [];
      if (!names.includes(placement.facultyName)) names.push(placement.facultyName);
      faculty.set(row.key, names);
    }

    return { placements: resolved, residentsByDay: byDay, facultyByRow: faculty };
  }, [assignments.data, supervisors.data, slots.data]);

  const columnDefs = useMemo<MatrixColumnDef[]>(
    () =>
      columns.map((column) => ({
        key: column.key,
        title: column.title,
        subtitle: column.site_name ?? column.subtitle ?? undefined,
        width: 124,
        align: 'center' as const,
      })),
    [columns],
  );

  /** `slot_number` -> the placements in that slot, for a cheap cell lookup. */
  const placementsBySlot = useMemo(() => {
    const map = new Map<number, Placement[]>();
    for (const placement of placements) {
      const bucket = map.get(placement.slotNumber) ?? [];
      bucket.push(placement);
      map.set(placement.slotNumber, bucket);
    }
    return map;
  }, [placements]);

  const rows = useMemo<MatrixRowDef[]>(() => {
    return CCC_SCHEDULE_ROWS.filter((row) => {
      if (clinicFilter === 'ALL') return true;
      const clinic = activeClinics.find((candidate) => String(candidate.id) === clinicFilter);
      if (!clinic) return true;
      // A clinic with no recorded day runs across the week, so it cannot narrow
      // the rows; the FMC days are not clinics either.
      if (!clinic.default_day_of_week) return true;
      return row.code === 'FMC' || dayOfWeekMatches(clinic.default_day_of_week, row.weekday);
    }).map((row) => {
      const rowPlacements = (residentsByDay.get(row.key) ?? []).map((resident) => resident.residentId);
      const faculty = facultyByRow.get(row.key) ?? [];
      const levels = pgyLevelsForRow(row);

      const cells: Record<string, React.ReactNode> = {};
      for (const column of columns) {
        const inSlot = (placementsBySlot.get(column.slot_number) ?? []).filter((placement) =>
          rowPlacements.includes(placement.residentId),
        );
        cells[column.key] = cellNode(inSlot);
      }

      const unplaced = (residentsByDay.get(row.key) ?? []).filter(
        (resident) => !placements.some((placement) => placement.residentId === resident.residentId),
      );

      return {
        key: row.key,
        accent: row.code === 'FMC' ? 'neutral' : row.code === 'PGY1' ? 'info' : row.code === 'PGY2' ? 'success' : 'warning',
        onPress: () => router.push('/program/supervisor/assign'),
        accessibilityLabel: `${row.label}, ${row.startTime} to ${row.endTime}. ${
          levels ? levels.map((level) => `PGY-${level}`).join(' and ') : row.caption
        }.`,
        frozenContent: (
          <View style={styles.rowHeader}>
            <Text variant="bodySmall" numberOfLines={1}>
              {row.label}
            </Text>
            <Text variant="caption" tone="secondary" numberOfLines={1}>
              {row.startTime}–{row.endTime}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {levels ? levels.map((level) => `PGY-${level}`).join(' / ') : row.caption}
            </Text>
            {faculty.length > 0 ? (
              <Text variant="caption" tone="muted" numberOfLines={1}>
                Lead: {faculty.join(', ')}
              </Text>
            ) : null}
            {unplaced.length > 0 ? (
              <Text variant="caption" tone="warning" numberOfLines={1}>
                Catch-up pool: {unplaced.length}
              </Text>
            ) : null}
          </View>
        ),
        cells,
      };
    });
  }, [columns, clinicFilter, activeClinics, residentsByDay, placementsBySlot, placements, facultyByRow]);

  const loading = clinicTypes.isLoading || assignments.isLoading || supervisors.isLoading || slots.isLoading;
  const error = clinicTypes.error ?? assignments.error ?? supervisors.error ?? slots.error;
  const usingFallbackSlots = (slots.data ?? []).filter((slot) => slot.is_active === 1).length === 0;
  const totalResidents = assignments.data?.length ?? 0;
  const totalPairings = placements.length;

  /* ---- Add / choose other clinic ---------------------------------------- */

  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [customName, setCustomName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  /** Clinics already on record for the programme, active or not. */
  const knownClinicKeys = useMemo(
    () => new Set((clinicTypes.data ?? []).map((clinic) => clinicNameKey(clinic.clinic_name))),
    [clinicTypes.data],
  );

  /**
   * The catalog entries that are not already on record.
   *
   * A clinic that was moved out of the default pool is still on record, so it is
   * excluded here — picking it would only reactivate the row it already has.
   */
  const catalogCandidates = useMemo(
    () => PRIMARY_CARE_CLINIC_CATALOG.filter((entry) => !knownClinicKeys.has(clinicNameKey(entry.name))),
    [knownClinicKeys],
  );

  const catalogNeedle = addQuery.trim().toLowerCase();
  const visibleCatalog = catalogNeedle
    ? catalogCandidates.filter((entry) => entry.name.toLowerCase().includes(catalogNeedle))
    : catalogCandidates;

  function resetAddForm() {
    setAddQuery('');
    setCustomName('');
    setAddError(null);
  }

  function closeAddSheet() {
    setAddOpen(false);
    resetAddForm();
  }

  /**
   * Add a clinic, then make it the clinic this view is showing.
   *
   * The row is inserted (or reactivated) server-side for the active programme and
   * patched into the local list immediately, so the new chip appears without a
   * round-trip; `refresh` then reconciles the list with the server.
   */
  async function handleAddClinic(payload: {
    clinic_name: string;
    default_day_of_week?: string | null;
    start_time?: string | null;
    end_time?: string | null;
    requires_release_letter?: number;
  }) {
    setAdding(true);
    setAddError(null);
    try {
      const created = await createClinicType({ program_id: programId, ...payload });
      clinicTypes.setData((current) => [
        ...(current ?? []).filter((clinic) => clinic.id !== created.id),
        created,
      ]);
      setClinicFilter(String(created.id));
      closeAddSheet();
      clinicTypes.refresh();
      notify({
        title: 'Clinic added',
        message: `${created.clinic_name} is now available in Primary Care Clinics.`,
        tone: 'success',
      });
    } catch (caught) {
      setAddError(caught instanceof Error ? caught.message : 'Could not add this clinic.');
    } finally {
      setAdding(false);
    }
  }

  function handleAddCatalog(entry: ClinicCatalogEntry) {
    void handleAddClinic({
      clinic_name: entry.name,
      default_day_of_week: entry.defaultDay,
      start_time: entry.startTime,
      end_time: entry.endTime,
      requires_release_letter: entry.requiresReleaseLetter ? 1 : 0,
    });
  }

  function handleAddCustom() {
    const name = customName.trim();
    if (!name) return;
    void handleAddClinic({ clinic_name: name });
  }

  /* ---- Edit / rename a clinic -------------------------------------------- */

  const [editingClinic, setEditingClinic] = useState<LongitudinalClinicType | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  function openEditClinic(clinic: LongitudinalClinicType) {
    setEditName(clinic.clinic_name);
    setEditError(null);
    setEditingClinic(clinic);
  }

  function closeEditClinic() {
    if (savingEdit) return;
    setEditingClinic(null);
    setEditName('');
    setEditError(null);
  }

  /**
   * Rename a clinic, then patch the row back into local state.
   *
   * The chip pool, the filter options and the header subtitle all derive from
   * `clinicTypes.data`, so replacing the renamed row in that list updates them
   * instantly; `refresh` then reconciles with the server so the single source
   * of truth stays the backend.
   */
  async function handleRenameClinic() {
    if (!editingClinic) return;
    const name = editName.trim();
    if (!name) {
      setEditError('A clinic name is required.');
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      const updated = await updateClinicType(editingClinic.id, {
        program_id: programId,
        clinic_name: name,
      });
      clinicTypes.setData((current) =>
        (current ?? []).map((clinic) => (clinic.id === updated.id ? updated : clinic)),
      );
      setEditingClinic(null);
      setEditName('');
      clinicTypes.refresh();
      notify({ title: 'Clinic renamed', message: updated.clinic_name, tone: 'success' });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not rename this clinic.';
      setEditError(message);
      notify({ title: 'Rename failed', message, tone: 'danger' });
    } finally {
      setSavingEdit(false);
    }
  }

  /* ---- Delete / deactivate a clinic -------------------------------------- */

  const [pendingDelete, setPendingDelete] = useState<LongitudinalClinicType | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function askDeleteClinic(clinic: LongitudinalClinicType) {
    setPendingDelete(clinic);
    setDeleteError(null);
    setConfirmingDelete(true);
  }

  /**
   * Deactivate a clinic, then drop it out of the active pool in place.
   *
   * The server soft-deletes the row so its slots, pairings and assignment
   * history survive. Local state flips the row inactive so the chip disappears
   * and, if it was the selected filter, the view falls back to "All clinics".
   */
  async function handleDeleteClinic() {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteClinicType(pendingDelete.id, programId);
      clinicTypes.setData((current) =>
        (current ?? []).map((clinic) =>
          clinic.id === pendingDelete.id ? { ...clinic, is_active: 0 } : clinic,
        ),
      );
      if (clinicFilter === String(pendingDelete.id)) {
        setClinicFilter('ALL');
      }
      setConfirmingDelete(false);
      setPendingDelete(null);
      clinicTypes.refresh();
      notify({
        title: 'Clinic removed',
        message: `${pendingDelete.clinic_name} was removed from the active clinics.`,
        tone: 'warning',
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not remove this clinic.';
      setDeleteError(message);
      notify({ title: 'Remove failed', message, tone: 'danger' });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Screen onRefresh={() => {
      void clinicTypes.refresh();
      void assignments.refresh();
      void supervisors.refresh();
      void slots.refresh();
    }}>
      <AppHeader
        title="Primary Care Clinics"
        subtitle={`${academicYear} · ${columnClinic?.clinic_name ?? 'Clinic slots'}`}
        onBack={goBack}
      />

      <SelectField
        label="Academic year"
        value={academicYear}
        onChange={setAcademicYear}
        options={academicYearOptions.map((year) => ({ value: year, label: year }))}
        hint="Scopes the residents to this year's block window. Pairings come from the supervisor table, so a pairing for a resident who left the programme in an earlier year is not shown."
      />

      <View style={styles.clinicField}>
        <Text variant="label" tone="secondary" uppercase>
          Clinic
        </Text>
        <ClinicFilterChips
          clinics={orderedActiveClinics}
          selected={clinicFilter}
          onSelect={setClinicFilter}
          onEdit={openEditClinic}
          onDelete={askDeleteClinic}
        />
        <Text variant="caption" tone="muted">
          Filters the rows. The columns are always the slot list of the selected slot clinic. Use the
          pencil to rename a clinic or the bin to remove it from the active pool; its history stays
          preserved.
        </Text>
      </View>

      <Button
        label="Add / Choose Other Clinic"
        variant="outline"
        icon={PlusCircle}
        onPress={() => {
          setAddError(null);
          setAddOpen(true);
        }}
        accessibilityHint="Opens the clinic catalog and lets you type a custom clinic name"
        style={styles.addClinicButton}
      />

      <ImportTools
        template="ccc"
        uploadLabel="Upload Primary Care Clinics Matrix"
        upload={(file) =>
          uploadCccMatrix(file, { program_id: programId, academic_year: academicYear })
        }
        onImported={() => {
          void clinicTypes.refresh();
          void assignments.refresh();
          void supervisors.refresh();
          void slots.refresh();
        }}
      />

      {loading ? <SkeletonList rows={4} /> : null}

      {error ? <ErrorState title="Could not load the matrix" message={error.message} onRetry={() => {
        void clinicTypes.refresh();
        void assignments.refresh();
      }} /> : null}

      {usingFallbackSlots ? (
        <Banner
          tone="info"
          title="Showing the standard ten clinic slots"
          message={`${columnClinic?.clinic_name ?? 'This clinic'} has no slots recorded yet, so the canonical Clinic 1-10 columns are shown. Add slots to replace them.`}
        />
      ) : null}

      {totalPairings === 0 && totalResidents > 0 ? (
        <Banner
          tone="warning"
          title="No resident is paired to a clinic slot yet"
          message="Assign a supervisor from the Assign faculty screen and the pairings appear here."
        />
      ) : null}

      <SectionHeader
        title="Weekly schedule"
        trailing={`${rows.length} academic days · ${columns.length} slots`}
      />

      <MatrixTable
        columns={columnDefs}
        rows={rows}
        frozenHeader="Academic day"
        frozenWidth={176}
        rowHeight={64}
        emptyTitle="No academic days to show"
        emptyMessage="The curriculum rows for this clinic are all filtered out. Clear the clinic filter."
      />

      <SectionHeader title="Catch-up pools" />
      <CatchUpPools rows={rows} residentsByDay={residentsByDay} placements={placements} loading={loading} />

      {!loading && totalResidents === 0 ? (
        <Card>
          <EmptyState
            icon={CalendarX}
            title="No Primary Care Clinic assignments yet"
            message="Assign residents to a clinic and this matrix will fill in."
            actionLabel="Assign faculty"
            onActionPress={() => router.push('/program/supervisor/assign')}
          />
        </Card>
      ) : null}

      <Sheet
        visible={addOpen}
        onClose={closeAddSheet}
        title="Add a clinic"
        subtitle="Choose a clinic from the catalog or type an exact name."
        footer={
          <Button
            label="Close"
            variant="outline"
            onPress={closeAddSheet}
            accessibilityHint="Closes this list without adding a clinic"
          />
        }
      >
        {addError ? <Banner tone="danger" title="Could not add the clinic" message={addError} /> : null}

        <TextField
          label="Other / custom clinic name"
          value={customName}
          onChangeText={setCustomName}
          placeholder="e.g. Al Noor Diabetes Clinic"
          hint="Use this when the clinic is not in the catalog below. It is stored for this programme and offered to every coordinator."
        />
        <Button
          label={adding ? 'Adding…' : 'Add custom clinic'}
          onPress={handleAddCustom}
          disabled={customName.trim().length === 0 || adding}
          loading={adding}
          style={styles.customButton}
        />

        <SectionHeader title="Catalog" trailing={`${visibleCatalog.length} available`} />

        <SearchInput
          value={addQuery}
          onChangeText={setAddQuery}
          placeholder="Search clinics"
          accessibilityLabel="Search the clinic catalog"
        />

        <View style={styles.catalogList}>
          {visibleCatalog.map((entry) => (
            <Pressable
              key={entry.name}
              onPress={() => handleAddCatalog(entry)}
              disabled={adding}
              accessibilityRole="button"
              accessibilityLabel={`Add ${entry.name}`}
              style={({ pressed }) => [styles.catalogRow, pressed && !adding ? styles.catalogRowPressed : null]}
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

          {visibleCatalog.length === 0 ? (
            <Text variant="bodySmall" tone="muted" align="center" style={styles.catalogEmpty}>
              {catalogNeedle
                ? `No catalog clinic matches “${addQuery.trim()}”. Type it above to add it.`
                : 'Every catalog clinic is already in the pool. Type a custom name above to add another.'}
            </Text>
          ) : null}
        </View>
      </Sheet>

      <Sheet
        visible={editingClinic !== null}
        onClose={closeEditClinic}
        title="Rename clinic"
        subtitle={editingClinic ? `${editingClinic.clinic_name} · ${editingClinic.clinic_code}` : undefined}
        footer={
          <View style={styles.footer}>
            <Button
              label={savingEdit ? 'Saving…' : 'Save name'}
              loading={savingEdit}
              onPress={() => void handleRenameClinic()}
              accessibilityHint="Updates the clinic name everywhere it is shown"
            />
            <Button
              label="Cancel"
              variant="ghost"
              disabled={savingEdit}
              onPress={closeEditClinic}
            />
          </View>
        }
      >
        {editError ? (
          <Banner tone="danger" title="Could not rename the clinic" message={editError} />
        ) : null}

        <TextField
          label="Clinic name"
          required
          value={editName}
          onChangeText={setEditName}
          placeholder="e.g. Well Baby Clinic (WBC)"
          autoCapitalize="words"
          hint="Renaming updates the chip here and every screen that shows this clinic. Slots and assignment history are preserved."
        />
      </Sheet>

      <Sheet
        visible={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        title="Delete this clinic?"
        subtitle={pendingDelete ? pendingDelete.clinic_name : undefined}
        footer={
          <View style={styles.footer}>
            <Button
              label={deleting ? 'Removing…' : 'Remove clinic'}
              variant="danger"
              loading={deleting}
              onPress={() => void handleDeleteClinic()}
              accessibilityHint="Removes this clinic from the active selection pool"
            />
            <Button
              label="Keep it"
              variant="ghost"
              disabled={deleting}
              onPress={() => setConfirmingDelete(false)}
            />
          </View>
        }
      >
        {deleteError ? (
          <Banner tone="danger" title="Cannot remove this clinic" message={deleteError} />
        ) : null}

        <Text variant="bodySmall" tone="secondary">
          Are you sure you want to delete {pendingDelete?.clinic_name ?? 'this clinic'}? Existing
          slots and historical data linked to this clinic will be preserved.
        </Text>
      </Sheet>
    </Screen>
  );
}

/** One catalog row's supporting line: the session, and whether a letter is needed. */
function describeCatalogEntry(entry: ClinicCatalogEntry): string {
  const parts: string[] = [];
  if (entry.defaultDay) {
    parts.push(`${titleCaseDay(entry.defaultDay)}${entry.startTime && entry.endTime ? ` ${entry.startTime}–${entry.endTime}` : ''}`);
  } else if (entry.startTime && entry.endTime) {
    parts.push(`Any day ${entry.startTime}–${entry.endTime}`);
  } else {
    parts.push('No fixed day');
  }
  if (entry.requiresReleaseLetter) parts.push('Release letter required');
  return parts.join(' · ');
}

function titleCaseDay(day: string): string {
  const lower = day.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The clinic filter chips, each with rename and remove actions.
 *
 * "All clinics" filters nothing and has no actions; every active clinic chip is
 * a selectable filter (tapping the label) plus two icon buttons — a pencil to
 * rename it in place and a bin to deactivate it, with confirmation.
 */
function ClinicFilterChips({
  clinics,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  clinics: LongitudinalClinicType[];
  selected: ClinicFilter;
  onSelect: (value: ClinicFilter) => void;
  onEdit: (clinic: LongitudinalClinicType) => void;
  onDelete: (clinic: LongitudinalClinicType) => void;
}) {
  return (
    <View style={styles.clinicChips} accessibilityRole="radiogroup" accessibilityLabel="Clinic">
      <Pressable
        onPress={() => onSelect('ALL')}
        accessibilityRole="radio"
        accessibilityState={{ selected: selected === 'ALL' }}
        accessibilityLabel="All clinics"
        style={({ pressed }) => [
          styles.clinicChip,
          selected === 'ALL' ? styles.clinicChipSelected : null,
          pressed && selected !== 'ALL' ? styles.clinicChipPressed : null,
        ]}
      >
        {selected === 'ALL' ? <Check color={colors.onPrimary} size={14} strokeWidth={3} /> : null}
        <Text
          variant="bodySmall"
          style={selected === 'ALL' ? styles.clinicChipTextSelected : styles.clinicChipText}
        >
          All clinics
        </Text>
      </Pressable>

      {clinics.map((clinic) => {
        const isSelected = selected === String(clinic.id);
        const actionStyle = ({ pressed }: { pressed: boolean }) => [
          styles.clinicAction,
          isSelected ? styles.clinicActionOnSelected : null,
          pressed ? (isSelected ? styles.clinicActionPressedSelected : styles.clinicActionPressed) : null,
        ];
        return (
          <View
            key={clinic.id}
            style={[styles.clinicChipRow, isSelected ? styles.clinicChipRowSelected : null]}
          >
            <Pressable
              onPress={() => onSelect(String(clinic.id))}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={clinic.clinic_name}
              style={({ pressed }) => [
                styles.clinicChipMain,
                pressed && !isSelected ? styles.clinicChipPressed : null,
              ]}
            >
              {isSelected ? <Check color={colors.onPrimary} size={14} strokeWidth={3} /> : null}
              <Text
                variant="bodySmall"
                numberOfLines={2}
                style={isSelected ? styles.clinicChipTextSelected : styles.clinicChipText}
              >
                {clinic.clinic_name}
              </Text>
            </Pressable>

            <View style={styles.clinicChipActions}>
              <Pressable
                onPress={() => onEdit(clinic)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Rename ${clinic.clinic_name}`}
                accessibilityHint="Opens a form to change this clinic's name"
                style={actionStyle}
              >
                <Pencil color={isSelected ? colors.onPrimary : colors.primary} size={16} />
              </Pressable>
              <Pressable
                onPress={() => onDelete(clinic)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${clinic.clinic_name}`}
                accessibilityHint="Deactivates this clinic and removes it from the active pool"
                style={actionStyle}
              >
                <Trash2 color={isSelected ? colors.dangerSurface : colors.danger} size={16} />
              </Pressable>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The residents free to cover a missed session on one academic day. */
function CatchUpPools({
  rows,
  residentsByDay,
  placements,
  loading,
}: {
  rows: MatrixRowDef[];
  residentsByDay: Map<string, Placement[]>;
  placements: Placement[];
  loading: boolean;
}) {
  const placed = new Set(placements.map((placement) => placement.residentId));

  return (
    <View style={styles.pools}>
      {rows.map((row) => {
        const available = (residentsByDay.get(row.key) ?? []).filter((resident) => !placed.has(resident.residentId));
        const scheduleRow = CCC_SCHEDULE_ROWS.find((candidate) => candidate.key === row.key);

        return (
          <View key={row.key} style={styles.pool}>
            <View style={styles.poolHeader}>
              <StatusBadge
                label={scheduleRow?.label ?? row.key}
                tone={scheduleRow?.code === 'FMC' ? 'neutral' : 'info'}
              />
              <Text variant="caption" tone="secondary">
                {scheduleRow ? `${scheduleRow.startTime}–${scheduleRow.endTime}` : ''}
              </Text>
            </View>

            {loading ? (
              <Text variant="caption" tone="muted">
                Loading…
              </Text>
            ) : available.length === 0 ? (
              <Text variant="caption" tone="muted">
                Everyone on this day is placed in a slot.
              </Text>
            ) : (
              <View style={styles.poolChips}>
                {available.map((resident) => (
                  <Text key={resident.residentId} variant="caption" tone="secondary">
                    {resident.residentName}
                    {resident.pgyLevel ? ` (PGY-${resident.pgyLevel})` : ''}
                  </Text>
                ))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** The badge drawn inside one slot cell. */
function cellNode(placements: Placement[]): React.ReactNode {
  if (placements.length === 0) {
    return (
      <Text variant="caption" tone="disabled" align="center">
        Unassigned
      </Text>
    );
  }

  return (
    <View style={styles.cellBadges}>
      {placements.map((placement) => (
        <View key={placement.key} style={styles.cellBadge} accessible accessibilityLabel={`${placement.residentName}${
          placement.facultyName ? `, supervised by ${placement.facultyName}` : ''
        }`}>
          <Text variant="caption" numberOfLines={1}>
            {placement.residentName}
          </Text>
          {placement.facultyName ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {placement.facultyName}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** The academic day a longitudinal assignment belongs to. */
function rowForAssignment(assignment: LongitudinalAssignment): CccScheduleRow | null {
  const byDay = CCC_SCHEDULE_ROWS.find((row) => dayOfWeekMatches(assignment.day_of_week, row.weekday));
  if (byDay) return byDay;

  // No recorded day: the curriculum fixes which day a PGY attends.
  const levels = assignment.pgy_level ? [assignment.pgy_level] : [];
  return CCC_SCHEDULE_ROWS.find((row) => {
    const rowLevels = pgyLevelsForRow(row);
    return rowLevels !== null && levels.some((level) => rowLevels.includes(level));
  }) ?? null;
}

/** The academic day a resident belongs to, for pairing rows to curriculum rows. */
function rowForResident(assignment: LongitudinalAssignment | undefined): CccScheduleRow | null {
  return assignment ? rowForAssignment(assignment) : null;
}

const styles = StyleSheet.create({
  rowHeader: {
    gap: 1,
  },
  cellBadges: {
    gap: 2,
  },
  cellBadge: {
    borderWidth: 1,
    borderColor: colors.primaryBorder,
    borderRadius: radius.sm,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  addClinicButton: {
    marginBottom: spacing.lg,
  },
  customButton: {
    marginBottom: spacing.lg,
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
  clinicField: {
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  clinicChips: {
    gap: spacing.sm,
  },
  clinicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  clinicChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  clinicChipPressed: {
    backgroundColor: colors.primarySoft,
  },
  clinicChipText: {
    color: colors.textSecondary,
  },
  clinicChipTextSelected: {
    color: colors.onPrimary,
    fontWeight: '600',
  },
  clinicChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  clinicChipRowSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  clinicChipMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    alignSelf: 'stretch',
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
  },
  clinicChipActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xxs,
    paddingRight: spacing.xs,
  },
  clinicAction: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  clinicActionOnSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  clinicActionPressed: {
    backgroundColor: colors.surfaceMuted,
  },
  clinicActionPressedSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.26)',
  },
  footer: {
    gap: spacing.sm,
  },
  pools: {
    gap: spacing.sm,
  },
  pool: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  poolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  poolChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
