const XLSX = require('xlsx');

function generateRosterTemplate() {
  const headers = [
    'First Name',
    'Middle Name',
    'Last Name',
    'Corporate/Employee ID',
    'PGY Level',
    'Email',
    'Mobile Number',
    'Training Site',
    'Start Date',
    'Expected Completion Date',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, []]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Roster');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return buf;
}

function parseRosterFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No sheet found in file');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'YYYY-MM-DD' }).filter(r => r && r.length > 0);
  if (rows.length < 2) throw new Error('File must contain header + at least one data row');
  const headers = rows[0].map(h => String(h || '').trim());
  const idx = {
    firstName: headers.indexOf('First Name'),
    middleName: headers.indexOf('Middle Name'),
    lastName: headers.indexOf('Last Name'),
    corpId: headers.indexOf('Corporate/Employee ID'),
    pgy: headers.indexOf('PGY Level'),
    email: headers.indexOf('Email'),
    mobile: headers.indexOf('Mobile Number'),
    site: headers.indexOf('Training Site'),
    start: headers.indexOf('Start Date'),
    end: headers.indexOf('Expected Completion Date'),
  };
  const required = ['firstName', 'lastName', 'corpId', 'pgy', 'start', 'end'];
  for (let k of required) {
    if (idx[k] < 0) throw new Error(`Missing required column: ${k}`);
  }
  const data = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    data.push({
      row: i + 1,
      first_name: r[idx.firstName] || '',
      middle_name: idx.middleName >= 0 ? (r[idx.middleName] || null) : null,
      last_name: r[idx.lastName] || '',
      corporate_id: String(r[idx.corpId] || '').trim(),
      pgy_level: r[idx.pgy] || '',
      email: idx.email >= 0 ? (r[idx.email] || null) : null,
      mobile: idx.mobile >= 0 ? (r[idx.mobile] || null) : null,
      training_site: idx.site >= 0 ? (r[idx.site] || null) : null,
      start_date: r[idx.start] || '',
      expected_completion_date: r[idx.end] || '',
    });
  }
  return data;
}

module.exports = { generateRosterTemplate, parseRosterFile };
