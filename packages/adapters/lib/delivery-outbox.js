'use strict';
// One adapter owns one pending publication. Persist before sending and reuse the
// coordinator key after uncertain outcomes. This is not exactly-once execution.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
class DeliveryOutbox {
  constructor(file) { this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); }
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  syncDir() {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  write(item) {
    const tmp = this.file + '.tmp', fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(item)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file); this.syncDir(); return item;
  }
  prepare({ route, body, inboxIds = [], mailIds = [], exit }) {
    if (this.read()) throw new Error('Previous publication is still pending');
    if (!['/say', '/dm'].includes(route)) throw new Error('Unsupported publication route');
    return this.write({ id: 'send_' + crypto.randomBytes(16).toString('hex'), route, body, inboxIds, mailIds, exit, phase: 'prepared' });
  }
  clear() { fs.unlinkSync(this.file); this.syncDir(); }
  async flush({ api, ok2xx, acknowledge, markMail }) {
    let item = this.read();
    if (!item) return null;
    try {
      if (item.phase === 'prepared') {
        const r = await api('POST', item.route, { ...item.body, client_request_id: item.id });
        if (!ok2xx(r, 'id')) {
          // Definite validation rejection: a later turn may correct the reply.
          // Unknown outcomes, rate limiting and server failures keep this draft.
          if ([400, 404, 413, 422].includes(r && r.$status)) this.clear();
          throw new Error('Publication not accepted: ' + JSON.stringify(r).slice(0, 300));
        }
        item = this.write({ ...item, phase: 'accepted', messageId: r.id });
      } else if (item.phase !== 'accepted') throw new Error('Invalid outbox phase');
      if (markMail) markMail(item.mailIds, item.exit, true);
      await acknowledge(item.inboxIds);
      this.clear(); return item;
    } catch (e) {
      if (markMail && item.phase !== 'accepted') markMail(item.mailIds, item.exit + '_failed', false);
      throw e;
    }
  }
}
module.exports = { DeliveryOutbox };
