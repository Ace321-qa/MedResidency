/**
 * Parses a merged release-letter body into something a resident can read.
 *
 * The server mail-merges the template and stores the result in
 * `generated_release_letters.generated_letter_body`. Two properties of that
 * string make printing it raw a poor experience:
 *
 *  1. **Merge failures survive as `{{TOKEN}}`.**
 *     `ReleaseLetterService.mergeTemplate` deliberately leaves a placeholder in
 *     place when the resolver has no value for it, and reports the key in
 *     `unresolved_placeholders`. A letter that says "Dear {{RESIDENT_NAME}}" is
 *     not a letter; it is a template that failed, and the resident is the last
 *     person who should find that out. `parseLetterBody` marks those tokens
 *     instead of hiding them, so the screen can warn and the coordinator can fix
 *     the template.
 *  2. **It is a document, not a paragraph.**
 *     A letter has a subject line, a date, an addressee, salutation, body
 *     paragraphs and a signature. Rendering the whole thing as one scroll of
 *     undifferentiated text hides the structure that makes it legible.
 *
 * The parser is intentionally conservative: anything it does not recognise comes
 * through as a paragraph unchanged. Guessing at the semantics of a clinical
 * letter is worse than showing it plainly.
 */

/** A run of text, flagged when it is an unresolved merge placeholder. */
export interface LetterSpan {
  text: string;
  /** True for a `{{TOKEN}}` the server could not fill. */
  unresolved: boolean;
  /** The placeholder key, when `unresolved`. */
  token?: string;
}

export type LetterBlockKind = 'heading' | 'meta' | 'paragraph' | 'salutation' | 'closing' | 'signature' | 'fields';

export interface LetterBlock {
  kind: LetterBlockKind;
  spans: LetterSpan[];
  /** Populated for a `fields` block of `Label: value` lines. */
  rows?: { label: string; value: string; unresolved: boolean }[];
}

/** Matches a whole placeholder, tolerating spaces inside the braces. */
/**
 * A `{{TOKEN}}` the merge could not fill.
 *
 * The key is restricted to letters, digits and underscores because that is what
 * the server emits: `ReleaseLetterService.mergeTemplate` substitutes only known
 * keys and leaves the rest intact. Matching brackets or arbitrary characters here
 * would turn ordinary braces in clinical prose ("desaturation < 90%") into
 * "unresolved fields" and raise a warning the coordinator cannot act on.
 */
const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/** Every `{{TOKEN}}` still present in a merged body. */
export function unresolvedPlaceholders(body: string | null | undefined): string[] {
  const found: string[] = [];
  if (!body) return found;

  for (const match of String(body).matchAll(PLACEHOLDER)) {
    const token = match[1];
    if (token && !found.includes(token)) found.push(token);
  }
  return found;
}

/** Splits one line into plain and unresolved runs. */
export function toSpans(line: string): LetterSpan[] {
  const spans: LetterSpan[] = [];
  let cursor = 0;

  for (const match of line.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      spans.push({ text: line.slice(cursor, index), unresolved: false });
    }
    spans.push({ text: match[0], unresolved: true, token: match[1] });
    cursor = index + match[0].length;
  }

  if (cursor < line.length) {
    spans.push({ text: line.slice(cursor), unresolved: false });
  }

  return spans.length > 0 ? spans : [{ text: line, unresolved: false }];
}

/** `Label: value` on a single line, with either side possibly a placeholder. */
const FIELD_LINE = /^([A-Za-z][A-Za-z /&()'-]{1,40}):\s*(.+)$/;

/** `Dear …`, `To …`, `Re …` open the letter rather than being body text. */
const SALUTATION = /^(dear|to|re|subject|date)\b/i;

/** `Yours sincerely,` and friends close it. */
const CLOSING = /^(yours|sincerely|regards|respectfully|best|kind)\b/i;

/**
 * Splits a merged body into blocks.
 *
 * Blank lines separate blocks, which is how the templates in
 * `release_letter_templates.letter_body` are written. Lines inside a block are
 * kept together, so an address block does not become four unrelated paragraphs.
 */
export function parseLetterBody(body: string | null | undefined): LetterBlock[] {
  if (!body) return [];

  // Any bare `\r` is treated as a line break, not just the `\r\n` pair: a template
  // authored on an old-Mac editor, or one damaged by a copy-paste through a
  // rich-text field, delivers lone carriage returns. Leaving them in place puts an
  // invisible control character inside a clinical letter the resident is meant to
  // read and share.
  const normalised = String(body).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  const chunks = normalised.split(/\n{2,}/);
  const blocks: LetterBlock[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;

    const first = lines[0].trim();
    const allFields = lines.every((line) => FIELD_LINE.test(line.trim()));

    if (allFields && lines.length > 1) {
      blocks.push({
        kind: 'fields',
        spans: [],
        rows: lines.map((line) => {
          const [, label, value] = FIELD_LINE.exec(line.trim()) as RegExpExecArray;
          return { label, value, unresolved: /\{\{/.test(value) };
        }),
      });
      continue;
    }

    if (lines.length === 1) {
      if (SALUTATION.test(first)) {
        blocks.push({ kind: 'salutation', spans: toSpans(first) });
        continue;
      }
      if (CLOSING.test(first)) {
        blocks.push({ kind: 'closing', spans: toSpans(first) });
        continue;
      }
      // A short, punctuation-light first line is the institution or recipient
      // name sitting at the top of the letter.
      //
      // A colon rules it out. "Consultation: 09:30 on Tuesday" is short and has no
      // terminal punctuation, so without this it would be typeset as a bold
      // letterhead heading — a timetable line promoted to look like a title. The
      // content would survive either way; the reading would not.
      if (first.length <= 60 && !/[.!?]$/.test(first) && !first.includes(':')) {
        blocks.push({ kind: 'heading', spans: toSpans(first) });
        continue;
      }
    }

    const kind: LetterBlockKind =
      first.startsWith('#') || (first.length <= 60 && first === first.toUpperCase() && first.length > 3)
        ? 'heading'
        : 'paragraph';

    blocks.push({ kind, spans: lines.map(toSpans).flat() });
  }

  return blocks;
}

/** The plain text of a block, for copy-to-clipboard and screen readers. */
export function letterBlockText(block: LetterBlock): string {
  if (block.rows) {
    return block.rows.map((row) => `${row.label}: ${row.value}`).join('\n');
  }
  return block.spans.map((span) => span.text).join('');
}

/** The body as one plain string, with placeholders made explicit. */
export function letterPlainText(body: string | null | undefined): string {
  return (body ?? '').replace(PLACEHOLDER, (_, token: string) => `[${token}]`);
}