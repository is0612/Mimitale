'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Import the real dependency-free renderer module unchanged, despite this
// package's CommonJS default. No copied implementation or export rewriting.
const source = readFileSync(path.join(__dirname, '../renderer/js/data/libraryChanges.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const copy = (value) => JSON.parse(JSON.stringify(value));
const item = (id, value = 'A') => ({ id, value });
const patch = (upserts = [], deletes = []) => ({ upserts, deletes });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness(initial = [item('target'), item('peer')], options = {}) {
  const { createLibraryChanges } = await modulePromise;
  const state = {
    records: copy(initial), calls: [], syncCalls: [], requests: [],
    asyncError: null, syncError: null,
    disk: new Map(initial.map(record => [record.id, copy(record)])),
  };
  const apply = (change) => {
    for (const record of change.upserts) state.disk.set(record.id, copy(record));
    for (const id of change.deletes) state.disk.delete(id);
  };
  const changes = createLibraryChanges({
    records: () => state.records,
    save(change) {
      state.calls.push(copy(change));
      if (options.deferred) {
        const request = deferred();
        state.requests.push(request);
        return request.promise;
      }
      if (state.asyncError) return Promise.reject(state.asyncError);
      apply(change);
      // A storage layer may normalize returned records; the editor snapshot
      // that was actually submitted is the baseline to acknowledge.
      return Promise.resolve({ upserts: change.upserts.map(record => ({ ...record, normalized: true })) });
    },
    saveNow(change) {
      state.syncCalls.push(copy(change));
      if (state.syncError) throw state.syncError;
      apply(change);
    },
  });
  return Object.assign(state, changes);
}

const invalidId = /ID 无效或重复/;

test('saving before a successful load is blocked for both paths', async () => {
  const h = await harness();
  await assert.rejects(h.flush(), /尚未成功加载/);
  assert.throws(() => h.flushNow(), /尚未成功加载/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.syncCalls.length, 0);
});

test('loading establishes a baseline and unchanged flushes never write', async () => {
  const h = await harness();
  h.markLoaded();
  await h.flush();
  h.flushNow();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.syncCalls, []);
});

test('editing sends only the changed target and leaves its peer untouched', async () => {
  const h = await harness();
  h.markLoaded();
  h.records[0].value = 'B';
  await h.flush();
  assert.deepEqual(h.calls, [patch([item('target', 'B')])]);
  assert.deepEqual(h.disk.get('peer'), item('peer'));
});

test('adding a record sends only that record', async () => {
  const h = await harness();
  h.markLoaded();
  h.records.push(item('new'));
  await h.flush();
  assert.deepEqual(h.calls, [patch([item('new')])]);
});

test('removing a record sends an explicit delete only for that record', async () => {
  const h = await harness();
  h.markLoaded();
  h.records.shift();
  await h.flush();
  assert.deepEqual(h.calls, [patch([], ['target'])]);
  assert.equal(h.disk.has('target'), false);
  assert.deepEqual(h.disk.get('peer'), item('peer'));
});

test('an externally added disk record is preserved by async and sync saves', async () => {
  const h = await harness();
  h.markLoaded();
  h.disk.set('external', item('external'));
  h.records[0].value = 'B';
  await h.flush();
  h.records[0].value = 'C';
  h.flushNow();
  assert.deepEqual(h.calls, [patch([item('target', 'B')])]);
  assert.deepEqual(h.syncCalls, [patch([item('target', 'C')])]);
  assert.deepEqual(h.disk.get('external'), item('external'));
});

test('unchanged peers are never resent across repeated target saves', async () => {
  const h = await harness();
  h.markLoaded();
  h.records[0].value = 'B';
  await h.flush();
  h.records[0].value = 'C';
  await h.flush();
  assert.deepEqual(h.calls, [patch([item('target', 'B')]), patch([item('target', 'C')])]);
});

test('successful async acknowledgement advances the submitted baseline', async () => {
  const h = await harness();
  h.markLoaded();
  h.records[0].value = 'B';
  await h.flush();
  await h.flush();
  h.flushNow();
  assert.equal(h.calls.length, 1);
  assert.equal(h.syncCalls.length, 0);
  h.records[0].value = 'A';
  await h.flush();
  assert.deepEqual(h.calls[1], patch([item('target')]));
});

test('acknowledged additions and deletions are clean on subsequent flushes', async () => {
  const h = await harness();
  h.markLoaded();
  h.records = [item('peer'), item('new')];
  await h.flush();
  await h.flush();
  h.flushNow();
  assert.deepEqual(h.calls, [patch([item('new')], ['target'])]);
  assert.deepEqual(h.syncCalls, []);
});

test('failed async saves retain pending changes and a retry recovers', async () => {
  const h = await harness();
  h.markLoaded();
  h.records = [item('peer'), item('new')];
  h.asyncError = new Error('disk unavailable');
  await assert.rejects(h.flush(), /disk unavailable/);
  h.asyncError = null;
  await h.flush();
  await h.flush();
  assert.deepEqual(h.calls, [patch([item('new')], ['target']), patch([item('new')], ['target'])]);
  assert.equal(h.disk.has('target'), false);
  assert.deepEqual(h.disk.get('new'), item('new'));
});

test('editing while a save is pending leaves the newer version for the next flush', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const first = h.flush();
  h.records[0].value = 'C';
  h.requests[0].resolve();
  await first;
  const second = h.flush();
  assert.deepEqual(h.calls, [patch([item('target', 'B')]), patch([item('target', 'C')])]);
  h.requests[1].resolve();
  await second;
  await h.flush();
  assert.equal(h.calls.length, 2);
});

