import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CalendarX, Plus } from 'lucide-react-native';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Card,
  ChoiceGroup,
  EmptyState,
  ErrorState,
  ImportTools,
  MatrixTable,
  Screen,
  SectionHeader,
  SelectField,
  Sheet,
  
  SkeletonList,
  StatusBadge,
  Text,
  TextField,
  type MatrixColumnDef,
  type MatrixRowDef,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { createAssignment, fetchCohortGrid, fetchRotations } from '../../../services/rotations';
import { uploadMasterGrid } from '../../../services/excelTemplates';
import { ACADEMIC_DAYS, academicDayForPgy, getAcademicYears } from '../../../utils/academicYear';
import { describeWindow } from '../../../utils/dateCalc';
import { rotationBadgeLabel, rotationCellDescription, rotationPalette } from '../../../utils/rotationBadges';
import { colors, radius, spacing } from '../../../theme';
import type { CohortGridCell } from '../../../types/api';
import { goBack } from '../../../navigation/back';
import {
  weekNumberForDate,
  weekWindow,
  MASTER_GRID_START,
} from '../../../utils/masterGridCalendar';
import { buildMasterGridColumns } from '../../../utils/masterGridColumns';

type ViewMode = 'block' | 'weekly';
type PgyFilter = 'ALL' | '1' | '2' | '3' | '4';

const PGY_OPTIONS: SelectOption<PgyFilter>[] = [
  { value: 'ALL', label: 'All' },
  { value: '1', label: 'PGY-1' },
  { value: '2', label: 'PGY-2' },
  { value: '3', label: 'PGY-3' },
  { value: '4', label: 'PGY-4' },
];

const VIEW_OPTIONS: SelectOption<ViewMode>[] = [
  { value: 'block', label: 'Block' },
  { value: 'weekly', label: 'Weekly' },
];

const BLOCK_NUMBERS = Array.from({ length: 13 }, (_, index) => index + 1);

interface GridBlock {
  block_id: number;
  block_number: number;
  block_name: string;
  startDateIso: string | null;
  endDateIso: string | null;
}

interface GridResident {
  resident_id: number;
  resident_name: string;
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

function getWeekNumberForAssignment(assignment: CohortGridCell, weekNum?: number): number | null {
  if (weekNum) return weekNum;
  if (assignment.start_date) {
    const w = weekNumberForDate(assignment.start_date);
    if (w) return w;
  }
  if (assignment.end_date) {
    const w = weekNumberForDate(assignment.end_date);
    if (w) return w;
  }
  return null;
}

export default function MasterGridScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const academicYearOptions = useMemo(() => getAcademicYears(7, 3), []);
  const [academicYear, setAcademicYear] = useState(academicYearOptions[0] ?? '');
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
  const [assignNotes, setAssignNotes] = useState('');

  const pgyLevel = pgyFilter === 'ALL' ? undefined : Number(pgyFilter);

  const grid = useApiResource(
    () => fetchCohortGrid({ academic_year: academicYear, pgy_level: pgyLevel, program_id: programId }),
    [academicYear, pgyLevel, programId],
  );

  const rotations = useApiResource(() => fetchRotations(programId), [programId]);

