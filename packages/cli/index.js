#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { LockError, writeLock, verifyLock } = require('./lock');

function usage() {
  console.log('用法：sameroof <命令>');
  console.log('  new <名字> [--model provider/id] [--runtime ..] [--human]   建一间屋');
  console.log('  check                                                     全屋校验');
  console.log('  explain <名字>                                            每个生效值来自哪');
  console.log('  pair <名字> [--api 地址] [--rotate]                        手机配对链接');
  console.log('  status                                                    服务与锁');
  console.log('  backup [--out 目录] [--plain]                              行李打包（默认 gpg 加密，口令从 stdin）');
  console.log('  restore <文件> [--into 目录]                               解到空目录');
  console.log('  lock [--check]                                            生成/校验 house.lock');
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
