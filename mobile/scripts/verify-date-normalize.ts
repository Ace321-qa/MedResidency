/**
 * Checks `normalizeToISODate` — the shorthand a resident types, turned into the
 * one shape the API stores.
 *
 * The bug this guards is specific: `DateField` keeps a free-text input beside
 * the calendar picker, and a resident who types `18/10` is writing 18 October,
 * not "18 slash 10". The function fills in the current year and rewrites the
 * value as `YYYY-MM-DD`; if it got the day/month split backwards, or invented a
 * year, the wrong shift or leave day would be saved silently.
 *
 * The current-year cases read `new Date().getFullYear()` rather than the literal
 * 2026 on purpose: "the year is this one" is the contract, so the fixture has to
 * move with the clock instead of pinning a year that will be wrong next January.
 *
 * Run it with:
 *
 *     npx tsc -p tsconfig.verify.json && node .tmp/verify/mobile/scripts/verify-date-normalize.js
 */

import { normalizeToISODate } from '../src/utils/format';

const YEAR = new Date().getFullYear();

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

/* ------------------------------------------------------------------ *
 * The assertions the task calls out, verbatim.
 *
 * `18/10` has no year, so it takes `YEAR`; the other two already carry one and
 * must not be reinterpreted.
 * ------------------------------------------------------------------ */

console.log(`\n-- shorthand dates (today year ${YEAR}) --`);
assert(`18/10 (today year ${YEAR}) -> ${YEAR}-10-18`, normalizeToISODate('18/10'), `${YEAR}-10-18`);
assert('18/10/2026 -> 2026-10-18', normalizeToISODate('18/10/2026'), '2026-10-18');
assert('2026-10-18 -> 2026-10-18', normalizeToISODate('2026-10-18'), '2026-10-18');

/* ------------------------------------------------------------------ *
 * Separators and month-first input.
 * ------------------------------------------------------------------ */

console.log('\n-- separators --');
assert('18-10 infers the year', normalizeToISODate('18-10'), `${YEAR}-10-18`);
assert('18.10 infers the year', normalizeToISODate('18.10'), `${YEAR}-10-18`);
assert('18-10-2026 keeps its year', normalizeToISODate('18-10-2026'), '2026-10-18');
assert('18.10.2026 keeps its year', normalizeToISODate('18.10.2026'), '2026-10-18');

console.log('\n-- month-first input --');
assert('10/18 reads as 18 October', normalizeToISODate('10/18'), `${YEAR}-10-18`);
assert('10-18 reads as 18 October', normalizeToISODate('10-18'), `${YEAR}-10-18`);
assert('12/25 reads as 25 December', normalizeToISODate('12/25'), `${YEAR}-12-25`);

/* ------------------------------------------------------------------ *
 * Disambiguation and boundaries.
 * ------------------------------------------------------------------ */

console.log('\n-- day/month disambiguation --');
assert('a day over 12 pins the order', normalizeToISODate('13/01'), `${YEAR}-01-13`);
assert('an ambiguous pair is read day-first', normalizeToISODate('05/06'), `${YEAR}-06-05`);
assert('single digits are accepted', normalizeToISODate('1/2'), `${YEAR}-02-01`);

console.log('\n-- year handling --');
assert('a two-digit year is 20xx', normalizeToISODate('18/10/26'), '2026-10-18');
assert('a past year is preserved', normalizeToISODate('01/01/1999'), '1999-01-01');
assert('no year means the current one', normalizeToISODate('01/01'), `${YEAR}-01-01`);

console.log('\n-- impossible dates are refused --');
assert('31 February is refused', normalizeToISODate('31/02'), null);
assert('31 February is refused with a year', normalizeToISODate('31/02/2026'), null);
assert('29 February in a leap year is kept', normalizeToISODate('29/02/2024'), '2024-02-29');
assert('29 February in a common year is refused', normalizeToISODate('29/02/2026'), null);
assert('both parts over 12 is not a date', normalizeToISODate('13/13'), null);
assert('a zero day is refused', normalizeToISODate('00/10'), null);
assert('a zero month is refused', normalizeToISODate('10/00'), null);
assert('a bad month in an ISO date is refused', normalizeToISODate('2026-13-01'), null);

console.log('\n-- not dates --');
assert('empty is null', normalizeToISODate(''), null);
assert('whitespace is null', normalizeToISODate('   '), null);
assert('null is null', normalizeToISODate(null), null);
assert('undefined is null', normalizeToISODate(undefined), null);
assert('words are null', normalizeToISODate('someday'), null);
assert('a dangling separator is null', normalizeToISODate('10/'), null);
assert('three numeric parts that are not a date are null', normalizeToISODate('1/2/3/4'), null);
// These two used to sneak through the engine's own `Date` parser: the first
// became October 2001, the second 1 October 2026.
assert('an ISO month alone is null', normalizeToISODate('2026-10'), null);
assert('a spelled-out month is null', normalizeToISODate('5 Jul 2026'), null);

console.log('\n-- already-canonical values round-trip --');
assert('surrounding whitespace is trimmed', normalizeToISODate(' 2026-10-18 '), '2026-10-18');
assert('a normalised value is stable', normalizeToISODate(`${YEAR}-10-18`), `${YEAR}-10-18`);
assert('slashes still read as year-first', normalizeToISODate('2026/10/18'), '2026-10-18');
assert('dots still read as year-first', normalizeToISODate('2026.10.18'), '2026-10-18');
assert('unpadded parts are padded', normalizeToISODate('2026-1-2'), '2026-01-02');

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nAll date-normalisation checks passed.');
