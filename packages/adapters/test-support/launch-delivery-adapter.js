'use strict';
// A real adapter process, with a scripted model and no provider credentials.
const { run } = require('../lib/room');
const think = async (system) => {
  if (/现在要睡了/.test(system)) return 'fixture handover';
  console.log('FIXTURE_MODEL_CALL');
  return process.env.DELIVERY_REPLY;
};
run('Agent', 'broker-direct', think, { once: true, lr: process.env.SAMEROOF_LR })
  .catch(e => { console.error(e); process.exitCode = 1; });
