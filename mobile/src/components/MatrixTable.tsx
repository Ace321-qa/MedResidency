import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type TextStyle } from 'react-native';

import { colors, radius, spacing, type Tone } from '../theme';
import { Text } from './Text';

/**
 * MatrixTable — the Excel-style grid both scheduling views are built from.
 *
 * A cohort rota is inherently two-dimensional and wider than a phone, so the two
 * obvious approaches both fail on a small screen:
 *
 *  - **One horizontal scroller for the whole table** scrolls the row headers off
 *    to the left, and after a few columns nobody knows which resident a row is.
 *  - **One vertical scroller per cell** loses the row/column alignment that makes
 *    a matrix readable in the first place.
 *
 * This splits the table the way a spreadsheet does. The row headers live in a
 * fixed-width pane outside the horizontal scroller and therefore never move; the
 * columns scroll behind them. Both panes are children of a *single* vertical
 * `ScrollView`, so their rows stay aligned without any scroll-position
 * bookkeeping — the thing that usually breaks in this pattern.
 *
 * Alignment relies on one more thing: **every row is `rowHeight` tall**, on both
 * panes. Fixed heights mean no measurement, no `onLayout` bookkeeping, and no
 * drift after a screen rotation.
 *
 * The header is the one place with variable height, and it is variable by
 * design: `columnGroups` adds a **tier 1** row (`Block 1` merged over four
 * sub-weeks) above the normal **tier 2** row, and `verticalSubtitle` rotates a
 * column's subtitle top-to-bottom so a date window like `28/06–04/07` fits a
 * narrow sub-column instead of being clipped. The frozen pane's header is
 * always the *sum* of the tiers the scrolling pane draws, so the first data row
 * starts at the same y on both panes whatever the header is made of.
 */

export interface ColumnGroup {
  key: string;
  label: string;
  startColumnIndex: number;
  columnCount: number;
}

export interface MatrixColumnDef {
  key: string;
  /** Bold first line, e.g. "Block 3". */
  title: string;
  /** Second line, e.g. "Sun 05 Jul - Sat 01 Aug 2026". */
  subtitle?: string;
  /**
   * Draw the subtitle rotated (top-to-bottom) so a long string — a sub-week
   * date window — fits a narrow column without being ellipsised. Columns that
   * ask for it grow the header row to `VERTICAL_HEADER_HEIGHT`.
   */
  verticalSubtitle?: boolean;
  /** Wider for a date window than for a single slot number. */
  width?: number;
  align?: 'left' | 'center' | 'right';
  pinned?: boolean;
}

export interface MatrixRowDef {
  key: string;
  /**
   * Cells keyed by column key. A missing key renders as an em dash rather than
   * collapsing the column, so a resident with no data in one block does not
   * narrow the grid.
   */
  cells: Record<string, ReactNode>;
  /**
   * The frozen row header's own content.
   *
   * Presentation, not data: which screen owns the left pane is the screen's
   * choice, so the row supplies the node and the table decides where it goes.
   */
  frozenContent?: ReactNode;
  /** Tints the frozen row header, e.g. a PGY or rotation badge. */
  accent?: Tone;
  /** Makes the whole row pressable, e.g. to open a resident. */
  onPress?: () => void;
  accessibilityLabel?: string;
}

export interface MatrixTableProps {
  columns: MatrixColumnDef[];
  rows: MatrixRowDef[];
  /** Width of the frozen row-header pane. */
  frozenWidth?: number;
  /** Uniform row height shared by both panes. Text beyond it is clipped. */
  rowHeight?: number;
  /** Header text for the frozen pane's own column. */
  frozenHeader?: string;
  emptyTitle?: string;
  emptyMessage?: string;
  /** Rendered above the table, inside the scroll area. */
  caption?: ReactNode;
  /** Optional two-tier header groups (e.g. Block 1 over weeks 1-4) */
  columnGroups?: ColumnGroup[];
}

const DEFAULT_FROZEN_WIDTH = 168;
const DEFAULT_ROW_HEIGHT = 44;
const DEFAULT_COLUMN_WIDTH = 116;

