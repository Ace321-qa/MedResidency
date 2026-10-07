const db = require('../config/db');
const { generateMasterGridTemplate, parseMasterGrid, generateCccTemplate, parseCcc } = require('../utils/excel/grid');

class RotationImportController {
  static async masterTemplate(req, res) {
    const buf = generateMasterGridTemplate(13);
    res.setHeader('Content-Disposition', 'attachment; filename="master_grid_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }
  static async cccTemplate(req, res) {
    const buf = generateCccTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="ccc_template.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }
}

module.exports = RotationImportController;
