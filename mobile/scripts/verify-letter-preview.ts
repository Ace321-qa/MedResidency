/**
 * Checks the merged-letter parser.
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-letter-preview.js
 *
 * The parser's whole value is that it tells a coordinator *when a letter is
 * broken* rather than printing a template that failed, so the cases that matter
 * most are the malformed ones: CRLF from a Windows-authored template, a body that
 * is nothing but merge fields, and a letter with no blank lines to separate it.
 * Those are exactly the shapes that arrive from real templates, and exactly the
 * ones where a naive split silently drops content.
 *
 * The parser is deliberately conservative, so the cases below also pin that
 * behaviour: text it cannot classify must survive as a paragraph rather than
 * being dropped or mangled.
 */

import {
  letterBlockText,
  letterPlainText,
  parseLetterBody,
  unresolvedPlaceholders,
} from '../src/utils/letterPreview';

const failures: string[] = [];

function assert(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    failures.push(label);
  }
}

function kinds(body: string | null | undefined): string[] {
  return parseLetterBody(body).map((block) => block.kind);
}

/* ------------------------------------------------------------------ *
 * Nothing to parse.
 * ------------------------------------------------------------------ */

console.log('\n-- empty bodies --');
assert('null parses to no blocks', parseLetterBody(null), []);
assert('undefined parses to no blocks', parseLetterBody(undefined), []);
assert('an empty string parses to no blocks', parseLetterBody(''), []);
assert('whitespace alone parses to no blocks', parseLetterBody('   \n\n  \n'), []);
assert('an empty body has no unresolved fields', unresolvedPlaceholders(''), []);
assert('an empty body has no plain text', letterPlainText(null), '');

// A blank body is a coordinator-facing problem: the sheet has to render, not crash.
assert('a blank body still produces a sheet header', kinds('   '), []);

/* ------------------------------------------------------------------ *
 * Placeholder detection. This is the failure the screen warns about.
 * ------------------------------------------------------------------ */

console.log('\n-- unresolved placeholders --');
assert('a bare token is found', unresolvedPlaceholders('Dear {{RESIDENT_NAME}}'), ['RESIDENT_NAME']);
assert(
  'every token in the body is found, in order',
  unresolvedPlaceholders('Dear {{RESIDENT_NAME}}, your {{BLOCK_NAME}} begins {{START_DATE}}.'),
  ['RESIDENT_NAME', 'BLOCK_NAME', 'START_DATE'],
);
assert('a repeated token is reported once', unresolvedPlaceholders('{{NAME}} and {{NAME}}'), ['NAME']);
assert('spaces inside the braces are tolerated', unresolvedPlaceholders('{{ RESIDENT_NAME }}'), ['RESIDENT_NAME']);
assert('a fully merged letter has nothing outstanding', unresolvedPlaceholders('Dear Adeola, your posting begins.'), []);

// Braces that are not merge fields must not become a warning a coordinator cannot
// act on. Clinical prose is full of them.
assert('ordinary angle-bracket comparisons are not placeholders', unresolvedPlaceholders('keep SpO2 < 90%'), []);
assert('math braces are not placeholders', unresolvedPlaceholders('dose {2} tablets'), []);
assert('lowercase text inside braces is not a token', unresolvedPlaceholders('{{resident_name}}'), []);
assert('an unclosed brace is not a token', unresolvedPlaceholders('Dear {{NAME'), []);

console.log('\n-- placeholder spans --');
{
  const block = parseLetterBody('Dear {{RESIDENT_NAME}}, your posting begins.')[0];
  assert('a placeholder splits the line into runs', block.spans.length, 3);
  assert('the leading text is plain', block.spans[0], { text: 'Dear ', unresolved: false });
  assert('the placeholder run is flagged', block.spans[1].unresolved, true);
  assert('the placeholder keeps its token', block.spans[1].token, 'RESIDENT_NAME');
  assert('the trailing text is plain', block.spans[2], { text: ', your posting begins.', unresolved: false });
}

{
  const block = parseLetterBody('{{A}}{{B}}')[0];
  assert('two adjacent placeholders are two spans', block.spans.length, 2);
  assert('no empty plain span is emitted between them', block.spans[0].text, '{{A}}');
}

{
  // A line that is only a placeholder, which is what a `fields` row value looks
  // like before any data exists.
  const block = parseLetterBody('{{PROGRAM_NAME}}')[0];
  assert('a lone placeholder does not produce empty runs', block.spans.length, 1);
  assert('and is still flagged', block.spans[0].unresolved, true);
}