export function MatrixTable({
  columns,
  rows,
  frozenWidth = DEFAULT_FROZEN_WIDTH,
  rowHeight = DEFAULT_ROW_HEIGHT,
  frozenHeader = '',
  emptyTitle = 'Nothing to show yet',
  emptyMessage,
  caption,
  columnGroups,
}: MatrixTableProps) {
  if (columns.length === 0 || rows.length === 0) {
    return (
      <View style={styles.empty}>
        <Text variant="h3" align="center">
          {emptyTitle}
        </Text>
        {emptyMessage ? (
          <Text variant="bodySmall" tone="secondary" align="center">
            {emptyMessage}
          </Text>
        ) : null}
      </View>
    );
  }

  // Header geometry: the tiers the scrolling pane draws are exactly what the
  // frozen pane's header must span, or the two panes' rows drift apart.
  const hasGroups = (columnGroups?.length ?? 0) > 0;
  const hasVerticalSubtitles = columns.some((column) => column.verticalSubtitle && column.subtitle);
  const headerHeight = hasVerticalSubtitles ? VERTICAL_HEADER_HEIGHT : HEADER_HEIGHT;
  const frozenHeaderHeight = (hasGroups ? GROUP_HEADER_HEIGHT : 0) + headerHeight;

  return (
    <ScrollView
      style={styles.viewport}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator
      accessibilityLabel="Scheduling matrix"
    >
      {caption}

      {/* One vertical scroller wraps both panes, which is what keeps the frozen
          row headers level with the columns as the user scrolls down. */}
      <View style={styles.table}>
        <View style={[styles.frozenPane, { width: frozenWidth }]}>
          <View style={[styles.frozenHeader, { height: frozenHeaderHeight }]}>
            <Text variant="label" tone="secondary" numberOfLines={2}>
              {frozenHeader}
            </Text>
          </View>
          {rows.map((row) => (
            <Pressable
              key={row.key}
              onPress={row.onPress}
              disabled={!row.onPress}
              accessibilityRole={row.onPress ? 'button' : 'text'}
              accessibilityLabel={row.accessibilityLabel}
              style={[styles.frozenCell, { height: rowHeight }]}
            >
              {row.accent ? <View style={[styles.accentBar, { backgroundColor: accentColors[row.accent] }]} /> : null}
              {row.frozenContent ?? null}
            </Pressable>
          ))}
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scroller}>
          <View>
            {hasGroups ? (
              <View style={[styles.groupRow, { height: GROUP_HEADER_HEIGHT }]}>
                {columnGroups!.map((group) => (
                  <View
                    key={group.key}
                    style={[
                      styles.groupCell,
                      {
                        width: columnsWidth(columns, group.startColumnIndex, group.columnCount),
                        left: columnsWidth(columns, 0, group.startColumnIndex),
                      },
                    ]}
                  >
                    <Text variant="label" numberOfLines={1} align="center">
                      {group.label}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
            <View style={[styles.headerRow, { height: headerHeight }]}>
              {columns.map((column) => (
                <View
                  key={column.key}
                  style={[
                    styles.headerCell,
                    { width: column.width ?? DEFAULT_COLUMN_WIDTH },
                    column.align === 'right' ? styles.alignRight : null,
                    column.verticalSubtitle && column.subtitle ? styles.verticalHeaderCell : null,
                  ]}
                >
                  <Text variant="label" numberOfLines={1}>
                    {column.title}
                  </Text>
                  {column.subtitle ? (
                    column.verticalSubtitle ? (
                      <Text variant="caption" tone="secondary" numberOfLines={1} style={verticalDateStyle}>
                        {column.subtitle}
                      </Text>
                    ) : (
                      <Text variant="caption" tone="secondary" numberOfLines={1}>
                        {column.subtitle}
                      </Text>
                    )
                  ) : null}
                </View>
              ))}
            </View>

            {rows.map((row) => (
              <View key={row.key} style={[styles.row, { height: rowHeight }]}>
                {columns.map((column) => (
                  <View
                    key={column.key}
                    style={[
                      styles.cell,
                      { width: column.width ?? DEFAULT_COLUMN_WIDTH },
                      column.align === 'right' ? styles.alignRight : null,
                    ]}
                  >
                    {row.cells[column.key] ?? <Text variant="bodySmall" tone="disabled" align="center">—</Text>}
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </ScrollView>
  );
}

const HEADER_HEIGHT = 56;
/** Tier 1 of a two-tier header: the merged `Block N` bar over its sub-weeks. */
const GROUP_HEADER_HEIGHT = 28;
/**
 * Header height for columns whose subtitle is rotated top-to-bottom, e.g. the
 * weekly sub-columns' `28/06–04/07`. The rotated run itself needs ~70px of
 * vertical space plus the sub-week label above it, so the row grows past
 * `HEADER_HEIGHT` instead of clipping the date.
 */
const VERTICAL_HEADER_HEIGHT = 116;
/** Minimum height of a cell carrying a rotated date, so the run never overflows. */
const VERTICAL_DATE_MIN_HEIGHT = 110;

/** Total pixel width of `count` columns starting at `startIndex`. */
function columnsWidth(columns: MatrixColumnDef[], startIndex: number, count: number): number {
  let width = 0;
  for (let index = startIndex; index < startIndex + count; index += 1) {
    width += columns[index]?.width ?? DEFAULT_COLUMN_WIDTH;
  }
  return width;
}

/**
 * The CSS that turns `28/06–04/07` into a top-to-bottom run inside a column
 * that is far too narrow to hold it horizontally.
 *
 * `writingMode: 'vertical-rl'` stacks the glyphs down the column and
 * `rotate(180deg)` flips the run so it reads downward rather than upward —
 * the "rotate top down" orientation spreadsheet headers use. `whiteSpace` and
 * `writingMode` are web-style names React Native's `TextStyle` does not
 * declare, but react-native-web forwards them to the DOM verbatim, which is
 * exactly where they are needed; the cast keeps TypeScript out of that
 * arrangement.
 */
const verticalDateStyle = {
  writingMode: 'vertical-rl',
  transform: [{ rotate: '180deg' }],
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  fontSize: 10,
  fontWeight: '600',
  paddingVertical: 6,
  alignSelf: 'center',
} as TextStyle;

const accentColors: Record<Tone, string> = {
  neutral: colors.textMuted,
  info: colors.info,
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
};

const styles = StyleSheet.create({
  viewport: {
    flex: 1,
  },
  content: {
    paddingBottom: spacing.xl,
  },
  table: {
    flexDirection: 'row',
  },
  scroller: {
    paddingRight: spacing.lg,
  },
  frozenPane: {
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.surface,
  },
  frozenHeader: {
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surfaceMuted,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  frozenCell: {
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    overflow: 'hidden',
  },
  accentBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
  },
  groupRow: {
    flexDirection: 'row',
    position: 'relative',
    backgroundColor: colors.surfaceMuted,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  groupCell: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  headerCell: {
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  verticalHeaderCell: {
    minHeight: VERTICAL_DATE_MIN_HEIGHT,
    alignItems: 'center',
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
  },
  cell: {
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  alignRight: {
    alignItems: 'flex-end',
  },
  empty: {
    paddingVertical: spacing.giant,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});