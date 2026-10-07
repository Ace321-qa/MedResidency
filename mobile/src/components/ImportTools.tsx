import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Download, Upload } from 'lucide-react-native';

import { Banner } from './Banner';
import { Button } from './Button';
import { Text } from './Text';
import { useInAppNotifications } from '../services/inAppNotifications';
import {
  downloadTemplate,
  pickSpreadsheet,
  type ImportOutcome,
  type TemplateKind,
} from '../services/excelTemplates';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { spacing } from '../theme';

/**
 * The two buttons every Excel flow in this app is built from, plus the banner
 * that reports what happened.
 *
 * Import is presented the same way on every screen — roster, timesheet, master
 * grid, CCC matrix — because the shape of the interaction is identical:
 * download the template, fill it in, upload it, and find out *which row* was
 * rejected. A screen that reinvents this produces its own wording for the same
 * failure, and "Row 4: Corporate ID is required" on one screen becomes
 * "invalid input" on another.
 *
 * Success and failure are both shown inline rather than only in a toast: a
 * rejected file's row list is too long to read in a toast that disappears, and
 * the coordinator needs it on screen while they fix the workbook.
 */
interface ImportToolsProps {
  /** Which workbook to download. */
  template: TemplateKind;
  /** POSTs the picked file. Returns the server's verdict. */
  upload: (file: DocumentPickerAsset) => Promise<ImportOutcome>;
  /** Called after a successful import, e.g. to refresh the list. */
  onImported?: () => void;
  downloadLabel?: string;
  uploadLabel?: string;
  /** One line under the buttons explaining the file's shape. */
  hint?: string;
  style?: object;
}

export function ImportTools({
  template,
  upload,
  onImported,
  downloadLabel = 'Download Template (.xlsx)',
  uploadLabel = 'Upload Excel',
  hint,
  style,
}: ImportToolsProps) {
  const { notify } = useInAppNotifications();
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function handleDownload() {
    setDownloading(true);
    try {
      const outcome = await downloadTemplate(template);
      notify({
        title: 'Template downloaded',
        message: `${outcome.fileName} is ready to fill in${outcome.source === 'device' ? ' (built on this device — the API was unreachable)' : ''}.`,
        tone: 'success',
      });
    } catch (error) {
      notify({
        title: 'Could not save the template',
        message: error instanceof Error ? error.message : 'The file could not be written.',
        tone: 'danger',
      });
    } finally {
      setDownloading(false);
    }
  }

  async function handleUpload() {
    setIssues(null);
    setSummary(null);

    try {
      const file = await pickSpreadsheet();
      if (!file) return;

      setUploading(true);
      const outcome = await upload(file);

      if (!outcome.success) {
        setIssues(outcome.issues);
        notify({ title: 'Import rejected', message: outcome.issues[0], tone: 'danger' });
        return;
      }

      setSummary(outcome.summary ?? 'Import complete.');
      notify({ title: 'Import complete', message: outcome.summary, tone: 'success' });
      onImported?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The file could not be read.';
      setIssues([message]);
      notify({ title: 'Import failed', message, tone: 'danger' });
    } finally {
      setUploading(false);
    }
  }

  return (
    <View style={[styles.wrap, style]}>
      {issues && issues.length > 0 ? (
        <Banner
          tone="danger"
          title={`Import rejected — ${issues.length} problem${issues.length === 1 ? '' : 's'}`}
          message={issues.slice(0, 8).join('\n')}
          onDismiss={() => setIssues(null)}
        />
      ) : null}

      {summary ? (
        <Banner tone="success" title="Import complete" message={summary} onDismiss={() => setSummary(null)} />
      ) : null}

      <View style={styles.buttons}>
        <Button
          label={downloadLabel}
          variant="outline"
          icon={Download}
          loading={downloading}
          onPress={() => void handleDownload()}
          style={styles.button}
        />
        <Button
          label={uploadLabel}
          icon={Upload}
          loading={uploading}
          onPress={() => void handleUpload()}
          style={styles.button}
        />
      </View>

      {hint ? (
        <Text variant="caption" tone="muted" style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.lg,
  },
  buttons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  hint: {
    marginTop: spacing.xs,
  },
  button: {
    flex: 1,
  },
});
