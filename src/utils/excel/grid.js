const XLSX = require('xlsx');
const { makeBuffer } = require('./common');

function generateMasterGridTemplate(blockCount = 13) {
  const headers = ['Resident Corporate ID', 'Resident Name'];
  for (let i = 1; i <= blockCount; i++) headers.push(`Block ${i}`);
  return makeBuffer(headers, [], 'Master Grid');
}

function parseMasterGrid(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).filter(r => r && r.some(v => v));
  if (rows.length < 2) throw new Error('Need header + rows');
  const headers = rows[0].map(h => String(h || ''));
  const corpIdx = headers.indexOf('Resident Corporate ID');
  const nameIdx = headers.indexOf('Resident Name');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const corpId = corpIdx >= 0 ? String(r[corpIdx] || '').trim() : '';
    if (!corpId) continue;
    out.push({ row: i + 1, corporate_id: corpId, rowData: r, headers });
  }
  return out;
}

function generateCccTemplate() {
  const headers = ['Day', 'Slot', 'Clinic Type', 'Resident IDs (comma)', 'Faculty Leads', 'Catchup Pool'];
  return makeBuffer(headers, [], 'CCC');
}

function parseCcc(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }).filter(r => r && r.some(v => v));
  if (rows.length < 2) return [];
  return rows.slice(1).map((r, i) => ({
    row: i + 2,
    day: r[0] || '',
    slot: r[1] || '',
    clinic_type: r[2] || '',
    resident_ids: r[3] || '',
    faculty: r[4] || '',
    catchup: r[5] || '',
  }));
}

module.exports = { generateMasterGridTemplate, parseMasterGrid, generateCccTemplate, parseCcc };
