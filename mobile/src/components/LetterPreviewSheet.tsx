import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share as ShareApi, StyleSheet, View } from 'react-native';
import { Download, TriangleAlert } from 'lucide-react-native';

// Imported from the modules directly rather than from `./index`: the barrel
// re-exports this component, and routing the component's own dependencies through
// it would make the barrel load itself.
import { Button } from './Button';
import { Divider } from './Card';
import { Sheet } from './Sheet';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';
import { colors, radius, spacing } from '../theme';
import { describeSave } from '../utils/fileSave';
import { formatDate, formatDateRange, formatTime, humanizeToken } from '../utils/format';
import { downloadLetterPdf } from '../utils/letterPdf';
import { letterDestinationName, letterStatusTone } from '../utils/letterStatus';
import {
  letterBlockText,
  letterPlainText,
  parseLetterBody,
  toSpans,
  unresolvedPlaceholders,
  type LetterBlock,
} from '../utils/letterPreview';
import type { ReleaseLetter } from '../types/api';

/**
 * Release letter preview, as a sheet over the profile.
 *
 * The merged body lives in `generated_release_letters.generated_letter_body`, and
 * it is a document rather than a paragraph: a subject, an addressee, a
 * salutation, body text and a signature. `parseLetterBody` recovers that
 * structure so the letter reads like a letter here.
 *
 * **Why unresolved fields are shown rather than hidden.** `mergeTemplate` leaves a
 * `{{TOKEN}}` in place when the resolver had no value for it, so a letter can be
 * generated successfully and still be incomplete. A resident reading "Dear
 * {{RESIDENT_NAME}}" needs to know the letter is not ready to sign, and the
 * coordinator needs to know which field is missing — so the tokens are highlighted
 * and listed by name rather than silently blanked or left as braces to decode.
 *
 * The sheet scrolls internally and is capped by `Sheet`, so it never grows past the
 * viewport. Sharing strips the markup and substitutes `[TOKEN]` for the
 * highlighted fields, so an incomplete letter cannot be forwarded as if complete.
 *
 * The subject line gets the same treatment as the body. It is merged from the
 * same template at generation time and re-merged on read, but a template with a
 * token nobody could fill still reaches the resident, and the subject is the
 * first thing anyone reads — so unresolved fields there are counted in the
 * warning banner and highlighted in place rather than rendered as braces.
 */

