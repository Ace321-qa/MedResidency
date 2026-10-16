import { forwardRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';

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
  ];
}

function textStyle(entry: ReportCell, isHeader: boolean) {
  return [
    styles.cellText,
    isHeader || entry.bold ? styles.bold : null,
    entry.textColor ? { color: entry.textColor } : null,
    entry.align ? { textAlign: entry.align } : null,
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
          let columnCursor = 0;
          return (
            <View key={`row-${rowIndex}`} style={styles.row}>
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
