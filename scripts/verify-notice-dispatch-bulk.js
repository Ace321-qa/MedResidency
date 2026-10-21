/**
 * The master-grid notice dispatch has to send a whole block's letters in one
 * request, and it used to take longer than the client would wait.
 *
 *     node scripts/verify-notice-dispatch-bulk.js
 *
 * The cost was not the letters — it was the round trips. Each letter opened its
 * own sequence of queries to resolve the resident, the rotation, the template,
 * the officials and any existing letter, so a 37-letter block ran ~260 queries
 * and the coordinator's browser gave up before an answer came back.
 *
 * This checks the shape of the fix without touching the database: `db.query` is
 * replaced with a counter that answers from canned rows, then `prepareNoticeLetters`
 * is run for a small plan and a large one. The same number of round trips must
 * come out both times — that is the whole point of batching, and it is what the
 * per-letter loop could never do.
 *
 * It also checks the write side is the bulk shape the fix promises: one
 * multi-row INSERT for the run, one UPDATE to revoke superseded letters, no
 * statement issued inside a per-letter loop.
 */

const path = require('path');

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const db = require('../src/config/db');
const service = require('../src/services/releaseLetterService');

// --- a query counter standing in for the database ------------------------

const queries = [];
const originalQuery = db.query;

function startCounting() {
  queries.length = 0;
  db.query = async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return cannedResult(String(sql));
  };
}

function stopCounting() {
  db.query = originalQuery;
}

/**
 * Answer each batched read with a row set sized to the ids it was given, so the
 * count of round trips is what is under test rather than the count of rows.
 */
function cannedResult(sql) {
  if (/FROM residents r[\s\S]*WHERE r\.id IN/i.test(sql)) {
    const ids = [].concat(...queries[queries.length - 1].params);
    const rows = ids.map((id) => ({
      resident_id: id,
      first_name: `First${id}`,
      last_name: `Last${id}`,
      program_id: 1,
      year_in_program: 2,
      program_name: 'Family Medicine',
      specialty_name: 'Family Medicine',
      institution_name: 'City Hospital',
      corporate_id: `C${id}`,
      resident_email: `r${id}@example.test`,
      resident_mobile: null,
    }));
    return [rows, []];
  }

  if (/FROM resident_rotation_assignments rra[\s\S]*WHERE rra\.id IN/i.test(sql)) {
    const ids = [].concat(...queries[queries.length - 1].params);
    const rows = ids.map((id) => ({
      rotation_assignment_id: id,
      resident_id: id,
      start_date: '2026-11-15',
      end_date: '2026-12-12',
      notes: null,
      rotation_name: 'General Medicine',
      department_name: 'Medicine',
    }));
    return [rows, []];
  }

  if (/SELECT id, rotation_assignment_id, sent_status/i.test(sql)) {
    return [[], []];
  }

  if (/FROM release_letter_templates/i.test(sql)) {
    return [
      [
        {
          id: 7,
          template_code: 'STANDARD-ROTATION-NOTICE',
          template_name: 'Rotation Placement Notice',
          subject_line: 'Rotation Placement Notice: {{RESIDENT_NAME}}',
          letter_body: 'Dear {{HOSPITAL_DEPT}}, {{RESIDENT_NAME}} ({{PGY_LEVEL}}) joins for {{RELEASE_START_DATE}}.',
          coordinator_name: 'Programme Coordinator',
          program_director_name: 'Programme Director',
        },
      ],
      [],
    ];
  }

  return [[], []];
}

function makePlan(count) {
  const targets = [];
  for (let index = 0; index < count; index += 1) {
    const id = 1000 + index;
    targets.push({
      rotation_assignment_id: id,
      resident_id: id,
      resident_name: `First${id} Last${id}`,
      year_in_program: 2,
      rotation_id: 3,
      rotation_name: 'General Medicine',
      department_name: 'Medicine',
      block_id: 9,
      block_number: 6,
      block_name: 'Block 6',
      academic_year: '2026/2027',
      is_finalized: 1,
      start_date: '2026-11-15',
      end_date: '2026-12-12',
    });
  }
  return {
    targets,
    departments: [
      {
        department_name: 'Medicine',
        resident_count: count,
        block_numbers: [6],
        recipient_coord_email: null,
        recipient_coord_name: null,
        has_recipient: false,
      },
    ],
  };
}

