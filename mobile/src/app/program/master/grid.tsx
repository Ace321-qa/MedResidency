import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { CalendarX } from 'lucide-react-native';
import { router } from 'expo-router';

import {
  AppHeader,
  Card,
  EmptyState,
  ErrorState,
  Screen,
  SectionHeader,
  SelectField,
  SkeletonList,
  Text,
  type SelectOption,
} from '../../../components';
import { useApiResource, useSession } from '../../../hooks';
import { fetchCohortGrid } from '../../../services/rotations';
import { getAcademicYears } from '../../../utils/academicYear';
import { formatShortDate } from '../../../utils/format';
import { colors, dimensions, spacing } from '../../../theme';
import type { CohortGridCell } from '../../../types/api';

/**
 * Master Rotation Grid — every enrolled resident against every academic block.
 *
 * This screen used to assemble its own grid from three separate calls (blocks,
 * assignments, resident roster) and then filter the results in JavaScript on
 * `academic_year`. That last step was the bug: the year is stored hyphenated
 * ("2026-2027") and the picker produced a slash ("2026/2027"), so a string
 * comparison matched nothing and the grid rendered empty against a year that
 * plainly had data.
 *
 * `GET /rotations/assignments/cohort` now answers the whole question. The year
 * travels as a query parameter the server normalises, the blocks and residents
 * come back already joined, and unassigned cells arrive as real rows rather than
 * as gaps. That last property is the point of the screen: a coordinator needs to
 * see the hole, not have it silently dropped from the calendar.
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

/** One column of the grid, keyed by `block_id`. */
interface GridBlock {
  block_id: number;
  block_number: number;
  block_name: string;
  block_start_date: string;
  block_end_date: string;
}

/** One row of the grid. Insertion order is the server's: PGY, then surname. */
interface GridResident {
  resident_id: number;
  resident_name: string;
  pgy_level: number | null;
  employee_id: string | null;
  program_code: string;
}

/**
 * `resident_id × block_id` for a row, because a cell may hold several
 * assignments: a block split across two rotations is one cell with two
 * assignments, not two cells.
 */
function cellKey(residentId: number, blockId: number): string {
  return `${residentId}:${blockId}`;
}

/**
 * The rotation labels to draw in one cell.
 *
 * More than one means the block is split across rotations, which is why every
 * label is kept. An empty result is a gap to surface, not text to render, so the
 * cell draws its own dash — `is_assigned` is what distinguishes "no assignment
 * row came back" from "the row came back with nothing in it".
 */