export function LetterPreviewSheet({
  letter,
  onClose,
}: {
  /** `null` closes the sheet; the profile owns which letter is selected. */
  letter: ReleaseLetter | null;
  onClose: () => void;
}) {
  const [shareError, setShareError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

  const blocks = useMemo(() => parseLetterBody(letter?.generated_letter_body), [letter?.generated_letter_body]);
  const subject = letter?.letter_subject ?? '';
  const subjectSpans = useMemo(() => toSpans(subject), [subject]);

  // The subject is checked as well as the body. It is mail-merged from the same
  // template, and a token left in the body is rarely alone — the line a
  // coordinator reads first is the one that decides whether the letter is ready.
  const unresolved = useMemo(() => {
    const found = unresolvedPlaceholders(letter?.generated_letter_body);
    for (const token of unresolvedPlaceholders(letter?.letter_subject)) {
      if (!found.includes(token)) found.push(token);
    }
    return found;
  }, [letter?.generated_letter_body, letter?.letter_subject]);

  async function handleShare() {
    if (!letter) return;

    try {
      await ShareApi.share({
        title: letterPlainText(letter.letter_subject) || `Release letter — ${letter.clinic_name ?? letter.rotation_name ?? letter.resident_name}`,
        message: `${letterPlainText(letter.letter_subject)}\n\n${letterPlainText(letter.generated_letter_body)}`,
      });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Could not share this letter.');
    }
  }

  async function handleDownload() {
    if (!letter || downloading) return;

    setDownloading(true);
    setDownloadNote(null);
    try {
      const saved = await downloadLetterPdf(letter);
      setDownloadNote(describeSave(saved));
    } catch (error) {
      setDownloadNote(error instanceof Error ? error.message : 'Could not produce the PDF.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Sheet
      visible={letter !== null}
      onClose={onClose}
      title={letter ? letterDestinationName(letter) : ''}
      subtitle={letter ? `${letter.template_name} · ${letter.template_code}` : undefined}
      footer={
        <Button
          label="Close"
          variant="outline"
          onPress={onClose}
          accessibilityHint="Dismisses the letter preview"
        />
      }
    >
      {letter ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator
        >
          {unresolved.length > 0 ? (
            <View style={styles.banner} accessibilityRole="alert">
              <TriangleAlert size={16} color={colors.warning} />
              <View style={styles.bannerText}>
                <Text variant="bodySmall" tone="warning" style={styles.bannerTitle}>
                  This letter is not finished
                </Text>
                <Text variant="caption" tone="secondary">
                  {unresolved.length} field{unresolved.length === 1 ? '' : 's'} could not be filled in:{' '}
                  {unresolved.join(', ')}. Ask your coordinator before signing.
                </Text>
              </View>
            </View>
          ) : null}

          {shareError ? (
            <Text variant="caption" tone="danger">
              {shareError}
            </Text>
          ) : null}

          <View style={styles.metaRow}>
            <StatusBadge label={humanizeToken(letter.sent_status)} tone={letterStatusTone(letter.sent_status)} />
            {letter.day_of_week ? <StatusBadge label={humanizeToken(letter.day_of_week)} tone="info" /> : null}
          </View>

          <Text
            variant="h3"
            accessibilityRole="text"
            accessibilityLabel={letter.letter_subject || 'No subject recorded'}
          >
            {subject
              ? subjectSpans.map((span, index) =>
                  span.unresolved ? (
                    <Text
                      key={`${span.token}-${index}`}
                      variant="h3"
                      style={[styles.unresolved, { backgroundColor: colors.warningSurface, color: colors.warning }]}
                    >
                      {span.token ? span.token.replace(/_/g, ' ').toLowerCase() : span.text}
                    </Text>
                  ) : (
                    <Text key={`subject-${index}`} variant="h3">
                      {span.text}
                    </Text>
                  ),
                )
              : 'No subject recorded'}
          </Text>

          <Divider />

          <View style={styles.metaList}>
            <MetaLine label="Date issued" value={formatDate(letter.letter_issue_date ?? letter.created_at)} />
            <MetaLine
              label="To"
              value={[
                letter.recipient_dept_head,
                letter.hospital_department_name,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <MetaLine
              label="Receiving programme"
              value={letter.host_program_name ?? letter.program_name ?? 'Not recorded'}
            />
            <MetaLine label="Resident" value={letter.resident_name} />
            <MetaLine
              label="From (sponsoring programme)"
              value={letter.program_name ?? letter.specialty_name ?? 'Residency program'}
            />
            {letter.institution_name ? (
              <MetaLine label="Sending institution" value={letter.institution_name} />
            ) : null}
            {letter.program_director_name ? (
              <MetaLine label="Program director" value={letter.program_director_name} />
            ) : null}
            {letter.coordinator_name ? (
              <MetaLine label="Coordinator" value={letter.coordinator_name} />
            ) : null}
            <MetaLine
              label="Release schedule"
              value={formatDateRange(letter.release_start_date, letter.release_end_date)}
            />
            {letter.day_of_week ? (
              <MetaLine
                label="Weekly slot"
                value={[humanizeToken(letter.day_of_week), letter.start_time ? formatTime(letter.start_time) : null]
                  .filter(Boolean)
                  .join(' · ')}
              />
            ) : null}
            {letter.destination_supervising_faculty ??
            letter.supervising_faculty ??
            letter.supervisor_name ? (
              <MetaLine
                label="Destination supervisor"
                value={
                  (letter.destination_supervising_faculty ??
                    letter.supervising_faculty ??
                    letter.supervisor_name) as string
                }
              />
            ) : null}
            {letter.site_name ? <MetaLine label="Site" value={letter.site_name} /> : null}
            {letter.sent_at ? <MetaLine label="Sent" value={formatDate(letter.sent_at)} /> : null}
            <MetaLine
              label="Signature"
              value={
                letter.sent_status === 'DRAFT'
                  ? 'Awaiting coordinator sign-off'
                  : letter.coordinator_name
                    ? `Signed by ${letter.coordinator_name}`
                    : 'Signed by program coordinator'
              }
            />
          </View>

          <Divider />

          {blocks.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              This letter has no body text yet. It may still be a draft.
            </Text>
          ) : (
            blocks.map((block, index) => <LetterBlockView key={`${block.kind}-${index}`} block={block} />)
          )}

          {downloadNote ? (
            <Text variant="caption" tone="secondary" style={styles.downloadNote}>
              {downloadNote}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Button
              label="Download PDF"
              icon={Download}
              onPress={handleDownload}
              loading={downloading}
              disabled={unresolved.length > 0}
              accessibilityHint={
                unresolved.length > 0
                  ? 'Unavailable until every field is filled in'
                  : 'Builds a PDF of the letter and opens the share sheet'
              }
            />
            <Button
              label="Share letter text"
              variant="outline"
              onPress={handleShare}
              accessibilityHint="Shares the letter as plain text with missing fields marked"
            />
          </View>
        </ScrollView>
      ) : null}
    </Sheet>
  );
}

/**
 * One parsed block.
 *
 * Block kinds come from the parser, so the only decisions here are typographic:
 * a heading is bold, a salutation and closing are set apart, and a `Label: value`
 * block becomes a two-column list rather than a run of colons.
 */
function LetterBlockView({ block }: { block: LetterBlock }) {
  if (block.kind === 'fields' && block.rows) {
    return (
      <View style={styles.fields}>
        {block.rows.map((row) => (
          <View key={`${row.label}-${row.value}`} style={styles.fieldRow}>
            <Text variant="caption" tone="secondary" style={styles.fieldLabel}>
              {row.label}
            </Text>
            <Text variant="bodySmall" tone={row.unresolved ? 'warning' : 'primary'}>
              {row.value}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  const variant = block.kind === 'heading' ? 'h3' : 'body';
  const tone = block.kind === 'closing' || block.kind === 'salutation' ? 'secondary' : 'primary';

  return (
    <Pressable
      onLongPress={() => undefined}
      accessibilityRole="text"
      accessibilityLabel={letterBlockText(block)}
    >
      <Text variant={variant} tone={tone} style={styles.block}>
        {block.spans.map((span, index) =>
          span.unresolved ? (
            <Text
              key={`${span.token}-${index}`}
              variant="caption"
              style={[styles.unresolved, { backgroundColor: colors.warningSurface, color: colors.warning }]}
            >
              {span.token ? span.token.replace(/_/g, ' ').toLowerCase() : letterBlockText(block)}
            </Text>
          ) : (
            <Text key={`text-${index}`} variant={variant}>
              {span.text}
            </Text>
          ),
        )}
      </Text>
    </Pressable>
  );
}

/** One `Label  Value` pair in the sheet's letterhead block. */
function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaLine}>
      <Text variant="caption" tone="muted" style={styles.metaLabel}>
        {label}
      </Text>
      <Text variant="bodySmall" style={styles.metaValue}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  scrollContent: {
    gap: spacing.xs,
    paddingBottom: spacing.md,
  },
  banner: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.warningSurface,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  bannerText: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  metaList: {
    gap: spacing.xxs,
  },
  metaLine: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  metaLabel: {
    width: 118,
  },
  metaValue: {
    flex: 1,
  },
  downloadNote: {
    marginTop: spacing.sm,
  },
  actions: {
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  block: {
    marginTop: spacing.xs,
  },
  fields: {
    gap: spacing.xxs,
    marginTop: spacing.xs,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  fieldLabel: {
    width: 96,
  },
  unresolved: {
    fontWeight: '700',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    overflow: 'hidden',
  },
});
