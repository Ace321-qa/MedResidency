import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CalendarX } from 'lucide-react-native';
import { router } from 'expo-router';

import {
  AppHeader,
  Banner,
  Card,
  EmptyState,
  ErrorState,
  MatrixTable,
  Screen,
  SectionHeader,
  SelectField,
  SkeletonList,
  StatusBadge,
  Text,
  type MatrixColumnDef,
  type MatrixRowDef,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchCohortGrid } from '../../../services/rotations';
import { ACADEMIC_DAYS, academicDayForPgy, getAcademicYears } from '../../../utils/academicYear';
import { describeWindow } from '../../../utils/dateCalc';
import { rotationBadgeLabel, rotationCellDescription, rotationPalette } from '../../../utils/rotationBadges';
import { colors, radius, spacing } from '../../../theme';
import type { CohortGridCell } from '../../../types/api';
import { goBack } from '../../../navigation/back';

/**
 * Master Rotation Grid — every enrolled resident against every academic block.
 *
 * This screen used to assemble its own grid from three separate calls (blocks,
 * assignments, resident roster) and then filter the results in JavaScript on
 * `academic_year`. That last step was the bug: the year is stored hyphenated
 * ("2026-2027") and the picker produces a slash ("2026/2027"), so a string
 * comparison matched nothing and the grid rendered empty against a year that
 * plainly had data.
 *
 * `GET /rotations/assignments/cohort` now answers the whole question. The year
 * travels as a query parameter the server normalises, the blocks and residents
 * come back already joined, and unassigned cells arrive as real rows rather than
 * as gaps. That last property is the point of the screen: a coordinator needs to
 * see the hole, not have it silently dropped from the calendar.
 *
 * ### Layout
 *
 * Spreadsheet, not list. Thirteen block columns cannot fit a phone, so the block
 * headers scroll horizontally while the resident pane stays frozen —
 * `MatrixTable` does the split. Two consequences worth knowing:
 *
 *  - **The columns are 1-13 whether or not the block exists.** A missing block
 *    shows as an empty column headed "Not created" rather than silently
 *    disappearing, because "block 11 does not exist yet" and "nobody is in block
 *    11" are different problems for a coordinator.
 *  - **Dates come from `*_iso`, never from the raw `*_date`.** Those arrive as JS
 *    `Date` objects and shift a day for anyone west of UTC, which is how a block
 *    that ends on Saturday came to be labelled Friday.
 */

/** `'ALL'` means "do not send pgy_level at all" — an empty one would match nothing. */
type PgyFilter = 'ALL' | '1' | '2' | '3' | '4';

const PGY_OPTIONS: SelectOption<PgyFilter>[] = [
  { value: 'ALL', label: 'All' },
  { value: '1', label: 'PGY-1' },
  { value: '2', label: 'PGY-2' },
  { value: '3', label: 'PGY-3' },
  { value: '4', label: 'PGY-4' },
];

/** An academic year has thirteen blocks; the grid reserves all of them. */
const BLOCK_NUMBERS = Array.from({ length: 13 }, (_, index) => index + 1);

/** One column's worth of block metadata, keyed by `block_number`. */
interface GridBlock {
  block_id: number;
  block_number: number;
  block_name: string;
  startDateIso: string | null;
  endDateIso: string | null;
}

/** The row header: everything about a resident that does not change per block. */
interface GridResident {
  resident_id: number;
  resident_name: string;
  pgy_level: number | null;
  contact_number: string | null;
  program_code: string;
}

/** `resident_id × block_id`, because a cell may hold several assignments. */
function cellKey(residentId: number, blockId: number): string {
  return `${residentId}:${blockId}`;
}

/** The rows of one cell. A block split across rotations has more than one. */
function assignedRows(cell: CohortGridCell[] | undefined): CohortGridCell[] {
  if (!cell) return [];
  return cell.filter((row) => row.is_assigned === 1 && row.rotation_name);
}

