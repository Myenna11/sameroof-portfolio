// Plugin: Memory
// Injects relevant memories into the system prompt before thinking.
// Depends on @sameroof/plugin-memory.
'use strict';

function memory(config = {}) {
  const maxRecall = config.maxRecall || 5;
  let mem = null;

  return {
    name: 'memory',
    onWake({ agentId }) {
      try {
        const pluginMemory = require('@sameroof/plugin-memory');
        const path = require('path');
        const { resolveHouseRoot } = require('@sameroof/house-root');
        const roomDir = path.join(resolveHouseRoot(), 'rooms', agentId.replace('resident_', '').replace(/_\d+$/, ''));
        mem = pluginMemory.open(roomDir);
      } catch (e) { console.error('[memory plugin] init failed:', e.message); }
    },
    async beforeThink({ system, user, message }) {
      if (!mem) return null;
      const hits = await mem.recall(user, maxRecall);
      if (!hits.length) return null;
      const rendered = mem.render(hits);
      return { system: system + '\n\n' + rendered, user };
    },
    async afterThink({ message, response }) {
      // Auto-remember important responses (simple heuristic: if response is substantial)
      if (mem && response && response.length > 100 && !['(静默)', '(silent)'].includes(response.trim())) {
        mem.remember({ content: `Responded to "${(message.text || '').slice(0, 50)}": ${response.slice(0, 200)}`, source: 'self' });
      }
    }
  };
}

module.exports = memory;
