import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FileSpreadsheet, FileText, FileType2, Image as ImageIcon, type LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing } from '../theme';
import type { ExportFormat } from '../utils/fileSave';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';

/**
 * The export chooser.
 *
 * A sheet of one-line options rather than a toolbar of icons: exporting a
 * schedule is deliberate, and each format needs a sentence explaining what it
 * is for (a spreadsheet to edit, a PDF to print, Word to annotate). The actual
 * work is injected as `onExport`, so the menu stays unaware of renderers and
 * works for both the master grid and the CCC matrix.
 */

interface FormatMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

const FORMAT_META: Record<ExportFormat, FormatMeta> = {
  xlsx: {
    label: 'Excel workbook (.xlsx)',
    description: 'Colour-coded cells, frozen headers — best for editing.',
    icon: FileSpreadsheet,
  },
  pdf: {
    label: 'PDF document (.pdf)',
    description: 'Print-ready, page numbers, fits the whole grid.',
    icon: FileText,
  },
  docx: {
    label: 'Word document (.docx)',
    description: 'An editable table with room to annotate.',
    icon: FileType2,
  },
  jpg: {
    label: 'Image (.jpg)',
    description: 'Paste into an email or chat.',
    icon: ImageIcon,
  },
  png: {
    label: 'Image (.png)',
    description: 'Lossless image for slides.',
    icon: ImageIcon,
  },
};

const DEFAULT_FORMATS: ExportFormat[] = ['xlsx', 'pdf', 'docx', 'jpg'];

interface ExportMenuProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  formats?: ExportFormat[];
  /** Produce and save the file; resolve with the confirmation to show. */
  onExport: (format: ExportFormat) => Promise<string>;
}

export function ExportMenu({
  visible,
  onClose,
  title = 'Export schedule',
  subtitle,
  formats = DEFAULT_FORMATS,
  onExport,
}: ExportMenuProps) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  async function handlePress(format: ExportFormat) {
    if (busy) return;
    setBusy(format);
    setMessage(null);
    try {
      const confirmation = await onExport(format);
      setMessage({ tone: 'success', text: confirmation });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The file could not be generated.';
      setMessage({ tone: 'error', text });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {message ? (
        <View style={[styles.banner, message.tone === 'success' ? styles.bannerSuccess : styles.bannerError]}>
          <Text variant="bodySmall" tone={message.tone === 'success' ? 'primary' : 'danger'}>
            {message.text}
          </Text>
        </View>
      ) : null}

      {formats.map((format) => {
        const meta = FORMAT_META[format];
        return (
          <View key={format} style={styles.option}>
            <Button
              label={meta.label}
              variant="outline"
              icon={meta.icon}
              loading={busy === format}
              disabled={busy !== null && busy !== format}
              onPress={() => handlePress(format)}
            />
            <Text variant="caption" tone="muted" style={styles.description}>
              {meta.description}
            </Text>
          </View>
        );
      })}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  bannerSuccess: {
    backgroundColor: colors.successSurface,
  },
  bannerError: {
    backgroundColor: colors.dangerSurface,
  },
  option: {
    marginBottom: spacing.md,
  },
  description: {
    marginTop: spacing.xxs,
  },
});