test('sync includes an unchanged current version whose async save is in flight', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const pending = h.flush();
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('target', 'B')])]);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test('A to B in flight then revert to A synchronously sends A', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const pending = h.flush();
  h.records[0].value = 'A';
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('target')])]);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1, 'old B acknowledgement must not dirty synchronized A');
});

test('adding in flight then removing synchronously sends an explicit delete', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records.push(item('new'));
  const pending = h.flush();
  h.records.pop();
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([], ['new'])]);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1, 'old addition acknowledgement cannot resurrect baseline');
});

test('deleting in flight then restoring synchronously sends the restored record', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records.shift();
  const pending = h.flush();
  h.records.unshift(item('target'));
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('target')])]);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test('sync success ignores all older async acknowledgements even out of order', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const first = h.flush();
  h.records[0].value = 'C';
  const second = h.flush();
  h.records[0].value = 'D';
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('target', 'D')])]);
  h.requests[1].resolve();
  await second;
  h.requests[0].resolve();
  await first;
  await h.flush();
  h.flushNow();
  assert.equal(h.calls.length, 2);
  assert.equal(h.syncCalls.length, 1);
});

test('sync success followed by old async failure keeps the synchronized baseline', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const pending = h.flush();
  const rejected = assert.rejects(pending, /old request failed/);
  h.records[0].value = 'C';
  h.flushNow();
  h.requests[0].reject(new Error('old request failed'));
  await rejected;
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test('sync failure keeps additions and deletions pending for a successful retry', async () => {
  const h = await harness();
  h.markLoaded();
  h.records = [item('peer'), item('new')];
  h.syncError = new Error('sync unavailable');
  assert.throws(() => h.flushNow(), /sync unavailable/);
  assert.deepEqual(h.disk.get('target'), item('target'));
  h.syncError = null;
  h.flushNow();
  await h.flush();
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('new')], ['target']), patch([item('new')], ['target'])]);
  assert.equal(h.calls.length, 0);
});

test('sync failure retains in-flight uncertainty when the editor reverted to baseline', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const pending = h.flush();
  h.records[0].value = 'A';
  h.syncError = new Error('sync unavailable');
  assert.throws(() => h.flushNow(), /sync unavailable/);
  h.syncError = null;
  h.flushNow();
  assert.deepEqual(h.syncCalls, [patch([item('target')]), patch([item('target')])]);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1);
});

test('sync failure does not invalidate an earlier successful async acknowledgement', async () => {
  const h = await harness(undefined, { deferred: true });
  h.markLoaded();
  h.records[0].value = 'B';
  const pending = h.flush();
  h.syncError = new Error('sync unavailable');
  assert.throws(() => h.flushNow(), /sync unavailable/);
  h.requests[0].resolve();
  await pending;
  await h.flush();
  assert.equal(h.calls.length, 1, 'failed sync must not advance the acknowledgement generation');
});

test('duplicate IDs block loading and leave both save paths unavailable', async () => {
  const h = await harness([item('same'), item('same', 'B')]);
  assert.throws(() => h.markLoaded(), invalidId);
  await assert.rejects(h.flush(), /尚未成功加载/);
  assert.throws(() => h.flushNow(), /尚未成功加载/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.syncCalls, []);
});

test('duplicate IDs introduced after loading block both saves and recover after repair', async () => {
  const h = await harness();
  h.markLoaded();
  h.records.push(item('target', 'duplicate'));
  await assert.rejects(h.flush(), invalidId);
  assert.throws(() => h.flushNow(), invalidId);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.syncCalls, []);
  h.records.pop();
  h.records[0].value = 'B';
  await h.flush();
  assert.deepEqual(h.calls, [patch([item('target', 'B')])]);
});

test('null, missing, non-string, empty and untrimmed IDs are rejected', async () => {
  for (const record of [null, {}, { id: 3 }, { id: '' }, { id: ' ' }, { id: ' target' }, { id: 'target ' }]) {
    const h = await harness();
    h.markLoaded();
    h.records.push(record);
    await assert.rejects(h.flush(), invalidId);
    assert.throws(() => h.flushNow(), invalidId);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.syncCalls, []);
  }
});
