"use strict";
// In-memory browser-session boundary for older lifecycle fixtures. This virtual
// configured key lets those tests reach their original claim/STOP boundaries.
module.exports = function sessionFixture(key = "fixture-session-key") {
  const values = { lighthouseAiApiKey: key };
  return {
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter(k => Object.hasOwn(values, k)).map(k => [k, values[k]])); },
    async set(update) { Object.assign(values, update); },
    async remove(keys) { for (const key of [].concat(keys)) delete values[key]; }
  };
};