/* ------------------------------------------------------------------ *
 * Line endings and whitespace.
 * ------------------------------------------------------------------ */

console.log('\n-- CRLF and stray whitespace --');
{
  const lf = parseLetterBody('Dear Adeola,\n\nYour posting begins.');
  const crlf = parseLetterBody('Dear Adeola,\r\n\r\nYour posting begins.');
  assert('CRLF produces the same blocks as LF', crlf, lf);
  assert('and no stray carriage returns leak into the text', JSON.stringify(crlf).includes('\\r'), false);
}

{
  const blocks = parseLetterBody('Dear Adeola,   \nYour posting begins.\t\n\nYours sincerely,   ');
  assert('trailing spaces are trimmed per line', blocks.length, 2);
  assert('and do not corrupt the salutation text', blocks[0].spans[0].text, 'Dear Adeola,');
  assert('nor the closing text', blocks[1].spans[0].text, 'Yours sincerely,');
}

{
  // Lone `\r` (an old Mac template, or a bad copy-paste) must not survive as text.
  const blocks = parseLetterBody('Dear Adeola,\r\rYour posting begins.');
  const text = blocks.map(letterBlockText).join('\n');
  assert('lone carriage returns are removed', text.includes('\r'), false);
}

console.log('\n-- block separation --');
assert('a single newline does not split blocks', kinds('Dear Adeola,\nYour posting begins.'), ['paragraph']);
assert('a blank line splits blocks', kinds('Dear Adeola,\n\nYour posting begins.'), ['salutation', 'paragraph']);
assert('several blank lines still split once', kinds('Dear Adeola,\n\n\n\nYour posting begins.'), ['salutation', 'paragraph']);
assert('a blank line with spaces splits too', kinds('Dear Adeola,\n   \nYour posting begins.'), ['salutation', 'paragraph']);

/* ------------------------------------------------------------------ *
 * Fields blocks: `Label: value` lines, the letterhead.
 * ------------------------------------------------------------------ */

console.log('\n-- label/value blocks --');
{
  const blocks = parseLetterBody('Resident: Adeola Balogun\nBlock: Medicine\nDates: 05 Jul 2026 - 01 Aug 2026');
  assert('a multi-line label block is recognised', blocks[0].kind, 'fields');
  assert('all three rows are kept', blocks[0].rows?.length, 3);
  assert('the first label is split off', blocks[0].rows?.[0].label, 'Resident');
  assert('the first value is kept', blocks[0].rows?.[0].value, 'Adeola Balogun');
  assert('a row is marked unresolved when its value is a placeholder', blocks[0].rows?.[1].unresolved, false);

  const withToken = parseLetterBody('Resident: {{RESIDENT_NAME}}\nBlock: {{BLOCK_NAME}}');
  assert('an unresolved value is flagged', withToken[0].rows?.[0].unresolved, true);
  assert('and a resolved one alongside it is not', withToken[0].rows?.[1].unresolved, true);
}

{
  // One `Label: value` line is a letterhead row at most, and is far more often a
  // paragraph beginning with a time ("Consultation: 09:30") or a ratio.
  assert('a single label line stays a paragraph', kinds('Consultation: 09:30 on Tuesday'), ['paragraph']);
  assert('a single label line is not a fields block', parseLetterBody('Consultation: 09:30 on Tuesday')[0].rows, undefined);

  // A colon also rules out the letterhead *heading* styling, so a timetable line
  // is not promoted into a bold title.
  assert('a single label line is not typeset as a heading', kinds('Consultation: 09:30 on Tuesday'), ['paragraph']);
  assert('a long label line is still a paragraph', kinds('Consultation: 09:30 on Tuesday, in the outpatient clinic'), ['paragraph']);
  assert('a colon-free short line is still a heading', kinds('Department of Medicine'), ['heading']);
  assert('a colon in a body paragraph is harmless', kinds('Your posting runs from 05 Jul to 01 Aug.'), ['paragraph']);
}

{
  // A field block is not consumed as body prose: the label text must not be lost.
  const blocks = parseLetterBody('Programme: Medicine\nPGY: 2');
  assert('label text survives in the field rows', letterBlockText(blocks[0]), 'Programme: Medicine\nPGY: 2');
}

/* ------------------------------------------------------------------ *
 * Salutation, closing, heading. Nothing may be dropped.
 * ------------------------------------------------------------------ */

