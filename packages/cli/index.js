#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { LockError, writeLock, verifyLock } = require('./lock');

function usage() {
  console.log('用法：sameroof lock [--check] [--house <目录>]');
}

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
