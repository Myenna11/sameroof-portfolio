// Plugin: Heartbeat
// Periodically pings the coordinator to stay visible as "online".
// Config: { interval: ms (default 60000) }
'use strict';

function heartbeat(config = {}) {
  const interval = config.interval || 60000;
  let timer = null;

  return {
    name: 'heartbeat',
    onWake({ api, agentName }) {
      timer = setInterval(async () => {
        try { await api('POST', '/activity', { kind: 'heartbeat', text: `${agentName}: alive` }); }
        catch {}
      }, interval);
    },
    onSleep() {
      if (timer) { clearInterval(timer); timer = null; }
    }
  };
}

module.exports = heartbeat;
