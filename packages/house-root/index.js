// 同屋 · 房子根目录解析：SAMEROOF_ROOT > 从 cwd 向上找 house.yaml（git 式）> ~/.sameroof。
// 三条路都空就抛错，错误信息把试过的路都列出来。（旧名 SAMEROOF_HOUSE 不再认——DECISIONS：不留兼容期）
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const HOUSE_FILE = 'house.yaml';
const hasHouse = dir => { try { return fs.statSync(path.join(dir, HOUSE_FILE)).isFile(); } catch { return false; } };

function findUp(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (hasHouse(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function fromEnv(name, value) {
  const dir = path.resolve(value);
  if (hasHouse(dir)) return dir;
  throw new Error(`${name}=${value} 指向的目录里没有 ${HOUSE_FILE}：${dir}`);
}

// resolveHouseRoot(startDir = process.cwd(), env = process.env) → 含 house.yaml 的目录（绝对路径）
function resolveHouseRoot(startDir = process.cwd(), env = process.env) {
  if (env.SAMEROOF_ROOT) return fromEnv('SAMEROOF_ROOT', env.SAMEROOF_ROOT);
  const found = findUp(startDir);
  if (found) return found;
  const home = path.join(env.HOME || os.homedir(), '.sameroof');
  if (hasHouse(home)) return home;
  throw new Error([
    `找不到房子（${HOUSE_FILE}）。试过三条路：`,
    `  1. 环境变量 SAMEROOF_ROOT：未设置`,
    `  2. 从 ${path.resolve(startDir)} 向上逐级找：没有`,
    `  3. ${home}：没有`,
    `设 SAMEROOF_ROOT，或在房子目录里运行。`,
  ].join('\n'));
}

module.exports = { resolveHouseRoot, findUp, HOUSE_FILE };
