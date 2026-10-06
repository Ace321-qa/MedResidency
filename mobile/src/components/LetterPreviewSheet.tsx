import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Share as ShareApi, StyleSheet, View } from 'react-native';
import { TriangleAlert } from 'lucide-react-native';

// Imported from the modules directly rather than from `./index`: the barrel
// re-exports this component, and routing the component's own dependencies through
// it would make the barrel load itself.
import { Button } from './Button';
import { Divider } from './Card';
import { Sheet } from './Sheet';
import { StatusBadge } from './StatusBadge';
import { Text } from './Text';
import { colors, radius, spacing } from '../theme';
import { formatDate, formatDateRange, humanizeToken } from '../utils/format';
import {
  letterBlockText,
  letterPlainText,
  parseLetterBody,
  toSpans,
  unresolvedPlaceholders,
  type LetterBlock,
} from '../utils/letterPreview';
import type { LetterSentStatus, ReleaseLetter } from '../types/api';

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

const LETTER_TONE = {
  DRAFT: 'neutral',
  GENERATED: 'info',
  SENT: 'info',
  ACKNOWLEDGED: 'success',
} as const satisfies Record<LetterSentStatus, 'neutral' | 'info' | 'success'>;

export function LetterPreviewSheet({
  letter,
  onClose,
}: {
  /** `null` closes the sheet; the profile owns which letter is selected. */
  letter: ReleaseLetter | null;
  onClose: () => void;
}) {
  const [shareError, setShareError] = useState<string | null>(null);

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
        title: letterPlainText(letter.letter_subject) || `Release letter — ${letter.clinic_name}`,
        message: `${letterPlainText(letter.letter_subject)}\n\n${letterPlainText(letter.generated_letter_body)}`,
      });
    } catch (error) {
      setShareError(error instanceof Error ? error.message : 'Could not share this letter.');
    }
  }

  return (
    <Sheet
      visible={letter !== null}
      onClose={onClose}
      title={letter?.clinic_name ?? ''}
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
            <StatusBadge
              label={humanizeToken(letter.sent_status)}
              tone={LETTER_TONE[letter.sent_status] ?? 'neutral'}
            />
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

          {letter.recipient_dept_head ? (
            <Text variant="caption" tone="muted">
              To: {letter.recipient_dept_head}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              No addressee recorded
            </Text>
          )}
          {letter.hospital_department_name ? (
            <Text variant="caption" tone="muted">
              {letter.hospital_department_name}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            Release window: {formatDateRange(letter.release_start_date, letter.release_end_date)}
          </Text>
          {letter.sent_at ? (
            <Text variant="caption" tone="muted">
              Sent {formatDate(letter.sent_at)}
            </Text>
          ) : null}

          <Divider />

          {blocks.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              This letter has no body text yet. It may still be a draft.
            </Text>
          ) : (
            blocks.map((block, index) => <LetterBlockView key={`${block.kind}-${index}`} block={block} />)
          )}

          <Button
            label="Share letter text"
            variant="outline"
            onPress={handleShare}
            style={styles.share}
            accessibilityHint="Shares the letter as plain text with missing fields marked"
          />
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
  share: {
    marginTop: spacing.md,
  },
});