export default function MasterGridScreen() {
  const { session } = useSession();
  const programId = session?.programId ?? 0;

  const academicYearOptions = useMemo(() => getAcademicYears(7, 3), []);
  const [academicYear, setAcademicYear] = useState(academicYearOptions[0] ?? '');
  const [pgyFilter, setPgyFilter] = useState<PgyFilter>('ALL');

  const pgyLevel = pgyFilter === 'ALL' ? undefined : Number(pgyFilter);

  // Both filters are query parameters, so changing either refetches. Filtering a
  // downloaded grid would be faster, but the grid is exactly the dataset the
  // server is built to slice — and a stale client-side filter is what hid this
  // year's data in the first place.
  const grid = useApiResource(
    () => fetchCohortGrid({ academic_year: academicYear, pgy_level: pgyLevel, program_id: programId }),
    [academicYear, pgyLevel, programId],
  );

  /**
   * Pivot the row-per-cell dataset into blocks × residents.
   *
   * Both axes come from the response itself. Nothing is matched against a year
   * string or a roster fetched elsewhere: a block is a column because a row
   * mentions it, and a resident is a row because a row mentions them.
   */
  const { blocksByNumber, residents, cellFor, unassignedCells, rotationKeys } = useMemo(() => {
    const blockMap = new Map<number, GridBlock>();
    const residentMap = new Map<number, GridResident>();
    const cellsByResidentBlock = new Map<string, CohortGridCell[]>();
    const rotationKeys = new Set<string>();
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
        rotationKeys.add(row.rotation_code ?? row.rotation_name);
      } else {
        gaps += 1;
      }
    }

    const byNumber = new Map<number, GridBlock>();
    for (const block of blockMap.values()) byNumber.set(block.block_number, block);

    // The response is ordered by block first, so a resident's first appearance
    // fixes their row order — PGY, then surname — without re-sorting names here.
    return {
      blocksByNumber: byNumber,
      residents: Array.from(residentMap.values()),
      unassignedCells: gaps,
      rotationKeys: rotationKeys,
      cellFor: (residentId: number, blockId: number): CohortGridCell[] | undefined =>
        cellsByResidentBlock.get(cellKey(residentId, blockId)),
    };
  }, [grid.data]);

  const rotationsInUse = useMemo(() => Array.from(rotationKeys).sort(), [rotationKeys]);

  const columns = useMemo<MatrixColumnDef[]>(
    () =>
      BLOCK_NUMBERS.map((blockNumber) => {
        const block = blocksByNumber.get(blockNumber);
        const window =
          block?.startDateIso && block?.endDateIso ? describeWindow(block.startDateIso, block.endDateIso) : null;

        return {
          key: block ? `block-${block.block_id}` : `block-missing-${blockNumber}`,
          title: block ? block.block_name || `Block ${blockNumber}` : `Block ${blockNumber}`,
          subtitle: block ? (window ?? 'No dates recorded') : 'Not created',
          width: 132,
        };
      }),
    [blocksByNumber],
  );

  const rows = useMemo<MatrixRowDef[]>(
    () =>
      residents.map((resident) => {
        const dayCode = academicDayForPgy(resident.pgy_level);
        const academicDay = ACADEMIC_DAYS.find((day) => day.code === dayCode);

        const cells: Record<string, ReturnType<typeof cellNode>> = {};

        for (const blockNumber of BLOCK_NUMBERS) {
          const block = blocksByNumber.get(blockNumber);
          const columnKey = block ? `block-${block.block_id}` : `block-missing-${blockNumber}`;

          if (!block) {
            cells[columnKey] = <Text variant="bodySmall" tone="disabled" align="center">n/a</Text>;
            continue;
          }

          const assignments = assignedRows(cellFor(resident.resident_id, block.block_id));
          cells[columnKey] = cellNode(assignments);
        }

        return {
          key: `resident-${resident.resident_id}`,
          accent: dayCode === 'PGY1' ? 'info' : dayCode === 'PGY2' ? 'success' : dayCode === 'PGY3' ? 'warning' : undefined,
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
            {...(pgyFilter === 'ALL'
              ? {}
              : { actionLabel: 'Show all cohorts', onActionPress: () => setPgyFilter('ALL') })}
          />
        </Card>
      ) : null}

      {unassignedCells > 0 && hasContent ? (
        <Banner
          tone="warning"
          title={`${unassignedCells} cell${unassignedCells === 1 ? '' : 's'} still need a rotation`}
          message="A blank cell is a resident with no rotation in that block."
        />
      ) : null}

      {hasContent ? (
        <>
          <SectionHeader
            title="Rotation plan"
            trailing={`${blocksByNumber.size} of 13 blocks created`}
          />

          <View style={styles.legend}>
            <Text variant="label" tone="secondary">
              Rotations
            </Text>
            <View style={styles.legendItems}>
              {rotationsInUse.length === 0 ? (
                <Text variant="caption" tone="muted">
                  No rotations assigned yet.
                </Text>
              ) : (
                rotationsInUse.map((rotation) => {
                  const sample = grid.data?.find((row) => (row.rotation_code ?? row.rotation_name) === rotation);
                  const palette = rotationPalette(sample?.rotation_code, sample?.rotation_id);
                  return (
                    <View
                      key={rotation}
                      style={[styles.legendChip, { backgroundColor: palette.surface, borderColor: palette.border }]}
                    >
                      <Text variant="caption" style={{ color: palette.foreground }}>
                        {rotationBadgeLabel(sample?.rotation_code, sample?.rotation_name)}
                      </Text>
                    </View>
                  );
                })
              )}
            </View>
          </View>

          <MatrixTable
            columns={columns}
            rows={rows}
            frozenHeader="Resident"
            frozenWidth={172}
            rowHeight={58}
            emptyTitle="No blocks to map"
            emptyMessage="Create an academic block to start building the rota."
          />

          {missingBlocks.length > 0 ? (
            <Text variant="caption" tone="muted" style={styles.footnote}>
              Block{missingBlocks.length === 1 ? '' : 's'} {missingBlocks.join(', ')} not created for this
              year — the columns are kept so the gap is visible.
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/** The badge drawn inside one block cell. */
function cellNode(assignments: CohortGridCell[]): React.ReactNode {
  if (assignments.length === 0) {
    return (
      <Text variant="caption" tone="warning" align="center">
        Unassigned
      </Text>
    );
  }

  return (
    <View style={styles.cellBadges}>
      {assignments.map((assignment, index) => {
        const palette = rotationPalette(assignment.rotation_code, assignment.rotation_id);
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
            <Text variant="caption" numberOfLines={1} style={{ color: palette.foreground }}>
              {rotationBadgeLabel(assignment.rotation_code, assignment.rotation_name)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** The accent for an academic-day badge, matching the row's left-hand bar. */
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

const styles = StyleSheet.create({
  residentCell: {
    gap: 2,
  },
  residentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  cellBadges: {
    gap: 2,
  },
  cellBadge: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  legend: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
  },
  legendItems: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  legendChip: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  footnote: {
    marginTop: spacing.sm,
    color: colors.textMuted,
  },
});