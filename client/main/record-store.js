'use strict';

// 单条修改与旧异步写共用主进程队列；不提供跨进程锁或云端冲突处理。
// 界面用差异批次及同步回执；保留的旧 whole/immediate API 混用边界见 record-store.md。
const fs = require('node:fs');
const { isDeepStrictEqual } = require('node:util');

function recordId(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error('Record id must be a non-empty string without outer whitespace');
  }
  return value;
}

function validateCollection(data, key) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data[key])) {
    throw new Error(`Invalid collection: ${key}`);
  }
  const ids = new Set();
  for (const record of data[key]) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Invalid record in ${key}`);
    }
    const id = recordId(record.id);
    if (ids.has(id)) throw new Error(`Duplicate record id in ${key}: ${id}`);
    ids.add(id);
  }
  return data;
}

/** Unlike legacy loaders, failed reads must never be treated as an empty library. */
function readCollection(file, key) {
  let primaryError;
  try {
    return { data: validateCollection(JSON.parse(fs.readFileSync(file, 'utf8')), key), recovered: false };
  } catch (err) {
    primaryError = err;
  }
  // Permission and I/O failures are not evidence that the primary is corrupt.
  if (primaryError.code && primaryError.code !== 'ENOENT') throw primaryError;
  try {
    return { data: validateCollection(JSON.parse(fs.readFileSync(file + '.backup', 'utf8')), key), recovered: true };
  } catch (backupError) {
    if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') {
      return { data: { [key]: [] }, recovered: false };
    }
    throw new Error(`Cannot read ${key}; refusing to overwrite primary or backup: ${primaryError.message}; ${backupError.message}`);
  }
}

function createRecordStore({ file, key, normalize, maxItems = Infinity, enqueue, write }) {
  function loadOne(id) {
    recordId(id);
    const { data } = readCollection(file(), key);
    const found = data[key].find((record) => record.id === id);
    return found ? normalize(found) : null;
  }

  function commit(path, data, recovered) {
    // Restore a validated backup first so writeJsonNow does not back up corrupt bytes.
    // If restoring fails, preserve the known-good backup and reject the mutation.
    if (recovered) fs.copyFileSync(path + '.backup', path);
    write(path, data);
  }

  function saveOne(record) {
    let item;
    try {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('A complete record object is required');
      }
      const id = recordId(record.id);
      // Snapshot at invocation time: callers may mutate their editor objects while queued.
      const snapshot = JSON.parse(JSON.stringify(record));
      if (!snapshot || snapshot.id !== id) throw new Error('Record id changed during serialization');
      item = normalize(snapshot);
      if (item.id !== id) throw new Error('Record normalization changed id');
    } catch (err) {
      return Promise.reject(err);
    }
    return enqueue(() => {
      const path = file();
      const { data, recovered } = readCollection(path, key);
      const list = data[key].slice();
      const index = list.findIndex((record) => record.id === item.id);
      if (index < 0) {
        if (list.length >= maxItems) throw new Error(`Collection limit reached: ${key} (${maxItems})`);
        list.push(item);
      } else {
        list[index] = item;
      }
      commit(path, { ...data, [key]: list }, recovered);
      return item;
    });
  }

  function deleteOne(id) {
    try {
      recordId(id);
    } catch (err) {
      return Promise.reject(err);
    }
    return enqueue(() => {
      const path = file();
      const { data, recovered } = readCollection(path, key);
      const list = data[key].filter((record) => record.id !== id);
      const deleted = list.length !== data[key].length;
      if (deleted) commit(path, { ...data, [key]: list }, recovered);
      return { id, deleted };
    });
  }

  let generation = 0;

  function prepareChanges(payload) {
    if (!payload || !Array.isArray(payload.upserts) || !Array.isArray(payload.deletes)) {
      throw new Error('Changes require upserts and deletes arrays');
    }
    const ids = new Set();
    const upserts = payload.upserts.map((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('A complete record object is required');
      const id = recordId(record.id);
      if (ids.has(id)) throw new Error(`Duplicate upsert id: ${id}`);
      ids.add(id);
      const snapshot = JSON.parse(JSON.stringify(record));
      if (!snapshot || snapshot.id !== id) throw new Error('Record id changed during serialization');
      const item = normalize(snapshot);
      if (!item || item.id !== id) throw new Error('Record normalization changed id');
      return item;
    });
    const deleted = new Set();
    const deletes = payload.deletes.map((value) => {
      const id = recordId(value);
      if (deleted.has(id) || ids.has(id)) throw new Error(`Duplicate or overlapping change id: ${id}`);
      deleted.add(id);
      return id;
    });
    return { upserts, deletes };
  }

  function commitChanges(changes) {
    if (!changes.upserts.length && !changes.deletes.length) return changes;
    const path = file();
    const { data, recovered } = readCollection(path, key);
    const existing = new Set(data[key].map((record) => record.id));
    const deleted = new Set(changes.deletes);
    const replacements = new Map(changes.upserts.map((record) => [record.id, record]));
    const list = data[key].filter((record) => !deleted.has(record.id))
      .map((record) => replacements.get(record.id) || record);
    const added = changes.upserts.filter((record) => !existing.has(record.id));
    list.push(...added);
    if (added.length && list.length > maxItems) {
      throw new Error(`Collection limit reached: ${key} (${maxItems})`);
    }
    if (!isDeepStrictEqual(data[key], list)) commit(path, { ...data, [key]: list }, recovered);
    return changes;
  }

  function applyChanges(payload) {
    let changes;
    try { changes = prepareChanges(payload); } catch (err) { return Promise.reject(err); }
    const started = generation;
    return enqueue(() => {
      if (started !== generation) {
        const err = new Error('ERR_SUPERSEDED: superseded by synchronous library changes');
        err.code = 'ERR_SUPERSEDED';
        throw err;
      }
      return commitChanges(changes);
    });
  }

  function applyChangesNow(payload) {
    const result = commitChanges(prepareChanges(payload));
    generation += 1;
    return result;
  }

  return { loadOne, saveOne, deleteOne, applyChanges, applyChangesNow };
}

module.exports = { createRecordStore };
