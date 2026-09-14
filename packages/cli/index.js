#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { LockError, writeLock, verifyLock } = require('./lock');

function usage() {
  console.log('Usage: sameroof <command>\n');
  console.log('Getting started:');
  console.log('  init [dir]                                     Initialize a new workspace');
  console.log('  cred add <alias> --provider X --base-url URL --api-key KEY');
  console.log('  cred list                                      List credentials');
  console.log('  new <name> [--model provider/id] [--human]     Create an agent or human');
  console.log('  serve [--port N]                               Start all services\n');
  console.log('Management:');
  console.log('  check                                          Validate workspace config');
  console.log('  explain <name>                                 Show resolved config');
  console.log('  status                                         Service status');
  console.log('  pair <name> [--api URL]                        Mobile pairing link');
  console.log('  doctor                                         Check for dropped messages');
  console.log('  backup / restore                               Backup and restore workspace');
  console.log('  lock [--check]                                 Generate/verify house.lock');
}
function parseOpts(argv) { const args = [], opts = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts[k] = argv[++i]; else opts[k] = true; } else args.push(a); } return { args, opts }; }

function flags(argv) {
  const out = { check: false, house: process.cwd() };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--check') out.check = true;
    else if (argv[index] === '--house' && argv[index + 1]) out.house = argv[++index];
    else throw new LockError('CLI-ARG-UNKNOWN-001', '不认识参数：' + argv[index]);
  }
  return out;
}

function run(argv = process.argv.slice(2)) {
  const command = argv.shift();
  if (command === 'doctor') { const { opts } = parseOpts(argv); const report = require('./doctor').runDoctor(opts); process.exitCode = report.ok ? 0 : 1; return process.exitCode; }
  const { cmds } = require('./house');
  if (command && cmds[command]) { const { args, opts } = parseOpts(argv); cmds[command](args, opts); return process.exitCode || 0; }
  if (command !== 'lock') { usage(); return command ? 2 : 0; }
  const options = flags(argv);
  const root = path.resolve(options.house);
  if (options.check) {
    const lock = verifyLock(root);
    console.log('house.lock 一致：' + lock.source.digest.slice(0, 12));
  } else {
    const lock = writeLock(root);
    console.log('已更新 house.lock：' + lock.source.digest.slice(0, 12));
  }
  return 0;
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) {
    if (error instanceof LockError) {
      console.error(error.code + ': ' + error.message);
      for (const item of error.details || []) console.error(item.code + ' ' + item.file + ':' + item.line + ' ' + item.message_zh);
    } else console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { run, flags };