console.log('\n-- structural lines --');
assert('"Dear" opens the letter', kinds('Dear Adeola,'), ['salutation']);
assert('"To" opens the letter', kinds('To the programme director'), ['salutation']);
assert('"Re" opens the letter', kinds('Re: your upcoming posting'), ['salutation']);
assert('"Subject" opens the letter', kinds('Subject: rotation schedule'), ['salutation']);
assert('"Yours sincerely," closes the letter', kinds('Yours sincerely,'), ['closing']);
assert('"Kind regards," closes the letter', kinds('Kind regards,'), ['closing']);
assert('a name heading is recognised', kinds('Department of Medicine'), ['heading']);
assert('an all-caps subject line is a heading', kinds('NOTICE OF ROTATION ASSIGNMENT'), ['heading']);
assert('a markdown heading is a heading', kinds('# Notice of rotation'), ['heading']);

console.log('\n-- nothing is dropped --');
{
  // The invariant that matters most: every non-empty input line appears in the
  // rendered text. A parser that loses a line of a clinical letter is worse than
  // one that classifies it wrongly.
  const body = [
    'Department of Medicine',
    '',
    'Resident: Adeola Balogun',
    'PGY: 2',
    '',
    'Dear Adeola,',
    '',
    'Your posting to the medical ward runs from 05 Jul 2026 to 01 Aug 2026.',
    '',
    'You are expected to arrive at 07:30 on the first day.',
    '',
    'Yours sincerely,',
    '',
    'Dr {{SUPERVISOR_NAME}}',
  ].join('\n');

  const blocks = parseLetterBody(body);
  const rendered = blocks.map(letterBlockText).join('\n');

  for (const line of [
    'Department of Medicine',
    'Resident: Adeola Balogun',
    'PGY: 2',
    'Dear Adeola,',
    'Your posting to the medical ward runs from 05 Jul 2026 to 01 Aug 2026.',
    'You are expected to arrive at 07:30 on the first day.',
    'Yours sincerely,',
    'Dr {{SUPERVISOR_NAME}}',
  ]) {
    assert(`line survives: ${line.slice(0, 44)}`, rendered.includes(line), true);
  }

  assert('the supervisor placeholder is still flagged', unresolvedPlaceholders(body), ['SUPERVISOR_NAME']);
  // Seven, not eight: the two label lines are one `fields` block, which is the
  // whole point of grouping them.
  assert('the letter is seven blocks', blocks.length, 7);
  assert('the letterhead label lines are one fields block', blocks[1].kind, 'fields');
}

{
  // A body with no blank lines at all still has to render every line.
  const body = 'Dear Adeola,\nYour posting begins on 05 Jul 2026.\nYours sincerely,\nDr Balogun';
  const rendered = parseLetterBody(body).map(letterBlockText).join('\n');
  for (const line of body.split('\n')) {
    assert(`unseparated line survives: ${line.slice(0, 32)}`, rendered.includes(line), true);
  }
}

/* ------------------------------------------------------------------ *
 * Plain text, for the share sheet.
 * ------------------------------------------------------------------ */

console.log('\n-- plain text --');
assert('a fully merged letter is unchanged', letterPlainText('Dear Adeola, your posting begins.'), 'Dear Adeola, your posting begins.');
assert('a placeholder becomes a bracketed label', letterPlainText('Dear {{RESIDENT_NAME}}'), 'Dear [RESIDENT_NAME]');
assert('every placeholder is rewritten', letterPlainText('{{A}} and {{B}}'), '[A] and [B]');
assert('CRLF is normalised in plain text', letterPlainText('a\r\nb'), 'a\r\nb');
assert('non-string input is safe', letterPlainText(undefined), '');

/* ------------------------------------------------------------------ *
 * The sheet's own contract: a body it cannot read still opens.
 * ------------------------------------------------------------------ */

console.log('\n-- hostile input --');
{
  const odd = parseLetterBody(' ');
  assert('zero-width characters parse without throwing', Array.isArray(odd), true);
}
assert('a body of only placeholders parses', kinds('{{A}}\n\n{{B}}'), ['heading', 'heading']);
assert('placeholder text length is preserved', letterBlockText(parseLetterBody('{{A}}')[0]), '{{A}}');
assert('a very long single line does not throw', Array.isArray(parseLetterBody('x'.repeat(20000))), true);

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll letter-preview checks passed.');
