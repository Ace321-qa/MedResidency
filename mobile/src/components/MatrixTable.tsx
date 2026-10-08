import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
          <View style={[styles.frozenHeader, { height: HEADER_HEIGHT }]}>
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
            {columnGroups && columnGroups.length > 0 ? (
              <View style={styles.groupRow}>
                {columnGroups.map((group) => (
                  <View
                    key={group.key}
                    style={[
                      styles.groupCell,
                      {
                        width: group.columnCount * (columns[group.startColumnIndex]?.width ?? DEFAULT_COLUMN_WIDTH),
                        left: group.startColumnIndex * (columns[group.startColumnIndex]?.width ?? DEFAULT_COLUMN_WIDTH),
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
            <View style={styles.headerRow}>
              {columns.map((column) => (
                <View
                  key={column.key}
                  style={[
                    styles.headerCell,
                    { width: column.width ?? DEFAULT_COLUMN_WIDTH, minHeight: HEADER_HEIGHT / 2 },
                    column.align === 'right' ? styles.alignRight : null,
                  ]}
                >
                  <Text variant="label" numberOfLines={1}>
                    {column.title}
                  </Text>
                  {column.subtitle ? (
                    <Text variant="caption" tone="secondary" numberOfLines={1}>
                      {column.subtitle}
                    </Text>
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