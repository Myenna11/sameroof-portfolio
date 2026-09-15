'use strict';
// Test launcher for a REAL gateway process (test/crash-recovery.test.js). Lives outside test/ so `node --test` doesn't run it as a test. Identical to server.js's main entry except it skips
// assertUnprivileged() so the test can also run on a root-owned dev box. Everything else — constructor recovery, listen,
// approval/delivery loop — is the production code path.
const { createGateway } = require('../server');
const gateway = createGateway({ livingRoomPort: Number(process.env.SAMEROOF_LIVING_ROOM_PORT || 8790) });
gateway.listen().then(() => { gateway.startApprovalLoop(); console.log('test gateway listening ' + gateway.socketPath); })
  .catch(error => { console.error(error.code || error); process.exit(1); });
