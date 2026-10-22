'use strict';

// Compare editor state against acknowledged state, never against a fresh disk list:
// records created elsewhere must not become implicit deletes.
function snapshot(records) {
  const result = new Map();
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || !record.id.trim() || record.id !== record.id.trim() || result.has(record.id)) {
      throw new Error('库记录 ID 无效或重复，已停止保存');
    }
    result.set(record.id, JSON.stringify(record));
  }
  return result;
}

export function isSuperseded(error) {
  return String(error && error.message).includes('ERR_SUPERSEDED');
}

export function createLibraryChanges({ records, save, saveNow }) {
  let baseline = null;
  let generation = 0;
  const inFlight = new Map();

  function markLoaded() {
    baseline = snapshot(records());
  }

  function pending() {
    if (!baseline) throw new Error('库尚未成功加载，已停止保存');
    const current = snapshot(records());
    const uncertain = new Set();
    for (const change of inFlight.values()) {
      for (const [id] of change.upserts) uncertain.add(id);
      for (const id of change.deletes) uncertain.add(id);
    }
    const upserts = [...current].filter(([id, text]) => baseline.get(id) !== text || uncertain.has(id));
    const deletes = [...new Set([...baseline.keys(), ...uncertain])].filter((id) => !current.has(id));
    return { current, upserts, deletes };
  }

  function payload(change) {
    return { upserts: change.upserts.map(([, text]) => JSON.parse(text)), deletes: change.deletes };
  }

  function acknowledge(change) {
    // Store the submitted editor snapshot, not its normalized result: store defaults
    // must not make every unchanged editor record look dirty on the next flush.
    for (const [id, text] of change.upserts) baseline.set(id, text);
    for (const id of change.deletes) baseline.delete(id);
  }

  async function flush() {
    const change = pending();
    if (!change.upserts.length && !change.deletes.length) return;
    const started = generation;
    const token = {};
    inFlight.set(token, change);
    try {
      await save(payload(change));
      if (started === generation) acknowledge(change);
    } finally {
      inFlight.delete(token);
    }
  }

  function flushNow() {
    const change = pending();
    if (!change.upserts.length && !change.deletes.length) return;
    // Includes all unacknowledged changes, even those with an invoke in flight.
    // A successful synchronous commit supersedes older queued batches in main.
    saveNow(payload(change));
    generation += 1;
    inFlight.clear();
    acknowledge(change);
  }

  function beginBatch() {
    const change = pending();
    const token = {};
    const started = generation;
    inFlight.set(token, change);
    return {
      payload: payload(change),
      acknowledge(synchronous = false) {
        if (synchronous) { generation += 1; inFlight.clear(); }
        if (synchronous || started === generation) acknowledge(change);
      },
      finish() { inFlight.delete(token); }
    };
  }

  return { markLoaded, flush, flushNow, beginBatch };
}