async function main() {
  console.log('\n-- the preparation reads in a fixed number of round trips --');

  let smallQueries;
  let largeQueries;

  startCounting();
  await service.prepareNoticeLetters(makePlan(3), 'STANDARD-ROTATION-NOTICE', { program_id: 1 });
  smallQueries = queries.length;
  stopCounting();

  startCounting();
  const large = await service.prepareNoticeLetters(makePlan(40), 'STANDARD-ROTATION-NOTICE', {
    program_id: 1,
  });
  largeQueries = queries.length;
  stopCounting();

  console.log(`      3-letter plan: ${smallQueries} queries, 40-letter plan: ${largeQueries} queries`);

  check('a 40-letter plan resolves every letter', large.letters.length === 40);
  check(
    'a 40-letter plan costs no more queries than a 3-letter one',
    largeQueries === smallQueries,
    `3 letters -> ${smallQueries}, 40 letters -> ${largeQueries}`,
  );
  check('the whole preparation stays under ten round trips', largeQueries <= 10);
  check(
    'no query resolves a single resident by id',
    !queries.some((entry) => /WHERE r\.id = \?/i.test(entry.sql)),
  );
  check(
    'no query resolves a single rotation assignment by id',
    !queries.some((entry) => /WHERE rra\.id = \?/i.test(entry.sql)),
  );

  console.log('\n-- the write side is one bulk statement, not a loop --');

  const source = require('fs').readFileSync(
    path.join(__dirname, '../src/services/releaseLetterService.js'),
    'utf8',
  );

  const dispatch = source.slice(source.indexOf('static async dispatchRotationNotices'));
  check(
    'the letters are inserted by `insertNoticeLetters`',
    /insertNoticeLetters\(/.test(dispatch),
  );
  check('superseded letters are revoked in bulk', /revokeSupersededLetters\(/.test(dispatch));
  check(
    'the multi-row INSERT is built from joined placeholders',
    /placeholders\.join\(', '\)/.test(source),
  );
  check(
    'the insert sends every chunk as one VALUES list',
    /VALUES \$\{placeholders\.join\(/.test(source),
  );

  // The old hot spot: a `for` loop whose body awaited a query. Look for the
  // pattern anywhere in the dispatch path.
  const awaitInsideLoop = /for \([^)]*\)\s*\{[\s\S]{0,400}?await (this\.)?(composeLetter|findExistingLetter)\(/.test(
    source,
  );
  check('no per-letter await of composeLetter/findExistingLetter remains', !awaitInsideLoop);

  console.log('\n-- the resident notifications are batched too --');

  const notificationSource = require('fs').readFileSync(
    path.join(__dirname, '../src/services/notificationService.js'),
    'utf8',
  );
  check(
    'the dispatch calls the bulk notifier',
    /notifyResidentsSafe\(/.test(dispatch),
  );
  check(
    'the bulk notifier provisions every identity row in one upsert',
    /INSERT INTO users[\s\S]*?WHERE r\.id IN \(\?\)[\s\S]*?ON DUPLICATE KEY UPDATE/.test(
      notificationSource,
    ),
  );

  console.log(
    `\n${failures.length === 0 ? 'All' : failures.length + ' of'} ${
      passed + failures.length
    } bulk-dispatch checks ${failures.length === 0 ? 'passed' : 'failed'}.`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    stopCounting();
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // The pool keeps the process alive; nothing here wrote to it, so close it
    // without caring whether it was ever opened.
    try {
      const closed = db.end();
      if (closed && typeof closed.catch === 'function') closed.catch(() => {});
    } catch {
      // Already closed, or never opened.
    }
  });
