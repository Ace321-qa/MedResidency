import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarX, Download, Mail, Plus } from 'lucide-react-native';
import { router, useFocusEffect } from 'expo-router';

import {
  AppHeader,
  Banner,
  Button,
  Card,
  CapacityBanner,
  CapacityOkNote,
  CheckboxField,
  ChoiceGroup,
  DateField,
  EmptyState,
  ErrorState,
  ExportMenu,
  ImportTools,
  MatrixTable,
  NoticeDispatchSheet,
  ScheduleReportView,
  Screen,
  SegmentedControl,
  SelectField,
  Sheet,
  SheetSelectField,
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
  type MatrixRowDef,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { createAssignment, checkAssignmentCapacity, fetchCohortGrid, fetchRotations, sendRotationNotices, setBlockFinalized } from '../../../services/rotations';
import { describeDispatchOutcome } from '../../../utils/noticeDispatch';
import { downloadScheduleReport } from '../../../services/scheduleExport';
import { buildMasterGridReport } from '../../../utils/scheduleExport';
import { uploadMasterGrid } from '../../../services/excelTemplates';
import {
  ACADEMIC_DAYS,
  academicDayForPgy,
  getAcademicYearStartDate,
  getAcademicYears,
} from '../../../utils/academicYear';
import { describeWindow, isCalendarDate } from '../../../utils/dateCalc';
import { capacityOptionLabel, isAtCapacity } from '../../../utils/capacityRules';
import { rotationBadgeLabel, rotationCellDescription, rotationPalette } from '../../../utils/rotationBadges';
import { colors, radius, spacing } from '../../../theme';
import { ApiError } from '../../../services/client';
import type {
  CapacityVerdict,
  CohortGridCell,
  RotationNoticeDispatchResult,
} from '../../../types/api';
import { goBack } from '../../../navigation/back';
import {
  blockWindow,
  weekNumberForDate,
  weekWindow,
  weeksForRange,
  weekInBlockForDate,
  MASTER_GRID_START,
  type GridStart,
} from '../../../utils/masterGridCalendar';
import { buildMasterGridBlockColumns, blockColumnKey, buildMasterGridColumns } from '../../../utils/masterGridColumns';
import { sortResidentsByPgy } from '../../../utils/residentOrder';

type ViewMode = 'block' | 'weekly';
type PgyFilter = 'ALL' | '1' | '2' | '3' | '4' | '5';

const PGY_OPTIONS: SelectOption<PgyFilter>[] = [
  { value: 'ALL', label: 'All' },
  { value: '1', label: 'PGY-1' },
  { value: '2', label: 'PGY-2' },
  { value: '3', label: 'PGY-3' },
  { value: '4', label: 'PGY-4' },
  { value: '5', label: 'PGY-5' },
];

const VIEW_OPTIONS: SelectOption<ViewMode>[] = [
  { value: 'block', label: 'Block' },
  { value: 'weekly', label: 'Weekly' },
];

const BLOCK_NUMBERS = Array.from({ length: 13 }, (_, index) => index + 1);

interface GridBlock {
  block_id: number;
  block_number: number;
  // `block_name` is deliberately not carried: it is coordinator-typed free text
  // and must never reach a column header (see `buildMasterGridBlockColumns`).
  // The notice-dispatch labels follow the same rule, naming blocks by their
  // number only, so a typed name can never leak into a heading or a letter.
  startDateIso: string | null;
  endDateIso: string | null;
  /**
   * Whether the coordinator has declared this block settled, so its notices may
   * be sent. Carried here (unlike `block_name`) because it is a stored state
   * flag rather than free text, and the grid already has the block row in hand.
   */
  is_finalized: number | boolean | null;
}

interface GridResident {
  resident_id: number;
  resident_name: string;
  first_name: string;
  last_name: string;
  employee_id: string | null;
  pgy_level: number | null;
  contact_number: string | null;
  program_code: string;
}

function cellKey(residentId: number, blockId: number): string {
  return `${residentId}:${blockId}`;
}

function assignedRows(cell: CohortGridCell[] | undefined): CohortGridCell[] {
  if (!cell) return [];
  return cell.filter((row) => row.is_assigned === 1 && row.rotation_name);
}

function getWeekNumberForAssignment(
  assignment: CohortGridCell,
  weekNum?: number,
  gridStart: GridStart = MASTER_GRID_START,
): number | null {
  if (weekNum) return weekNum;
  if (assignment.start_date) {
    const w = weekNumberForDate(assignment.start_date, gridStart);
    if (w) return w;
  }
  if (assignment.end_date) {
    const w = weekNumberForDate(assignment.end_date, gridStart);
    if (w) return w;
  }
  return null;
}

export default function MasterGridScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const academicYearOptions = useMemo(() => getAcademicYears(7, 3), []);
  const [academicYear, setAcademicYear] = useState(academicYearOptions[0] ?? '');
  // The Coordinator-chosen start of the academic year. Every block and weekly
  // header is recalculated from it, so picking a Monday (rather than the
  // default Sunday) redraws the whole grid immediately.
  const [startDate, setStartDate] = useState(
    () => getAcademicYearStartDate(academicYearOptions[0] ?? '') ?? MASTER_GRID_START,
  );
  const [pgyFilter, setPgyFilter] = useState<PgyFilter>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('block');
  const [assignSheetOpen, setAssignSheetOpen] = useState(false);
  const [selected, setSelected] = useState<{
    residentId: number;
    residentName: string;
    blockId?: number;
    blockNumber?: number;
    weekNumber?: number;
    startDate?: string;
    endDate?: string;
  } | null>(null);
  const [assignRotationId, setAssignRotationId] = useState<number | null>(null);
  /** The block the modal is assigning into, for the picker's occupancy count. */
  const selectedBlockId = selected?.blockId ?? null;
  const [assignNotes, setAssignNotes] = useState('');
  // The seat-limit verdict for the placement being prepared, stamped with the
  // rotation-and-window key it answers. It is fetched from the server rather than
  // derived here, so the banner and the enforcement can never disagree.
  //
  // `failed` records that the check could not be completed, which is a *third*
  // state distinct from "still checking" and "checked, and fine". Without it a
  // dropped request collapsed to the same silent nothing as a within-capacity
  // rotation, so a coordinator looking at an over-capacity department saw no
  // warning at all — the limit appeared to pass when it had never been asked.
  const [verdict, setVerdict] = useState<{
    key: string;
    verdict: CapacityVerdict | null;
    failed: boolean;
  } | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [exceptionApprover, setExceptionApprover] = useState('');
  const [facultyConfirmed, setFacultyConfirmed] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Bumped to re-run the seat-limit check after a failed one. */
  const [capacityAttempt, setCapacityAttempt] = useState(0);

  // --- Notice dispatch -----------------------------------------------------
  // The block whose notices are being prepared. Defaults to the earliest block
  // that has assignments, so the action is usable immediately without the
  // coordinator first having to pick a block they can see on screen anyway.
  const [noticeBlockNumber, setNoticeBlockNumber] = useState<number | null>(null);
  const [noticeSheetOpen, setNoticeSheetOpen] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [noticeOutcome, setNoticeOutcome] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const reportRef = useRef<View>(null);

  // Changing the academic year resets the start date to that year's default
  // (28 June), so the grid never mixes one year's dates with another's.
  function handleAcademicYearChange(year: string) {
    setAcademicYear(year);
    setStartDate(getAcademicYearStartDate(year) ?? MASTER_GRID_START);
  }

  const pgyLevel = pgyFilter === 'ALL' ? undefined : Number(pgyFilter);

  const grid = useApiResource(
    () => fetchCohortGrid({ academic_year: academicYear, pgy_level: pgyLevel, program_id: programId }),
    [academicYear, pgyLevel, programId],
  );

  const rotations = useApiResource(() => fetchRotations(programId), [programId]);

  /**
   * Re-read the grid whenever the screen is focused again.
   *
   * A rotation request is approved on the Approvals tab, which writes a rota row
   * this screen has already fetched; without a refetch the newly-created
   * assignment stays invisible until a manual pull-to-refresh. The first focus
   * is the mount, which `useApiResource` already loads, so it is skipped — only
   * a *return* to the screen refetches.
   */
  const refreshGrid = grid.refresh;
  const hasFocusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedOnce.current) {
        hasFocusedOnce.current = true;
        return;
      }
      refreshGrid();
    }, [refreshGrid]),
  );

  const { blocksByNumber, residents, cellFor } = useMemo(() => {
    const blockMap = new Map<number, GridBlock>();
    const residentMap = new Map<number, GridResident>();
    const cellsByResidentBlock = new Map<string, CohortGridCell[]>();

    for (const row of grid.data ?? []) {
      if (!blockMap.has(row.block_number)) {
        blockMap.set(row.block_number, {
          block_id: row.block_id,
          block_number: row.block_number,
          startDateIso: row.block_start_date_iso,
          endDateIso: row.block_end_date_iso,
          is_finalized: row.is_finalized ?? 0,
        });
      }
      if (!residentMap.has(row.resident_id)) {
        residentMap.set(row.resident_id, {
          resident_id: row.resident_id,
          resident_name: row.resident_name,
          first_name: row.first_name,
          last_name: row.last_name,
          employee_id: row.employee_id ?? null,
          pgy_level: row.pgy_level,
          contact_number: row.contact_number,
          program_code: row.program_code,
        });
      }
      const key = cellKey(row.resident_id, row.block_id);
      const existing = cellsByResidentBlock.get(key);
      if (existing) {
        existing.push(row);
      } else {
        cellsByResidentBlock.set(key, [row]);
      }
    }

    const byNumber = new Map<number, GridBlock>();
    for (const block of blockMap.values()) byNumber.set(block.block_number, block);

    return {
      blocksByNumber: byNumber,
      // Senior cohorts lead the grid: PGY-5 at the top down to PGY-1, then
      // alphabetically within a level. The API already orders this way, but the
      // sort is applied here too so the on-screen rows are correct even if a
      // cached/serialized response arrives in another order.
      residents: sortResidentsByPgy(Array.from(residentMap.values())),
      cellFor: (residentId: number, blockId: number): CohortGridCell[] | undefined =>
        cellsByResidentBlock.get(cellKey(residentId, blockId)),
    };
  }, [grid.data]);

  // The weekly columns and their Block 1..13 tier-1 headings are rebuilt from
  // the selected start date, so both tiers stay in step with the picker.
  const { columns: columnsWeekly, groups: weeklyGroups } = useMemo(
    () => buildMasterGridColumns(startDate),
    [startDate],
  );

  // Block number → `rotation_blocks.block_id` for the academic year on screen.
  // Only the columns' keys come from this; the headers are drawn from the grid
  // calendar itself (see `buildMasterGridBlockColumns`).
  const blockIdsByNumber = useMemo(
    () => new Map<number, number | undefined>(Array.from(blocksByNumber, ([number, block]) => [number, block.block_id])),
    [blocksByNumber],
  );

  const columnsBlock = useMemo(
    () => buildMasterGridBlockColumns(blockIdsByNumber, startDate),
    [blockIdsByNumber, startDate],
  );

  const rowsBlock = useMemo<MatrixRowDef[]>(
    () =>
      residents.map((resident) => {
        const dayCode = academicDayForPgy(resident.pgy_level);
        const academicDay = ACADEMIC_DAYS.find((day) => day.code === dayCode);
        const cells: Record<string, React.ReactNode> = {};

        for (const blockNumber of BLOCK_NUMBERS) {
          const block = blocksByNumber.get(blockNumber);
          const columnKey = blockColumnKey(blockNumber, block?.block_id);
          cells[columnKey] = blockCellNode(
            resident.resident_id,
            cellFor(resident.resident_id, block?.block_id ?? 0),
            block,
            startDate,
            () =>
              openAssignSheet({
                residentId: resident.resident_id,
                residentName: resident.resident_name,
                blockId: block?.block_id,
                blockNumber: block?.block_number ?? blockNumber,
              }),
          );
        }

        return {
          key: `resident-${resident.resident_id}`,
          accent:
            dayCode === 'PGY1' ? 'info' : dayCode === 'PGY2' ? 'success' : dayCode === 'PGY3' ? 'warning' : undefined,
          onPress: () => router.push(`/program/resident/${resident.resident_id}`),
          accessibilityLabel: `${resident.resident_name}, ${resident.pgy_level ? `PGY-${resident.pgy_level}` : 'PGY not set'}. Opens the resident.`,
          frozenContent: (
            <View style={styles.residentCell}>
              <Text variant="bodySmall" numberOfLines={1}>
                {resident.resident_name}
              </Text>
              <View style={styles.residentMeta}>
                <Text variant="caption" tone="secondary">
                  {resident.pgy_level ? `PGY-${resident.pgy_level}` : 'PGY —'}
                </Text>
                {academicDay ? <StatusBadge label={academicDay.label} tone={rowAccentTone(dayCode)} /> : null}
              </View>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {resident.contact_number ?? 'No mobile recorded'}
              </Text>
            </View>
          ),
          cells,
        };
      }),
    [residents, blocksByNumber, cellFor, startDate],
  );

  const rowsWeekly = useMemo<MatrixRowDef[]>(
    () =>
      residents.map((resident) => {
        const dayCode = academicDayForPgy(resident.pgy_level);
        const academicDay = ACADEMIC_DAYS.find((day) => day.code === dayCode);
        const cells: Record<string, React.ReactNode> = {};

        const weekToAssignments = new Map<number, CohortGridCell[]>();
        for (const blockNumber of BLOCK_NUMBERS) {
          const block = blocksByNumber.get(blockNumber);
          if (!block) continue;
          const assignments = assignedRows(cellFor(resident.resident_id, block.block_id));
          for (const a of assignments) {
            for (const w of weeksForAssignment(a, startDate)) {
              if (w >= 1 && w <= 52) {
                const list = weekToAssignments.get(w) ?? [];
                list.push(a);
                weekToAssignments.set(w, list);
              }
            }
          }
        }

        for (let w = 1; w <= 52; w += 1) {
          const win = weekWindow(w, startDate);
          cells[`week-${w}`] = weeklyCellNode(resident.resident_id, weekToAssignments.get(w), w, startDate, () =>
            openAssignSheet({
              residentId: resident.resident_id,
              residentName: resident.resident_name,
              weekNumber: w,
              startDate: win?.start,
              endDate: win?.end,
            }),
          );
        }

        return {
          key: `resident-${resident.resident_id}`,
          accent:
            dayCode === 'PGY1' ? 'info' : dayCode === 'PGY2' ? 'success' : dayCode === 'PGY3' ? 'warning' : undefined,
          onPress: () => router.push(`/program/resident/${resident.resident_id}`),
          accessibilityLabel: `${resident.resident_name}, ${resident.pgy_level ? `PGY-${resident.pgy_level}` : 'PGY not set'}. Opens the resident.`,
          frozenContent: (
            <View style={styles.residentCell}>
              <Text variant="bodySmall" numberOfLines={1}>
                {resident.resident_name}
              </Text>
              <View style={styles.residentMeta}>
                <Text variant="caption" tone="secondary">
                  {resident.pgy_level ? `PGY-${resident.pgy_level}` : 'PGY —'}
                </Text>
                {academicDay ? <StatusBadge label={academicDay.label} tone={rowAccentTone(dayCode)} /> : null}
              </View>
              <Text variant="caption" tone="muted" numberOfLines={1}>
                {resident.contact_number ?? 'No mobile recorded'}
              </Text>
            </View>
          ),
          cells,
        };
      }),
    [residents, blocksByNumber, cellFor, startDate],
  );

  /**
   * The date window a placement into the selected cell would occupy.
   *
   * Pulled out so the capacity preview and the write compute it once: a preview
   * that checked a different window than the write would be worse than no
   * preview at all.
   */
  const targetWindow = useMemo(() => {
    if (!selected) return null;
    const start =
      selected.startDate ??
      (selected.blockNumber ? blockWindowStart(selected.blockNumber, startDate) : MASTER_GRID_START);
    const end =
      selected.endDate ?? (selected.blockNumber ? blockWindowEnd(selected.blockNumber, startDate) : null);
    return { start, end: end ?? start };
  }, [selected, startDate]);

  function openAssignSheet(opts: {
    residentId: number;
    residentName: string;
    blockId?: number;
    blockNumber?: number;
    weekNumber?: number;
    startDate?: string;
    endDate?: string;
  }) {
    setSelected(opts);
    setAssignRotationId(null);
    setAssignNotes('');
    setVerdict(null);
    setExceptionReason('');
    setExceptionApprover('');
    setFacultyConfirmed(false);
    setAssignError(null);
    setAssignSheetOpen(true);
  }

  // Ask the server for a verdict whenever the rotation or the window changes.
  // Debounced by a cancelled flag rather than a timer: a verdict the user has
  // moved on from must never land, and a stale one is worse than a missing one.
  //
  // Nothing is set synchronously in this effect — a `setState` in an effect body
  // cascades renders. Instead each result is stamped with the key it answers,
  // and the reading below trusts a result only while the key still matches. A
  // selection with no matching result is therefore *derived* as "still checking"
  // rather than declared as such, so the loading state needs no effect at all.
  useEffect(() => {
    if (!assignSheetOpen || !assignRotationId || !targetWindow) return;
    const key = verdictKey(assignRotationId, targetWindow.start, targetWindow.end);
    let cancelled = false;
    // Re-selecting the rotation that already failed would not change
    // `assignRotationId`, so the effect would not re-run and the retry the
    // failure banner offers would do nothing. `capacityAttempt` is that retry:
    // it is a dependency purely so an identical selection can be re-asked.
    checkAssignmentCapacity({
      rotation_id: assignRotationId,
      program_id: programId ?? undefined,
      start_date: targetWindow.start,
      end_date: targetWindow.end,
    })
      .then((next) => {
        if (!cancelled) setVerdict({ key, verdict: next, failed: false });
      })
      .catch(() => {
        // The check itself failed — the network dropped, or the server answered
        // with an error. This is recorded as a failure rather than as "no
        // verdict", because the two must not look alike: a missing verdict used
        // to render the same empty space as a within-capacity rotation, so an
        // unchecked over-capacity placement looked approved. The write still
        // enforces the limit, but the coordinator is told the preview is blind.
        if (!cancelled) setVerdict({ key, verdict: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [assignSheetOpen, assignRotationId, programId, targetWindow, capacityAttempt]);

  /**
   * The verdict, but only while it still describes the current selection.
   *
   * A result fetched for one rotation must never be shown for another, and
   * comparing the key here is what lets the effect above avoid a synchronous
   * `setVerdict(null)` — a stale value is simply not read, and reads as pending.
   */
  const verdictKeyForSelection =
    assignRotationId && targetWindow
      ? verdictKey(assignRotationId, targetWindow.start, targetWindow.end)
      : null;
  const settled =
    verdict && verdict.key === verdictKeyForSelection ? verdict : null;
  const activeVerdict = settled?.verdict ?? null;
  const verdictLoading = Boolean(verdictKeyForSelection && !settled);
  /** The preview could not be completed, so the coordinator is told so. */
  const verdictFailed = settled?.failed === true;

  async function handleAssign() {
    if (!selected || !assignRotationId || !programId || !targetWindow) return;
    setAssignError(null);
    setSaving(true);

    // Only an exception-requiring verdict sends the rationale: a green placement
    // carrying an exception would record an audit row for a non-event.
    const needsException = activeVerdict?.requires_exception === true;
    try {
      await createAssignment({
        resident_id: selected.residentId,
        rotation_id: assignRotationId,
        rotation_block_id: selected.blockId ?? 0,
        start_date: targetWindow.start,
        end_date: targetWindow.end,
        notes: assignNotes || undefined,
        assignment_type: 'PARTIAL_BLOCK',
        ...(needsException
          ? {
              exception_reason: exceptionReason.trim(),
              exception_approver: exceptionApprover.trim(),
              faculty_supervision_confirmed: facultyConfirmed,
            }
          : {}),
      });
      setAssignSheetOpen(false);
      grid.refresh();
    } catch (error) {
      // The server refuses an over-capacity write without a rationale, and its
      // 409 carries the verdict with the wording already formed — so the same
      // banner the modal previewed can be shown again rather than a bare error.
      const apiError = error instanceof ApiError ? error : null;
      const serverVerdict = apiError?.body?.capacity as CapacityVerdict | undefined;
      if (serverVerdict && verdictKeyForSelection) {
        // A verdict that arrived with the refusal is a *successful* check, so it
        // clears any earlier failure flag rather than inheriting it.
        setVerdict({ key: verdictKeyForSelection, verdict: serverVerdict, failed: false });
      }
      setAssignError(apiError?.detail ?? 'The assignment could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  // Live seat occupancy per rotation for the block the modal is assigning into,
  // so each rotation in the picker can show `3/3 - FULL` before it is tapped.
  //
  // The count is the same `rotation_block_occupancy` the grid cells draw, keyed
  // by rotation instead of by cell. It is deliberately the *block's* figure: the
  // picker is choosing a rotation for a block, and a per-week number would only
  // be meaningful once a window is fixed — which is the point the banner takes
  // over and shows the real week-by-week count.
  const occupancyByRotation = useMemo(() => {
    const counts = new Map<number, { occupied: number; capacity: number | null }>();
    for (const row of grid.data ?? []) {
      if (selectedBlockId === null || row.block_id !== selectedBlockId) continue;
      const rotationId = row.rotation_id;
      if (rotationId === null || rotationId === undefined) continue;
      const previous = counts.get(rotationId);
      // Several residents share a rotation in a block and each row repeats the
      // block's occupancy, so keep the highest seen rather than summing them.
      const occupied = Math.max(previous?.occupied ?? 0, row.rotation_block_occupancy ?? 0);
      counts.set(rotationId, {
        occupied,
        capacity: row.rotation_max_capacity ?? previous?.capacity ?? null,
      });
    }
    return counts;
  }, [grid.data, selectedBlockId]);

  // --- Notice dispatch derivations ----------------------------------------

  /**
   * The blocks that actually have assignments, which are the only ones worth
   * offering as a dispatch scope. A block with nothing scheduled has nothing to
   * send, and listing it would invite a coordinator to pick a dead scope.
   */
  const blocksWithAssignments = useMemo(() => {
    const ids = new Set<number>();
    for (const row of grid.data ?? []) {
      if (row.assignment_id !== null && row.assignment_id !== undefined && row.block_number) {
        ids.add(row.block_number);
      }
    }
    return BLOCK_NUMBERS.filter((number) => ids.has(number));
  }, [grid.data]);

  /**
   * The block the notice sheet acts on: the coordinator's choice when they have
   * made one, otherwise the earliest block that has anything in it. Deriving a
   * default rather than storing one means the sheet is usable the moment the
   * grid loads, and follows the data if the year changes underneath.
   */
  const noticeBlock = useMemo(() => {
    const candidate =
      noticeBlockNumber !== null && blocksWithAssignments.includes(noticeBlockNumber)
        ? noticeBlockNumber
        : blocksWithAssignments[0] ?? null;
    if (candidate === null) return null;
    return blocksByNumber.get(candidate) ?? null;
  }, [noticeBlockNumber, blocksWithAssignments, blocksByNumber]);

  const noticeBlockId = noticeBlock?.block_id ?? null;
  const noticeIsFinalized = Number(noticeBlock?.is_finalized ?? 0) === 1;

  async function handleToggleFinalized() {
    if (!noticeBlockId) return;
    setNoticeError(null);
    setFinalizing(true);
    try {
      await setBlockFinalized(noticeBlockId, !noticeIsFinalized);
      grid.refresh();
    } catch (thrown) {
      setNoticeError(thrown instanceof Error ? thrown.message : 'The block could not be updated.');
    } finally {
      setFinalizing(false);
    }
  }

  async function handleSendNotices(options: {
    sendToCoordinators: boolean;
    notifyResidents: boolean;
  }): Promise<RotationNoticeDispatchResult> {
    if (!noticeBlockId) {
      throw new Error('Choose a block with assignments before sending notices.');
    }
    const result = await sendRotationNotices({
      program_id: programId,
      block_id: noticeBlockId,
      send_to_coordinators: options.sendToCoordinators,
      notify_residents: options.notifyResidents,
    });
    // The grid is refreshed after the sheet closes rather than here: the run
    // writes letters, not assignments, so nothing on screen changes until the
    // coordinator leaves — and a refresh mid-sheet would reload the summary
    // they are still reading.
    setNoticeOutcome(describeDispatchOutcome(result));
    return result;
  }

  const gridPreview = useMemo(() => {
    const first = blockWindow(1, startDate);
    const last = blockWindow(BLOCK_NUMBERS[BLOCK_NUMBERS.length - 1], startDate);
    if (!first || !last) return null;
    return {
      blockOne: describeWindow(first.start, first.end),
      yearEnd: describeWindow(last.start, last.end),
    };
  }, [startDate]);

  const showEmptyState = grid.status === 'ready' && residents.length === 0;
  const missingBlocks = BLOCK_NUMBERS.filter((blockNumber) => !blocksByNumber.has(blockNumber));
  const hasContent = residents.length > 0 && blocksByNumber.size > 0;
  const cohortLabel = pgyFilter === 'ALL' ? 'All cohorts' : `PGY-${pgyFilter}`;

  // The export model is rebuilt from the same rows the grid renders, so the
  // downloaded file can never drift from what is on screen.
  const reportModel = useMemo(
    () =>
      buildMasterGridReport({
        rows: grid.data ?? [],
        startDate,
        viewMode,
        academicYear,
        cohortLabel,
        programLabel: session?.programLabel ?? 'Programme',
        programCode: session?.programCode ?? null,
      }),
    [grid.data, startDate, viewMode, academicYear, cohortLabel, session?.programLabel, session?.programCode],
  );

  async function handleExport(format: Parameters<typeof downloadScheduleReport>[1]) {
    const { confirmation } = await downloadScheduleReport(reportModel, format, reportRef);
    return confirmation;
  }

  return (
    <Screen onRefresh={grid.refresh} refreshing={grid.isRefreshing}>
      <AppHeader
        title="Master Rotation Grid"
        subtitle={`${formatAcademicYearForHeader(academicYear)} · ${residents.length} resident${residents.length === 1 ? '' : 's'}`}
        onBack={goBack}
      />

      <SegmentedControl
        label="Academic year"
        value={academicYear}
        onChange={handleAcademicYearChange}
        options={academicYearOptions.map((year) => ({ value: year, label: year }))}
        hint="Switch year to see that year's blocks and assignments; editing always applies to the year shown here."
      />

      <DateField
        label="Academic year start"
        value={startDate}
        onChangeText={setStartDate}
        placeholder="YYYY-MM-DD"
        durationWeeks={4}
        error={startDate && !isCalendarDate(startDate) ? 'Use YYYY-MM-DD, e.g. 2026-06-29' : null}
        hint={
          gridPreview
            ? `Block 1: ${gridPreview.blockOne}. Year ends ${gridPreview.yearEnd}. Pick any weekday — Sunday, Monday or otherwise.`
            : 'Pick the first day of Block 1 on the calendar; every block and week recalculates from it.'
        }
      />

      <SelectField
        label="PGY cohort"
        value={pgyFilter}
        onChange={setPgyFilter}
        options={PGY_OPTIONS}
        hint={
          pgyFilter === 'ALL'
            ? undefined
            : 'PGY level is applied by the server, so the grid shows one cohort.'
        }
      />

      <View style={styles.viewToggle}>
        <ChoiceGroup label="View" value={viewMode} onChange={(v) => setViewMode(v as ViewMode)} options={VIEW_OPTIONS} />
      </View>

      <Button
        label="Export & download"
        variant="secondary"
        icon={Download}
        onPress={() => setExportOpen(true)}
        disabled={!hasContent}
        accessibilityHint="Download this master rotation grid as Excel, PDF, Word or an image."
      />

      {/* Notice dispatch. The block picker, the finalize toggle and the send
          button sit together because they are one workflow in that order: pick
          the block, declare it settled, then announce it. Sending is gated on
          finalization rather than merely warned about, so a schedule still being
          edited cannot be announced to another hospital by a stray tap. */}
      {blocksWithAssignments.length > 0 ? (
        <Card>
          <View style={styles.noticeBlock}>
            <Text variant="label" uppercase tone="secondary">
              Notice letters
            </Text>

            <SheetSelectField
              label="Block"
              value={noticeBlock ? String(noticeBlock.block_number) : ''}
              onChange={(value) => setNoticeBlockNumber(Number(value))}
              placeholder="Choose a block"
              options={blocksWithAssignments.map((number) => {
                const block = blocksByNumber.get(number);
                const finalized = Number(block?.is_finalized ?? 0) === 1;
                return {
                  value: String(number),
                  label: `Block ${number}${finalized ? ' (finalized)' : ' (draft)'}`,
                };
              })}
              hint="Blocks listed here have scheduled assignments. Only a finalized block can be sent."
            />

            {noticeBlock ? (
              <View style={styles.noticeActions}>
                <StatusBadge
                  label={noticeIsFinalized ? 'Finalized' : 'Draft'}
                  tone={noticeIsFinalized ? 'success' : 'warning'}
                />
                <Text variant="bodySmall" tone="secondary">
                  {noticeIsFinalized
                    ? 'This block is settled and its notices may be sent.'
                    : 'Finalize this block before its notices can be sent.'}
                </Text>
              </View>
            ) : null}

            <Button
              label={noticeIsFinalized ? 'Return to draft' : 'Finalize block'}
              variant={noticeIsFinalized ? 'outline' : 'secondary'}
              loading={finalizing}
              disabled={!noticeBlockId || finalizing}
              onPress={() => void handleToggleFinalized()}
              accessibilityHint={
                noticeIsFinalized
                  ? 'Reopen the block for scheduling edits.'
                  : 'Declare this block settled so its notices can be sent.'
              }
            />

            <Button
              label="Send Notice Letter"
              icon={Mail}
              disabled={!noticeBlockId || !noticeIsFinalized}
              onPress={() => {
                setNoticeOutcome(null);
                setNoticeSheetOpen(true);
              }}
              accessibilityHint="Generate rotation notice letters for this block's departments and notify the residents involved."
            />

            {noticeError ? (
              <Banner tone="danger" title="Notice dispatch failed" message={noticeError} />
            ) : null}

            {noticeOutcome ? (
              <Banner tone="success" title="Notices sent" message={noticeOutcome} />
            ) : null}
          </View>
        </Card>
      ) : null}

      <ImportTools
        template="master"
        uploadLabel="Upload Master Rotation Grid"
        upload={(file) => uploadMasterGrid(file, { program_id: programId, academic_year: academicYear })}
        onImported={() => grid.refresh()}
        downloadOptions={{ startDate }}
        hint="One row per resident: Corporate ID, name, then the rotation for each block/week."
      />

      {grid.isLoading ? <SkeletonList rows={4} /> : null}

      {grid.error ? (
        <ErrorState
          title="Could not load the grid"
          message={grid.error.message}
          onRetry={grid.refresh}
        />
      ) : null}

      {showEmptyState ? (
        <Card>
          <EmptyState
            icon={CalendarX}
            title="Nothing scheduled for this year"
            message={
              pgyFilter === 'ALL'
                ? `No academic blocks or enrolled residents were found for ${academicYear}. Add a block, then assign residents to it.`
                : `No residents are enrolled at PGY-${pgyFilter} for ${academicYear}. Clear the cohort filter to see the whole programme.`
            }
            actionLabel={pgyFilter === 'ALL' ? 'Download Grid Template' : 'Show all cohorts'}
            onActionPress={pgyFilter === 'ALL' ? () => {} : () => setPgyFilter('ALL')}
          />
        </Card>
      ) : hasContent ? (
        <>
          {viewMode === 'block' ? (
            <MatrixTable
              columns={columnsBlock}
              rows={rowsBlock}
              frozenHeader="Resident"
              frozenWidth={220}
              rowHeight={58}
              autoHeight
              emptyTitle="No blocks to map"
              emptyMessage="Create an academic block to start building the rota."
            />
          ) : (
            <MatrixTable
              columns={columnsWeekly}
              rows={rowsWeekly}
              columnGroups={weeklyGroups}
              frozenHeader="Resident"
              frozenWidth={220}
              rowHeight={58}
              autoHeight
              emptyTitle="No weeks to map"
              emptyMessage="Create an academic block to start building the rota."
            />
          )}

          {missingBlocks.length > 0 ? (
        <Text variant="caption" tone="muted" style={styles.footnote}>
          Block{missingBlocks.length === 1 ? '' : 's'} {missingBlocks.join(', ')} may need block records for assignment operations.
        </Text>
      ) : null}
        </>
      ) : null}

      <ExportMenu
        visible={exportOpen}
        onClose={() => setExportOpen(false)}
        subtitle={`${formatAcademicYearForHeader(academicYear)} · ${viewMode === 'weekly' ? 'Weekly' : 'Block'} view`}
        onExport={handleExport}
      />

      {/*
        The full-width report, mounted out of sight. The JPEG/PNG export
        captures this node, not the scrollable on-screen matrix, so no columns
        are clipped.
      */}
      <View style={styles.hiddenReport} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ScheduleReportView ref={reportRef} report={reportModel} />
      </View>

      <NoticeDispatchSheet
        visible={noticeSheetOpen}
        onClose={() => {
          setNoticeSheetOpen(false);
          grid.refresh();
        }}
        programId={programId}
        scope={{ blockId: noticeBlockId ?? undefined }}
        scopeLabel={
          noticeBlock
            ? `Block ${noticeBlock.block_number} · ${academicYear}`
            : academicYear
        }
        onPreviewTemplate={() => {
          setNoticeSheetOpen(false);
          router.push('/program/(tabs)/letters');
        }}
        onConfirm={handleSendNotices}
      />

      <Sheet
        visible={assignSheetOpen}
        onClose={() => setAssignSheetOpen(false)}
        title={`Assign Rotation${selected ? ` — ${selected.residentName}` : ''}`}
        subtitle={targetWindow ? describeWindow(targetWindow.start, targetWindow.end) : undefined}
        footer={
          <Button
            label={activeVerdict?.status === 'BLOCKED' ? 'Locked — cannot assign' : 'Assign'}
            loading={saving}
            disabled={!assignRotationId || activeVerdict?.status === 'BLOCKED'}
            onPress={() => void handleAssign()}
          />
        }
      >
          {/* A searchable picker rather than a chip group: a programme has
              dozens of rotations, and a wrapping wall of chips buries the one
              being looked for. The label carries the block's live occupancy
              (`3/3 - FULL`) so a full department is visible without opening it,
              and the matching banner appears below once selected. */}
          <SheetSelectField
            label="Rotation"
            value={assignRotationId ? String(assignRotationId) : ''}
            onChange={(v) => setAssignRotationId(Number(v))}
            placeholder="Choose a rotation"
            options={(rotations.data ?? []).map((r) => {
              const live = occupancyByRotation.get(r.rotation_id);
              const full = isAtCapacity(r.max_capacity, live?.occupied);
              return {
                value: String(r.rotation_id),
                label: capacityOptionLabel(r.rotation_name, r.max_capacity, live?.occupied),
                ...(full ? { tone: 'warning' as const } : {}),
              };
            })}
            hint="Seat counts are for this block. A rotation marked FULL has no spare seats."
          />

          {/* The verdict for this rotation and window, fetched from the server so
              the banner and the enforcement cannot disagree. */}
          <CapacityBanner
            verdict={activeVerdict}
            loading={verdictLoading}
            failed={verdictFailed}
            onRetry={() => setCapacityAttempt((n) => n + 1)}
          />
          <CapacityOkNote verdict={activeVerdict} />

          {/* Exception capture appears only when the server says one is owed, so a
              within-capacity placement is never asked for a rationale it does not
              need — and a locked limit, which no rationale clears, never shows
              these fields at all. */}
          {activeVerdict?.requires_exception ? (
            <View style={styles.exceptionBlock}>
              <Text variant="label" uppercase tone="secondary">
                Exception &amp; Audit
              </Text>

              <TextField
                label="Reason for Exception"
                required
                value={exceptionReason}
                onChangeText={setExceptionReason}
                placeholder="Why this placement exceeds the departmental limit"
                multiline
                hint="Recorded against the assignment for audit."
              />

              <TextField
                label="Approving Coordinator / Department Lead"
                required
                value={exceptionApprover}
                onChangeText={setExceptionApprover}
                placeholder="Name of the person approving this exception"
                autoCapitalize="words"
              />

              <CheckboxField
                label="Faculty supervision & educational adequacy confirmed"
                checked={facultyConfirmed}
                onChange={setFacultyConfirmed}
                hint="Confirm the department can supervise every resident on this rotation in the affected weeks."
              />
            </View>
          ) : null}
          <TextField
            label="Notes (optional)"
            value={assignNotes}
            onChangeText={setAssignNotes}
            multiline
            
          />
          {assignError ? <Banner tone="danger" title="Could not assign" message={assignError} /> : null}
</Sheet>
    </Screen>
  );
}

/**
 * A key naming the rotation-and-window a capacity verdict answers.
 *
 * The verdict is fetched asynchronously, so by the time it lands the user may
 * have picked a different rotation or cell. Stamping each result with the
 * question it answers lets the reading side discard a stale one by comparison,
 * with no second render and no `setState` in an effect body.
 */
function verdictKey(rotationId: number, startDate: string, endDate: string): string {
  return `${rotationId}|${startDate}|${endDate}`;
}

/** The assignment's own start date, preferring the timezone-safe iso copy. */
function assignmentStartDate(assignment: CohortGridCell): string | null {  return assignment.assignment_start_date_iso ?? assignment.start_date ?? null;
}

/** The assignment's own end date, preferring the timezone-safe iso copy. */
function assignmentEndDate(assignment: CohortGridCell): string | null {
  return assignment.assignment_end_date_iso ?? assignment.end_date ?? null;
}

/**
 * Collapse duplicate assignments that name the same rotation.
 *
 * A manually re-assigned block can carry several identical rows (same
 * rotation, same window); the grid must not paint the same badge seven times.
 */
function dedupeAssignments(assignments: CohortGridCell[]): CohortGridCell[] {
  const seen = new Set<string>();
  const unique: CohortGridCell[] = [];
  for (const assignment of assignments) {
    const identity =
      assignment.rotation_id === null || assignment.rotation_id === undefined
        ? `c:${assignment.rotation_code ?? assignment.rotation_name}`
        : `id:${assignment.rotation_id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(assignment);
  }
  return unique;
}

/** Every 1..52 week an assignment touches, ascending. */
function weeksForAssignment(assignment: CohortGridCell, gridStart: GridStart = MASTER_GRID_START): number[] {
  const start = assignmentStartDate(assignment);
  const end = assignmentEndDate(assignment);
  if (start && end) {
    const weeks = weeksForRange(start, end, gridStart);
    if (weeks.length > 0) return weeks;
  }
  const week = getWeekNumberForAssignment(assignment, undefined, gridStart);
  return week ? [week] : [];
}

/**
 * The 1..4 sub-week slots an assignment occupies inside its block.
 *
 * Indexed from the block's own start date (week 1 = days 1-7, week 4 = days
 * 22-28); an assignment whose window spills across sub-weeks fills every slot
 * it touches, so a 4-week rotation reports B.1, B.2, B.3 and B.4 instead of a
 * single mislabelled row.
 */
function subWeekSlotsForAssignment(
  assignment: CohortGridCell,
  block: GridBlock | undefined,
  gridStart: GridStart = MASTER_GRID_START,
): number[] {
  const slots = new Set<number>();
  const startSlot = weekInBlockForDate(block?.startDateIso ?? null, assignmentStartDate(assignment));
  if (startSlot !== null) {
    slots.add(startSlot);
  } else {
    const weekNum = getWeekNumberForAssignment(assignment, undefined, gridStart);
    if (weekNum) slots.add(((weekNum - 1) % 4) + 1);
  }
  for (const week of weeksForAssignment(assignment, gridStart)) {
    const slot = ((week - 1) % 4) + 1;
    if (slot >= 1 && slot <= 4) slots.add(slot);
  }
  return [...slots].sort((left, right) => left - right);
}

/**
 * Stable, collision-free React key for a rendered assignment badge.
 *
 * A single assignment is painted once per sub-week slot it covers (block mode)
 * or once per weekly column (weekly mode), so its identity alone is not a valid
 * React key — the same `assignment_id` legitimately appears several times in one
 * cell and across residents. The key therefore folds together every axis that
 * can repeat:
 *
 *   - render location  `b<blockId>-s<slot>` (block) or `w<weekNumber>` (weekly)
 *   - the row's resident  `r<residentId>`
 *   - the assignment identity  `a<id>`, falling back to the rotation
 *   - the local array index, which disambiguates rows that share an id or fall
 *     back to the same rotation (`-i<index>`)
 *
 * Example: `badge-r1-b3-s2-a5` or `badge-r4-w14-rFM:antenatal-0`.
 */
function badgeKey(params: {
  residentId: number;
  assignment: CohortGridCell;
  blockId?: number;
  slot?: number;
  weekNumber?: number;
  index?: number;
}): string {
  const { residentId, assignment, blockId, slot, weekNumber, index } = params;
  const identity =
    assignment.assignment_id !== null && assignment.assignment_id !== undefined
      ? `a${assignment.assignment_id}`
      : `r${assignment.rotation_id ?? 0}:${assignment.rotation_code ?? assignment.rotation_name ?? 'none'}`;
  const location =
    weekNumber !== undefined ? `w${weekNumber}` : `b${blockId ?? 0}-s${slot ?? 0}`;
  const suffix = index === undefined ? '' : `-i${index}`;
  return `badge-r${residentId}-${location}-${identity}${suffix}`;
}

function assignmentBadge(assignment: CohortGridCell, label: string, key: string): React.ReactNode {
  const palette = rotationPalette(assignment.rotation_code, assignment.rotation_id);
  return (
    <View
      key={key}
      style={[styles.cellBadge, { backgroundColor: palette.surface, borderColor: palette.border }]}
      accessible
      accessibilityLabel={rotationCellDescription(
        assignment.rotation_code,
        assignment.rotation_name,
        typeof assignment.assigned_weeks === 'number' ? assignment.assigned_weeks : null,
      )}
    >
      <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.cellBadgeText, { color: palette.foreground }]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * A clinic release riding alongside the block's hospital rotation.
 *
 * Deliberately *not* a rotation badge: an approved clinic request is a weekly
 * release the resident keeps while staying on their block, so it is drawn as a
 * quieter secondary notation under the rotation rather than as a second posting.
 * Two shapes reach here — a catalogued clinic whose release was written onto its
 * own grid, and a clinic the resident typed that the programme does not run —
 * and both read the same on the cell: the clinic's short name and the weekday(s)
 * it releases.
 */
function clinicNotation(cell: CohortGridCell[] | undefined, key: string): React.ReactNode {
  const label = cell?.find((row) => row.concurrent_clinic_label)?.concurrent_clinic_label;
  if (!label) return null;

  const fromRequest = cell?.some((row) => row.clinic_source === 'CLINIC_REQUEST');
  const names = (cell?.[0]?.clinic_releases ?? [])
    .map((release) => `${release.name || release.code} (${release.days
      .map((day) => day.slice(0, 3))
      .map((day) => day.charAt(0) + day.slice(1).toLowerCase())
      .join(', ')})`)
    .join(', ');

  return (
    <View
      key={key}
      style={styles.clinicNotation}
      accessible
      accessibilityLabel={
        names
          ? `Also released for ${names}${fromRequest ? ', from an approved clinic request' : ''}`
          : `Also on a clinic release: ${label}`
      }
    >
      <Text numberOfLines={2} style={styles.clinicNotationText}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The rotation's capacity tag, drawn small under its badge.
 *
 * Shown only when the rotation declares a limit: an unlimited rotation has no
 * seat to count against, and printing "No seat limit" on every cell would bury
 * the cells where a limit actually applies. The tone reflects fullness — a full
 * department is a red tag, a partly full one is muted — so the grid is scannable
 * for the rotations that are at or near capacity.
 */
function capacityNotation(cell: CohortGridCell[] | undefined, key: string): React.ReactNode {
  const row = cell?.find((item) => item.rotation_max_capacity && item.rotation_max_capacity > 0);
  if (!row || !row.rotation_max_capacity) return null;

  const capacity = row.rotation_max_capacity;
  const occupied = row.rotation_block_occupancy ?? 0;
  const full = occupied >= capacity;
  const locked = Number(row.rotation_capacity_locked) === 1;
  const tone = locked || full ? colors.danger : colors.textSecondary;

  return (
    <View
      key={key}
      style={[styles.capacityTag, full && styles.capacityTagFull]}
      accessible
      accessibilityLabel={`${row.rotation_name ?? 'Rotation'} capacity: ${occupied} of ${capacity} seats filled${locked ? ', limit locked' : ''}`}
    >
      <Text numberOfLines={1} style={[styles.capacityTagText, { color: tone }]}>
        {`${occupied}/${capacity}${full ? ' - Full' : ''}${locked ? ' \u{1F512}' : ''}`}
      </Text>
    </View>
  );
}

function unassignedCell(onAdd: () => void): React.ReactNode {  return (
    <Pressable onPress={onAdd} style={styles.unassignedCell} accessibilityLabel="Assign rotation">
      <Plus size={14} color={colors.textMuted} />
      <Text variant="caption" tone="muted">
        + Assign
      </Text>
    </Pressable>
  );
}

function addBadge(onAdd: () => void): React.ReactNode {
  return (
    <Pressable key="add" onPress={onAdd} style={styles.addBadge} accessibilityLabel="Assign rotation">
      <Plus size={12} color={colors.textMuted} />
    </Pressable>
  );
}

/**
 * Block-mode cell: a 28-day block holds at most four weekly sub-slots.
 *
 * Every assignment is collapsed into the 1..4 sub-week slots it covers, and
 * identical rotations sharing a slot render once — never a stack of seven
 * duplicates. Only when all four slots are fully taken does the add control
 * disappear, so a coordinator can never push a fifth item into a full block.
 */
function blockCellNode(
  residentId: number,
  cell: CohortGridCell[] | undefined,
  block: GridBlock | undefined,
  gridStart: GridStart = MASTER_GRID_START,
  onAdd: () => void,
): React.ReactNode {
  const assignments = assignedRows(cell);
  if (assignments.length === 0) return unassignedCell(onAdd);

  const slots = new Map<number, CohortGridCell>();
  const unplaced: CohortGridCell[] = [];
  for (const assignment of assignments) {
    const covered = subWeekSlotsForAssignment(assignment, block, gridStart);
    if (covered.length === 0) {
      unplaced.push(assignment);
      continue;
    }
    for (const slot of covered) {
      if (!slots.has(slot)) slots.set(slot, assignment);
    }
  }

  const blockNumber = block?.block_number ?? assignments[0].block_number;
  const blockId = block?.block_id;
  const badges: React.ReactNode[] = [];
  for (let slot = 1; slot <= 4; slot += 1) {
    const assignment = slots.get(slot);
    if (!assignment) continue;
    badges.push(
      assignmentBadge(
        assignment,
        `${blockNumber}.${slot}: ${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`,
        // Slot-scoped, resident-aware key supplied by the cell iterator.
        badgeKey({ residentId, assignment, blockId, slot }),
      ),
    );
  }
  unplaced.forEach((assignment, index) => {
    badges.push(
      assignmentBadge(
        assignment,
        rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name),
        // Local index is the final fallback for rows that cannot be slotted.
        badgeKey({ residentId, assignment, blockId, index }),
      ),
    );
  });

  if (slots.size < 4) badges.push(addBadge(onAdd));

  // The clinic release is an addition to the block, not one of its four
  // sub-slots: a resident keeps their rotation and is owed a weekly session, so
  // it is rendered under the rotation badges rather than competing for a slot.
  const clinic = clinicNotation(cell, `clinic-${residentId}-${blockId ?? blockNumber}`);

  return (
    <View style={styles.cellBadges}>
      {badges}
      {clinic}
      {capacityNotation(cell, `capacity-${residentId}-${blockId ?? blockNumber}`)}
    </View>
  );
}

/**
 * Weekly-mode cell: one column is exactly one 7-day week, so the cell holds at
 * most one rotation badge. Duplicate rows for the same rotation collapse into a
 * single badge and there is never a stack of badges inside a sub-week cell.
 */
function weeklyCellNode(
  residentId: number,
  cell: CohortGridCell[] | undefined,
  weekNumber: number,
  gridStart: GridStart = MASTER_GRID_START,
  onAdd: () => void,
): React.ReactNode {
  const assignments = assignedRows(cell);
  if (assignments.length === 0) return unassignedCell(onAdd);

  const assignment = dedupeAssignments(assignments)[0];
  const window = weekWindow(weekNumber, gridStart);
  const label = window
    ? `${window.blockNumber}.${window.weekInBlock}: ${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`
    : `${weekNumber}: ${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`;
  // Week-scoped, resident-aware key supplied by the cell iterator.
  return (
    <View style={styles.cellBadges}>
      {assignmentBadge(assignment, label, badgeKey({ residentId, assignment, weekNumber }))}
      {clinicNotation(cell, `clinic-${residentId}-w${weekNumber}`)}
      {capacityNotation(cell, `capacity-${residentId}-w${weekNumber}`)}
    </View>
  );
}

function rowAccentTone(code: string | null): 'info' | 'success' | 'warning' | 'neutral' {
  switch (code) {
    case 'PGY1':
      return 'info';
    case 'PGY2':
      return 'success';
    case 'PGY3':
      return 'warning';
    default:
      return 'neutral';
  }
}

function formatAcademicYearForHeader(year: string): string {
  return year || 'No academic year';
}

function blockWindowStart(blockNumber: number, gridStart: GridStart = MASTER_GRID_START): string {
  const first = (blockNumber - 1) * 4 + 1;
  const w = weekWindow(first, gridStart);
  return w?.start ?? MASTER_GRID_START;
}

function blockWindowEnd(blockNumber: number, gridStart: GridStart = MASTER_GRID_START): string {
  const last = blockNumber * 4;
  const w = weekWindow(last, gridStart);
  return w?.end ?? MASTER_GRID_START;
}

const styles = StyleSheet.create({
  residentCell: {
    gap: 2,
  },
  residentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  viewToggle: {
    marginVertical: spacing.xs,
  },
  cellBadges: {
    gap: 4,
    flexDirection: 'column',
    flexWrap: 'nowrap',
    padding: 6,
    overflow: 'hidden',
    flex: 1,
    alignItems: 'stretch',
  },
  cellBadge: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  cellBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  /**
   * A clinic release, drawn under the rotation badge: dashed and lighter so it
   * reads as an addition to the block rather than a second posting in it.
   */
  clinicNotation: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  clinicNotationText: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  /**
   * A seat-limit tag, drawn under the clinic notation: the smallest thing in the
   * cell, because it qualifies the rotation rather than being one.
   */
  capacityTag: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 3,
    paddingVertical: 1,
  },
  capacityTagFull: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSurface,
  },
  capacityTagText: {
    fontSize: 8,
    fontWeight: '700',
  },
  addBadge: {
    paddingHorizontal: 4,
    paddingVertical: 2,
    alignItems: 'center',
  },
  unassignedCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: 2,
    borderStyle: 'dashed',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    flex: 1,
  },
  /** The exception fields, grouped so their purpose reads as one block. */
  exceptionBlock: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  /** The notice-dispatch controls, grouped as the ordered workflow they are. */
  noticeBlock: {
    gap: spacing.sm,
  },
  noticeActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  footnote: {
    marginTop: spacing.sm,
    color: colors.textMuted,
  },
  hiddenReport: {
    position: 'absolute',
    top: 0,
    left: 0,
    opacity: 0.01,
    zIndex: -1,
  },
});
