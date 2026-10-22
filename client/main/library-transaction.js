'use strict';

// A synchronous, two-file undo transaction, not a general transaction manager.
// The injected writer must atomically replace JSON files and throw on failure.
// Callers must serialize ALL library writers and recover before reading libraries.
// This is application/process-interruption recovery, NOT an OS fsync/power-loss
// guarantee or a cross-process lock. Deleting the primary journal is the commit
// point; a failed save restores old bytes, or leaves a journal blocking new saves.
const fs = require('node:fs');
const path = require('node:path');

const JOURNAL = 'library-save.pending.json';
const KEYS = ['characters', 'worldbooks'];

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRoot(root, key) {
  if (!object(root) || !Object.hasOwn(root, key) || !Array.isArray(root[key])) {
    throw new Error(`Invalid collection root: ${key}`);
  }
  const ids = new Set();
  for (const record of root[key]) {
    if (!object(record) || typeof record.id !== 'string' || !record.id.trim() || record.id !== record.id.trim()) {
      throw new Error(`Invalid record id in ${key}`);
    }
    if (ids.has(record.id)) throw new Error(`Duplicate record id in ${key}: ${record.id}`);
    ids.add(record.id);
  }
}

function prepareSnapshot(data) {
  if (!object(data)) throw new Error('Both complete library roots are required');
  for (const key of KEYS) validateRoot(data[key], key);
  // Serialize both roots together before any journal/target write, so circular
  // values, BigInts, and toJSON changes cannot prepare only half a transaction.
  const snapshot = JSON.parse(JSON.stringify({ characters: data.characters, worldbooks: data.worldbooks }));
  for (const key of KEYS) validateRoot(snapshot[key], key);
  return snapshot;
}

function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateJournal(journal) {
  if (!exactKeys(journal, ['version', 'encoding', 'before']) || journal.version !== 1 || journal.encoding !== 'base64' ||
      !exactKeys(journal.before, KEYS)) {
    throw new Error('Invalid library undo journal schema/version');
  }
  for (const key of KEYS) {
    const value = journal.before[key];
    if (value !== null && (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value)) {
      throw new Error(`Invalid library undo journal bytes: ${key}`);
    }
  }
  return journal;
}

function unlinkIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createLibraryTransaction({ directory, write }) {
  if (typeof directory !== 'function' || typeof write !== 'function') {
    throw new TypeError('directory and synchronous write functions are required');
  }

  function paths() {
    const root = path.resolve(directory());
    return {
      journal: path.join(root, JOURNAL),
      characters: path.join(root, 'characters.json'),
      worldbooks: path.join(root, 'worldbooks.json')
    };
  }

  function removeJournal(files) {
    // Keep the authoritative primary until ALL other cleanup succeeds. Never
    // read a backup journal: a leftover backup must not resurrect an old undo.
    unlinkIfPresent(files.journal + '.backup');
    fs.unlinkSync(files.journal);
  }

  function restore(files, journal) {
    for (const key of KEYS) {
      const bytes = journal.before[key];
      if (bytes === null) {
        unlinkIfPresent(files[key]);
      } else {
        // Do not use the JSON writer here: exact old bytes (even BOM/non-UTF8)
        // and the writer's existing backup must survive repeated undo attempts.
        const tmp = files[key] + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(bytes, 'base64'));
        fs.renameSync(tmp, files[key]);
      }
    }
    removeJournal(files);
  }

  function recoverAt(files) {
    let text;
    try {
      text = fs.readFileSync(files.journal, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    let journal;
    try {
      journal = validateJournal(JSON.parse(text));
    } catch (error) {
      throw new Error(`Invalid library undo journal; refusing recovery: ${error.message}`, { cause: error });
    }
    restore(files, journal);
    return true;
  }

  function recover() {
    return recoverAt(paths());
  }

  function commit(data) {
    const files = paths();
    // An unresolved old transaction must never be overwritten by a new save.
    recoverAt(files);
    const snapshot = prepareSnapshot(data);
    const before = {};
    for (const key of KEYS) {
      try {
        before[key] = fs.readFileSync(files[key]).toString('base64');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        before[key] = null;
      }
    }
    const journal = { version: 1, encoding: 'base64', before };
    // Journal failure cannot change either target. A writer that installed the
    // journal before throwing may leave it pending; the next operation undoes it.
    write(files.journal, journal);
    try {
      for (const key of KEYS) write(files[key], snapshot[key]);
      removeJournal(files);
    } catch (error) {
      try {
        recoverAt(files);
      } catch (recoveryError) {
        const failure = new AggregateError([error, recoveryError],
          `Library save failed: ${error.message}; undo recovery failed: ${recoveryError.message}`, { cause: error });
        failure.code = 'ERR_LIBRARY_TRANSACTION_RECOVERY';
        throw failure;
      }
      throw error;
    }
    return snapshot;
  }

  return { recover, commit };
}

module.exports = { createLibraryTransaction };