function cellRotations(cell: CohortGridCell[] | undefined): string[] {
  if (!cell) return [];
  return cell
    .filter((row) => row.is_assigned === 1 && row.rotation_name)
    .map((row) => row.rotation_name as string);
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
   * mentions it, and a resident is a row because a row mentions them. Sorting is
   * by `block_number`, never by the academic-year text.
   */
  const { blocks, residents, unassignedCells, cellFor } = useMemo(() => {
    const blockMap = new Map<number, GridBlock>();
    const residentMap = new Map<number, GridResident>();
    const cellsByResidentBlock = new Map<string, CohortGridCell[]>();
    let gaps = 0;

    for (const row of grid.data ?? []) {
      if (!blockMap.has(row.block_id)) {
        blockMap.set(row.block_id, {
          block_id: row.block_id,
          block_number: row.block_number,
          block_name: row.block_name,
          block_start_date: row.block_start_date,
          block_end_date: row.block_end_date,
        });
      }

      let resident = residentMap.get(row.resident_id);
      if (!resident) {
        resident = {
          resident_id: row.resident_id,
          resident_name: row.resident_name,
          pgy_level: row.pgy_level,
          employee_id: row.employee_id,
          program_code: row.program_code,
        };
        residentMap.set(row.resident_id, resident);
      }

      const key = cellKey(row.resident_id, row.block_id);
      const existing = cellsByResidentBlock.get(key);
      if (existing) {
        existing.push(row);
      } else {
        cellsByResidentBlock.set(key, [row]);
      }

      if (row.is_assigned !== 1) gaps += 1;
    }

    const orderedBlocks = Array.from(blockMap.values()).sort(
      (a, b) => a.block_number - b.block_number,
    );

    // The response is ordered by block first, so a resident's first appearance
    // fixes their row order — PGY, then surname — without re-sorting names here.
    return {
      blocks: orderedBlocks,
      residents: Array.from(residentMap.values()),
      unassignedCells: gaps,
      cellFor: (residentId: number, blockId: number): CohortGridCell[] | undefined =>
        cellsByResidentBlock.get(cellKey(residentId, blockId)),
    };
  }, [grid.data]);

  const showEmptyState = grid.status === 'ready' && residents.length === 0;
  const hasContent = residents.length > 0 && blocks.length > 0;

  return (
    <Screen onRefresh={grid.refresh} refreshing={grid.isRefreshing}>
      <AppHeader
        title="Master Rotation Grid"
        subtitle="Every resident mapped onto the academic block calendar"
        onBack={() => router.back()}
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

      {hasContent ? (
        <>
          <SectionHeader
            title="Rotation plan"
            trailing={`${residents.length} resident${residents.length === 1 ? '' : 's'} · ${blocks.length} block${blocks.length === 1 ? '' : 's'}`}
          />

          {unassignedCells > 0 ? (
            <Text variant="caption" tone="warning" style={styles.gapNote}>
              {unassignedCells} resident-block cell{unassignedCells === 1 ? '' : 's'} still need a
              rotation.
            </Text>
          ) : null}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.table}
          >
            <View>
              <View style={styles.row}>
                <Text variant="label" tone="secondary" uppercase style={[styles.cell, styles.cellName, styles.headerCell]}>
                  Resident
                </Text>
                <Text variant="label" tone="secondary" uppercase style={[styles.cell, styles.cellId, styles.headerCell]}>
                  ID
                </Text>
                {blocks.map((block) => (
                  <View key={block.block_id} style={[styles.cell, styles.cellBlock, styles.headerCell]}>
                    <Text variant="label" tone="secondary" uppercase>
                      Block {block.block_number}
                    </Text>
                    <Text variant="bodySmall" tone="primary">
                      {block.block_name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {formatShortDate(block.block_start_date)}
                    </Text>
                  </View>
                ))}
              </View>

              {residents.map((resident) => (
                <View key={resident.resident_id} style={styles.row}>
                  <View style={[styles.cell, styles.cellName]}>
                    <Text variant="bodySmall">{resident.resident_name}</Text>
                    <Text variant="caption" tone="muted">
                      {resident.pgy_level ? `PGY-${resident.pgy_level}` : 'PGY not set'}
                    </Text>
                  </View>
                  <Text variant="bodySmall" style={[styles.cell, styles.cellId]}>
                    {resident.employee_id ?? resident.program_code ?? '-'}
                  </Text>
                  {blocks.map((block) => {
                    const rotations = cellRotations(cellFor(resident.resident_id, block.block_id));
                    return (
                      <View
                        key={block.block_id}
                        style={[styles.cell, styles.cellBlock, rotations.length === 0 ? styles.cellEmpty : null]}
                      >
                        {rotations.length === 0 ? (
                          <Text variant="bodySmall" tone="muted">
                            —
                          </Text>
                        ) : (
                          rotations.map((rotation) => (
                            <Text key={rotation} variant="bodySmall">
                              {rotation}
                            </Text>
                          ))
                        )}
                      </View>
                    );
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  table: {
    paddingBottom: spacing.lg,
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRightWidth: dimensions.hairline,
    borderBottomWidth: dimensions.hairline,
    borderColor: colors.border,
    justifyContent: 'center',
    gap: 2,
  },
  cellName: {
    width: 160,
  },
  cellId: {
    width: 96,
  },
  cellBlock: {
    width: 148,
  },
  cellEmpty: {
    backgroundColor: colors.warningSurface,
  },
  headerCell: {
    backgroundColor: colors.surfaceMuted,
  },
  gapNote: {
    marginBottom: spacing.sm,
  },
});
