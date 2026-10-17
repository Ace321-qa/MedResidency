import { forwardRef } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';

import { colors, spacing } from '../theme';
import type { ReportCell, ReportModel } from '../utils/scheduleExport';

/**
 * An offscreen, full-width rendering of a schedule report.
 *
 * The JPEG/PNG export is a picture of *this*, not of the on-screen matrix: the
 * matrix scrolls horizontally, so capturing it would clip every column past the
 * viewport. This view lays the whole grid out at its natural width, and the
 * screen mounts it out of sight behind the export menu. `collapsable={false}`
 * keeps the native view in the hierarchy so `captureRef` can find it.
 */

interface ScheduleReportViewProps {
  report: ReportModel;
}

const DEFAULT_COLUMN_WIDTH = 120;

/**
 * Minimum height of a header row that carries a rotated date, e.g. the weekly
 * sub-columns' `28/06–04/07`. The run is ~70px long plus the sub-week code
 * above it; without the extra height the capture clips the date. Settling the
 * row higher before `captureRef` runs is what keeps the whole range in the
 * exported image.
 */
const VERTICAL_HEADER_MIN_HEIGHT = 110;

/**
 * Turn a date header into a top-to-bottom run inside a column too narrow to hold
 * it horizontally. `writingMode` and `whiteSpace` are web-style names React
 * Native's `TextStyle` does not declare, but react-native-web forwards them to
 * the DOM verbatim — which is exactly where the raster capture needs them. The
 * cast keeps TypeScript out of that arrangement, and mirrors the on-screen
 * matrix's `verticalDateStyle`.
 */
const verticalTextStyle = {
  writingMode: 'vertical-rl',
  transform: [{ rotate: '180deg' }],
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  fontSize: 10,
  fontWeight: '600',
  paddingVertical: 6,
  alignSelf: 'center',
} as TextStyle;

function columnWidths(report: ReportModel): number[] {
  return report.columns.map((column) => column.width ?? DEFAULT_COLUMN_WIDTH);
}

function spannedWidth(widths: number[], start: number, span: number): number {
  let total = 0;
  for (let offset = 0; offset < span; offset += 1) {
    total += widths[start + offset] ?? DEFAULT_COLUMN_WIDTH;
  }
  return total;
}

function cellStyle(entry: ReportCell, width: number) {
  return [
    styles.cell,
    { width, backgroundColor: entry.fill ?? 'transparent' },
    entry.textColor ? { borderColor: colors.borderStrong } : null,
    entry.vertical ? styles.verticalCell : null,
  ];
}

function textStyle(entry: ReportCell, isHeader: boolean) {
  return [
    styles.cellText,
    isHeader || entry.bold ? styles.bold : null,
    entry.textColor ? { color: entry.textColor } : null,
    entry.align ? { textAlign: entry.align } : null,
    entry.vertical ? verticalTextStyle : null,
  ];
}

export const ScheduleReportView = forwardRef<View, ScheduleReportViewProps>(function ScheduleReportView(
  { report },
  ref,
) {
  const widths = columnWidths(report);
  const totalWidth = widths.reduce((sum, width) => sum + width, 0) + spacing.lg * 2;

  return (
    <View ref={ref} collapsable={false} style={[styles.root, { width: totalWidth }]}>
      <View style={styles.headerBand}>
        <Text style={styles.brand}>MEDRESIDENCY</Text>
        <Text style={styles.title}>{report.title}</Text>
        {report.subtitle ? <Text style={styles.subtitle}>{report.subtitle}</Text> : null}
        {report.meta.length > 0 ? (
          <View style={styles.metaWrap}>
            {report.meta.map((line) => (
              <Text key={line.label} style={styles.metaLine}>
                <Text style={styles.metaLabel}>{line.label}: </Text>
                {line.value}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.table}>
        {report.rows.map((row, rowIndex) => {
          const isHeader = rowIndex < report.headerRows;
          const hasVerticalDate = isHeader && row.some((entry) => entry.vertical);
          let columnCursor = 0;
          return (
            <View
              key={`row-${rowIndex}`}
              style={[styles.row, hasVerticalDate ? styles.verticalHeaderRow : null]}
            >
              {row.map((entry, cellIndex) => {
                const span = entry.colSpan && entry.colSpan > 1 ? entry.colSpan : 1;
                const width = spannedWidth(widths, columnCursor, span);
                const node = (
                  <View key={`cell-${rowIndex}-${cellIndex}`} style={cellStyle(entry, width)}>
                    <Text style={textStyle(entry, isHeader)}>{entry.text}</Text>
                  </View>
                );
                columnCursor += span;
                return node;
              })}
            </View>
          );
        })}
      </View>

      {report.legend && report.legend.length > 0 ? (
        <View style={styles.legend}>
          {report.legend.map((entry) => (
            <View key={entry.label} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: entry.color }]} />
              <Text style={styles.legendLabel}>{entry.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  headerBand: {
    borderBottomWidth: 3,
    borderBottomColor: colors.primaryDark,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
  },
  brand: {
    color: colors.primary,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    marginTop: 2,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  metaWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  metaLine: {
    color: colors.textPrimary,
    fontSize: 11,
    fontWeight: '600',
  },
  metaLabel: {
    color: colors.textMuted,
    fontWeight: '400',
  },
  table: {
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderColor: colors.borderStrong,
  },
  row: {
    flexDirection: 'row',
  },
  verticalHeaderRow: {
    minHeight: VERTICAL_HEADER_MIN_HEIGHT,
    alignItems: 'stretch',
  },
  verticalCell: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  cell: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: 4,
    paddingVertical: 3,
  },
  cellText: {
    color: colors.textPrimary,
    fontSize: 10,
  },
  bold: {
    fontWeight: '700',
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  swatch: {
    width: 10,
    height: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  legendLabel: {
    color: colors.textSecondary,
    fontSize: 10,
  },
});
