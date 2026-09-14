// Plugin: Task Board
// Reads own tasks on wake, adds them to the system prompt.
'use strict';

function taskboard() {
  let tasks = [];

  return {
    name: 'taskboard',
    async onWake({ api }) {
      try {
        const result = await api('GET', '/tasks?owner=me&state=open,doing,blocked');
        if (Array.isArray(result)) tasks = result;
      } catch {}
    },
    async beforeThink({ system, user }) {
      if (!tasks.length) return null;
      const board = tasks.map(t => `- [${t.state}] ${t.title}`).join('\n');
      return { system: system + '\n\nYour current tasks:\n' + board, user };
    },
    async onMessage(msg, api) {
      // Refresh tasks when we get a dispatch notification
      if (msg.meta?.dispatch || msg.meta?.task_id) {
        try {
          const result = await api('GET', '/tasks?owner=me&state=open,doing,blocked');
          if (Array.isArray(result)) tasks = result;
        } catch {}
      }
    }
  };
}

module.exports = taskboard;