  const { blocksByNumber, residents, cellFor, unassignedCells, rotationKeys } = useMemo(() => {
    const blockMap = new Map<number, GridBlock>();
    const residentMap = new Map<number, GridResident>();
    const cellsByResidentBlock = new Map<string, CohortGridCell[]>();
    const rotationKeysSet = new Set<string>();
    let gaps = 0;

    for (const row of grid.data ?? []) {
      if (!blockMap.has(row.block_number)) {
        blockMap.set(row.block_number, {
          block_id: row.block_id,
          block_number: row.block_number,
          block_name: row.block_name,
          startDateIso: row.block_start_date_iso,
          endDateIso: row.block_end_date_iso,
        });
      }
      if (!residentMap.has(row.resident_id)) {
        residentMap.set(row.resident_id, {
          resident_id: row.resident_id,
          resident_name: row.resident_name,
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
      if (row.is_assigned === 1 && row.rotation_name) {
        rotationKeysSet.add(row.rotation_code ?? row.rotation_name);
      } else {
        gaps += 1;
      }
    }

    const byNumber = new Map<number, GridBlock>();
    for (const block of blockMap.values()) byNumber.set(block.block_number, block);

    return {
      blocksByNumber: byNumber,
      residents: Array.from(residentMap.values()),
      unassignedCells: gaps,
      rotationKeys: rotationKeysSet,
      cellFor: (residentId: number, blockId: number): CohortGridCell[] | undefined =>
        cellsByResidentBlock.get(cellKey(residentId, blockId)),
    };
  }, [grid.data]);

  const { columns: columnsWeekly, groups: weeklyGroups } = useMemo(() => buildMasterGridColumns(), []);

  const columnsBlock = useMemo<MatrixColumnDef[]>(
    () =>
      BLOCK_NUMBERS.map((blockNumber) => {
        const block = blocksByNumber.get(blockNumber);
        const window = block?.startDateIso && block?.endDateIso ? describeWindow(block.startDateIso, block.endDateIso) : null;
          return {
            key: block ? `block-${block.block_id}` : `block-missing-${blockNumber}`,
            title: block ? block.block_name || `Block ${blockNumber}` : `Block ${blockNumber}`,
            subtitle: block ? window ?? 'No dates recorded' : window ?? 'No dates recorded',
            width: 160,
          };
      }),
    [blocksByNumber],
  );

  const rowsBlock = useMemo<MatrixRowDef[]>(
    () =>
      residents.map((resident) => {
        const dayCode = academicDayForPgy(resident.pgy_level);
        const academicDay = ACADEMIC_DAYS.find((day) => day.code === dayCode);
        const cells: Record<string, React.ReactNode> = {};

        for (const blockNumber of BLOCK_NUMBERS) {
          const block = blocksByNumber.get(blockNumber);
          const columnKey = block ? `block-${block.block_id}` : `block-missing-${blockNumber}`;
          if (!block) {
            cells[columnKey] = cellNode([], () =>
              openAssignSheet({
                residentId: resident.resident_id,
                residentName: resident.resident_name,
                blockNumber: blockNumber,
              }),
            );
            continue;
          }
          const assignments = assignedRows(cellFor(resident.resident_id, block.block_id));
          cells[columnKey] = cellNode(assignments, () =>
            openAssignSheet({
              residentId: resident.resident_id,
              residentName: resident.resident_name,
              blockId: block.block_id,
              blockNumber: block.block_number,
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
    [residents, blocksByNumber, cellFor],
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
            const w = getWeekNumberForAssignment(a);
            if (w && w >= 1 && w <= 52) {
              const list = weekToAssignments.get(w) ?? [];
              list.push(a);
              weekToAssignments.set(w, list);
            }
          }
        }

        for (let w = 1; w <= 52; w += 1) {
          const asg = weekToAssignments.get(w) ?? [];
          const win = weekWindow(w);
          cells[`week-${w}`] = cellNode(asg, () =>
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
    [residents, blocksByNumber, cellFor],
  );

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
    setAssignSheetOpen(true);
  }

  async function handleAssign() {
    if (!selected || !assignRotationId || !programId) return;
    const rotation = rotations.data?.find((r) => r.rotation_id === assignRotationId);
    const start = selected.startDate ?? (selected.blockNumber
      ? blockWindowStart(selected.blockNumber)
      : MASTER_GRID_START);
    const end = selected.endDate ?? (selected.blockNumber ? blockWindowEnd(selected.blockNumber) : null);
    try {
      await createAssignment({
        
        resident_id: selected.residentId,
        rotation_id: assignRotationId,
        rotation_block_id: selected.blockId ?? 0,
        start_date: start,
        end_date: end ?? start,
        notes: assignNotes || undefined,
        assignment_type: 'PARTIAL_BLOCK',
      });
      setAssignSheetOpen(false);
      grid.refresh();
    } catch (e) {
      // ignore; UI can show banner if needed
    }
  }

  const showEmptyState = grid.status === 'ready' && residents.length === 0;
  const missingBlocks = BLOCK_NUMBERS.filter((blockNumber) => !blocksByNumber.has(blockNumber));
  const hasContent = residents.length > 0 && blocksByNumber.size > 0;

  return (
    <Screen onRefresh={grid.refresh} refreshing={grid.isRefreshing}>
      <AppHeader
        title="Master Rotation Grid"
        subtitle={`${formatAcademicYearForHeader(academicYear)} · ${residents.length} resident${residents.length === 1 ? '' : 's'}`}
        onBack={goBack}
      />

      <SelectField
        label="Academic year"
        value={academicYear}
        onChange={setAcademicYear}
        options={academicYearOptions.map((year) => ({ value: year, label: year }))}
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

      <ImportTools
        template="master"
        uploadLabel="Upload Master Grid"
        upload={(file) => uploadMasterGrid(file, { program_id: programId, academic_year: academicYear })}
        onImported={() => grid.refresh()}
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
              frozenWidth={172}
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
              frozenWidth={172}
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

      <Sheet visible={assignSheetOpen} onClose={() => setAssignSheetOpen(false)} title={`Assign Rotation${selected ? ` — ${selected.residentName}` : ''}`}>
          <SelectField
            label="Rotation"
            value={assignRotationId ? String(assignRotationId) : ''}
            onChange={(v) => setAssignRotationId(Number(v))}
            options={(rotations.data ?? []).map((r) => ({
              value: String(r.rotation_id),
              label: r.rotation_name,
            }))}
            
          />
          <TextField
            label="Notes (optional)"
            value={assignNotes}
            onChangeText={setAssignNotes}
            multiline
            
          />
          <Pressable style={styles.assignBtn} onPress={handleAssign}>
            <Text variant="body" style={{ color: colors.surface }}>
              Assign
            </Text>
          </Pressable>
</Sheet>
    </Screen>
  );
}

function cellNode(
  assignments: CohortGridCell[],
  onAdd: () => void,
): React.ReactNode {
  if (assignments.length === 0) {
    return (
      <Pressable onPress={onAdd} style={styles.unassignedCell} accessibilityLabel="Assign rotation">
        <Plus size={14} color={colors.textMuted} />
        <Text variant="caption" tone="muted">
          + Assign
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.cellBadges}>
      {assignments.map((assignment, index) => {
        const palette = rotationPalette(assignment.rotation_code, assignment.rotation_id);
        const weekNum = getWeekNumberForAssignment(assignment);
        const blockNum = assignment.block_number ?? assignment.blockNumber;
        const weekInBlock = weekNum ? ((weekNum - 1) % 4) + 1 : null;
        let badgeLabel: string;
        if (blockNum && weekInBlock) {
          badgeLabel = `${blockNum}.${weekInBlock}: ${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`;
        } else if (weekNum) {
          badgeLabel = `${weekNum}: ${rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}`;
        } else {
          badgeLabel = rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name);
        }
        return (
          <View
            key={assignment.assignment_id ?? `${assignment.rotation_id}-${index}`}
            style={[styles.cellBadge, { backgroundColor: palette.surface, borderColor: palette.border }]}
            accessible
            accessibilityLabel={rotationCellDescription(
              assignment.rotation_code,
              assignment.rotation_name,
              typeof assignment.assigned_weeks === 'number' ? assignment.assigned_weeks : null,
            )}
          >
            <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.cellBadgeText, { color: palette.foreground }]}>
              {badgeLabel}
            </Text>
          </View>
        );
      })}
      <Pressable onPress={onAdd} style={styles.addBadge}>
        <Plus size={12} color={colors.textMuted} />
      </Pressable>
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

function blockWindowStart(blockNumber: number): string {
  const first = (blockNumber - 1) * 4 + 1;
  const w = weekWindow(first);
  return w?.start ?? MASTER_GRID_START;
}

function blockWindowEnd(blockNumber: number): string {
  const last = blockNumber * 4;
  const w = weekWindow(last);
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
  assignBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  footnote: {
    marginTop: spacing.sm,
    color: colors.textMuted,
  },
});
