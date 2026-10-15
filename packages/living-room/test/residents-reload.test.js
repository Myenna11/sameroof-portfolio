// A room that moves in is seen without restarting the living room: /members lists it, its token works,
// and a broken room.yaml leaves the previous list in place.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createLivingRoom } = require('../server');

function get(port, pathname, token) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname, headers: token ? { authorization: 'Bearer ' + token } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { let v = Buffer.concat(chunks).toString(); try { v = JSON.parse(v); } catch {} resolve({ status: res.statusCode, body: v }); });
    }).on('error', reject);
  });
}

function addRoom(root, dir, text) {
  fs.mkdirSync(path.join(root, 'rooms', dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'rooms', dir, 'room.yaml'), text);
}

test('residents are reloaded when rooms change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sameroof-reload-'));
  addRoom(root, 'alpha', 'schema_version: 1\nid: resident_alpha_01\nname: Alpha\nspecies: human\n');
  fs.mkdirSync(path.join(root, 'apps', 'house'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'house', 'index.html'), '<!doctype html>');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'house.yaml'), path.join(root, 'house.yaml'));
  const room = createLivingRoom({ houseDir: root, runDir: path.join(root, 'run'), dataDir: path.join(root, 'state'), port: 0, residentsRecheckMs: 0 });
  try {
    const port = (await room.listen()).port;
    const human = room.tokenStore.issue('resident_alpha_01').token;
    assert.deepEqual((await get(port, '/members', human)).body.map(m => m.name), ['Alpha']);

    addRoom(root, 'delta', 'schema_version: 1\nid: resident_delta_01\nname: Delta\nspecies: agent\n');
    assert.deepEqual((await get(port, '/members', human)).body.map(m => m.name).sort(), ['Alpha', 'Delta']);
    const newcomer = room.tokenStore.issue('resident_delta_01').token;
    assert.equal((await get(port, '/members', newcomer)).status, 200);

    addRoom(root, 'broken', 'schema_version: 1\nname: NoId\n');
    assert.deepEqual((await get(port, '/members', human)).body.map(m => m.name).sort(), ['Alpha', 'Delta']);
  } finally {
    await room.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
