import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  changedPaths,
  validateServices,
  buildRestartPlan,
  RestartError,
  RESTART_CODES,
} from '../src/restart.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_RESTART_PLAN_REQUEST,
} from '../src/example.js';
import { readFileSync } from 'node:fs';

let app;

before(async () => {
  app = buildApp({ logger: false, storeMax: 100 });
  await app.ready();
});

after(async () => {
  await app.close();
});

async function createRecord(payload) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/merges', payload });
  return res.json();
}

function restartPlan(id, services) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/restart-plan`,
    payload: { services },
  });
}

/* ------------------------------ changed paths ---------------------------- */

test('changedPaths distinguishes missing members from null values', () => {
  assert.deepEqual(changedPaths({ a: null }, {}), ['/a']);
  assert.deepEqual(changedPaths({}, { a: null }), ['/a']);
  assert.deepEqual(changedPaths({ a: null }, { a: null }), []);
  assert.deepEqual(changedPaths({ a: 1 }, { a: null }), ['/a']);
  assert.deepEqual(changedPaths({ a: { b: null } }, { a: {} }), ['/a/b']);
});

test('changedPaths records array differences at the array path only', () => {
  assert.deepEqual(changedPaths({ l: [1, 2] }, { l: [1, 2, 3] }), ['/l']);
  assert.deepEqual(changedPaths({ l: [1, 2] }, { l: [1, 9] }), ['/l']);
  // the outer array changed: recorded at /l, never at element paths
  assert.deepEqual(changedPaths({ l: [{ x: [1] }] }, { l: [{ x: [2] }] }), ['/l']);
  assert.deepEqual(changedPaths({ l: [1] }, { l: [] }), ['/l']);
  assert.deepEqual(changedPaths([1, 2], [1, 2]), []);
  // array <-> non-array is a change at that path
  assert.deepEqual(changedPaths({ a: [1] }, { a: {} }), ['/a']);
  assert.deepEqual(changedPaths({ a: [1] }, { a: 5 }), ['/a']);
});

test('changedPaths recurses objects, escapes tokens and sorts pointers', () => {
  const base = { 'a/b': 1, 'a~b': { x: 1, y: 2 }, z: 3 };
  const merged = { 'a/b': 9, 'a~b': { x: 1, y: 4 }, z: 3, q: 1 };
  // "~" escapes to ~0 and "/" to ~1; sorted by the escaped pointer text.
  assert.deepEqual(changedPaths(base, merged), ['/a~0b/y', '/a~1b', '/q']);
});

test('changedPaths reports the root as "" for whole-document changes', () => {
  assert.deepEqual(changedPaths(1, 2), ['']);
  assert.deepEqual(changedPaths({ a: 1 }, [1]), ['']);
  assert.deepEqual(changedPaths(null, { a: 1 }), ['']);
  assert.deepEqual(changedPaths({ a: 1 }, { a: 1 }), []);
});

/* --------------------------- service validation -------------------------- */

test('validateServices normalizes and deduplicates dependsOn', () => {
  const services = validateServices([
    { id: 'a', reads: ['/x', ''], dependsOn: ['b', 'b'] },
    { id: 'b', reads: [], dependsOn: [] },
  ]);
  assert.equal(services.length, 2);
  assert.deepEqual(services[0].dependsOn, ['b']);
  assert.deepEqual(services[0].readTokens, [['x'], []]);
  assert.deepEqual(services[1].readTokens, []);
});

test('validateServices rejects invalid pointers, duplicate ids and unknown dependencies', () => {
  const cases = [
    [{ id: 'a', reads: ['no-slash'], dependsOn: [] }],
    [{ id: 'a', reads: ['/bad~2escape'], dependsOn: [] }],
    [{ id: 'a', reads: ['/x', 7], dependsOn: [] }],
    [
      { id: 'a', reads: [], dependsOn: [] },
      { id: 'a', reads: [], dependsOn: [] },
    ],
    [{ id: 'a', reads: [], dependsOn: ['ghost'] }],
    [{ id: 'a', reads: '/x', dependsOn: [] }],
    [{ id: 'a', reads: [], dependsOn: 'b' }],
    [{ id: 'a', reads: [], dependsOn: [42] }],
    [{ id: '', reads: [], dependsOn: [] }],
    [{ id: 'a', reads: [], dependsOn: [], extra: 1 }],
    ['not-an-object'],
  ];
  for (const services of cases) {
    assert.throws(
      () => validateServices(services),
      (err) => {
        assert.ok(err instanceof RestartError);
        assert.equal(err.code, RESTART_CODES.INVALID_SERVICES);
        assert.ok(Array.isArray(err.details.invalid));
        assert.ok(err.details.invalid.length >= 1);
        return true;
      },
      JSON.stringify(services),
    );
  }
});

test('validateServices reports per-service issues in request order', () => {
  try {
    validateServices([
      { id: 'ok', reads: [], dependsOn: [] },
      { id: 'bad', reads: ['nope'], dependsOn: ['ghost'] },
      { id: 'bad', reads: [], dependsOn: [] },
    ]);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, RESTART_CODES.INVALID_SERVICES);
    assert.deepEqual(
      err.details.invalid.map((e) => e.index),
      [1, 2],
    );
    assert.equal(err.details.invalid[0].id, 'bad');
    assert.ok(err.details.invalid[0].issues.some((i) => i.includes('not a valid JSON Pointer')));
    assert.ok(err.details.invalid[0].issues.some((i) => i.includes('unknown dependency "ghost"')));
    assert.ok(err.details.invalid[1].issues.some((i) => i.includes('duplicate service id "bad"')));
  }
});

/* ------------------------------ plan building ---------------------------- */

const RECORD = {
  base: {
    features: { cache: true, tracing: false },
    replicas: 2,
    servers: [{ host: 'a' }],
    tags: ['stable'],
  },
  merged: {
    features: { cache: true, tracing: true, retries: 3 },
    replicas: 3,
    servers: [{ host: 'a' }, { host: 'b' }],
    tags: ['stable'],
  },
};
// changedPaths(RECORD): /features/retries, /features/tracing, /replicas, /servers

test('buildRestartPlan matches changed and read paths as segment prefixes either way', () => {
  const services = validateServices([
    { id: 'ancestor-read', reads: ['/features'], dependsOn: [] },
    { id: 'descendant-read', reads: ['/features/tracing/level'], dependsOn: [] },
    { id: 'exact-read', reads: ['/replicas'], dependsOn: [] },
    { id: 'miss', reads: ['/tags'], dependsOn: [] },
  ]);
  const plan = buildRestartPlan(RECORD, services);
  const byId = Object.fromEntries(plan.services.map((s) => [s.id, s]));
  assert.deepEqual(byId['ancestor-read'].matchedPaths, [
    '/features/retries',
    '/features/tracing',
  ]);
  assert.deepEqual(byId['descendant-read'].matchedPaths, ['/features/tracing']);
  assert.deepEqual(byId['exact-read'].matchedPaths, ['/replicas']);
  assert.equal(byId.miss, undefined); // unaffected services are not orchestrated
  assert.deepEqual(plan.changedPaths, [
    '/features/retries',
    '/features/tracing',
    '/replicas',
    '/servers',
  ]);
});

test('buildRestartPlan compares decoded tokens (escaped pointers)', () => {
  const record = { base: { 'a/b': { x: 1 } }, merged: { 'a/b': { x: 2 } } };
  const services = validateServices([{ id: 'svc', reads: ['/a~1b/x'], dependsOn: [] }]);
  const plan = buildRestartPlan(record, services);
  assert.deepEqual(plan.changedPaths, ['/a~1b/x']);
  assert.deepEqual(plan.services, [
    { id: 'svc', direct: true, matchedPaths: ['/a~1b/x'] },
  ]);
});

test('buildRestartPlan treats the root read "" as affected by any change', () => {
  const services = validateServices([{ id: 'root-reader', reads: [''], dependsOn: [] }]);
  const plan = buildRestartPlan(RECORD, services);
  assert.deepEqual(plan.services[0].matchedPaths, plan.changedPaths);
});

test('buildRestartPlan propagates impact along the reverse of dependencies', () => {
  // direct hit on a; b depends on a; c depends on b; d is independent.
  const services = validateServices([
    { id: 'a', reads: ['/replicas'], dependsOn: [] },
    { id: 'b', reads: [], dependsOn: ['a'] },
    { id: 'c', reads: [], dependsOn: ['b'] },
    { id: 'd', reads: ['/tags'], dependsOn: [] },
  ]);
  const plan = buildRestartPlan(RECORD, services);
  assert.deepEqual(
    plan.services.map((s) => s.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(plan.services[0], { id: 'a', direct: true, matchedPaths: ['/replicas'] });
  assert.deepEqual(plan.services[1], { id: 'b', direct: false, matchedPaths: [] });
  assert.deepEqual(plan.services[2], { id: 'c', direct: false, matchedPaths: [] });
  // dependencies first: a before b before c
  assert.deepEqual(plan.rounds, [[['a']], [['b']], [['c']]]);
});

test('buildRestartPlan schedules strongly connected components as one group', () => {
  // x <-> y cycle; z depends on x; w is directly hit and independent.
  const services = validateServices([
    { id: 'x', reads: ['/replicas'], dependsOn: ['y'] },
    { id: 'y', reads: [], dependsOn: ['x'] },
    { id: 'z', reads: [], dependsOn: ['x'] },
    { id: 'w', reads: ['/servers'], dependsOn: [] },
  ]);
  const plan = buildRestartPlan(RECORD, services);
  // round 1: group [x, y] (SCC) and group [w], sorted by smallest id ("w" < "x")
  // round 2: [z]
  assert.deepEqual(plan.rounds, [[['w'], ['x', 'y']], [['z']]]);
});

test('buildRestartPlan emits every ready group per round, sorted by id', () => {
  // three independent direct hits + one shared dependent
  const services = validateServices([
    { id: 's3', reads: ['/replicas'], dependsOn: [] },
    { id: 's1', reads: ['/servers'], dependsOn: [] },
    { id: 's2', reads: ['/features/tracing'], dependsOn: [] },
    { id: 'top', reads: [], dependsOn: ['s1', 's2', 's3'] },
  ]);
  const plan = buildRestartPlan(RECORD, services);
  assert.deepEqual(plan.rounds, [[['s1'], ['s2'], ['s3']], [['top']]]);
});

test('buildRestartPlan returns an empty plan when nothing changed', () => {
  const record = { base: { a: 1 }, merged: { a: 1 } };
  const services = validateServices([{ id: 'a', reads: ['/a'], dependsOn: [] }]);
  assert.deepEqual(buildRestartPlan(record, services), {
    changedPaths: [],
    services: [],
    rounds: [],
  });
});

test('buildRestartPlan returns empty services and rounds when no service is affected', () => {
  const services = validateServices([{ id: 'tag-reader', reads: ['/tags'], dependsOn: [] }]);
  const plan = buildRestartPlan(RECORD, services);
  assert.deepEqual(plan.services, []);
  assert.deepEqual(plan.rounds, []);
  assert.ok(plan.changedPaths.length > 0);
});

/* --------------------------------- API ----------------------------------- */

test('POST restart-plan orchestrates the example services (200)', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await restartPlan(record.id, EXAMPLE_RESTART_PLAN_REQUEST.services);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);
  assert.deepEqual(body.changedPaths, [
    '/features/retries',
    '/features/tracing',
    '/replicas',
    '/servers',
  ]);
  assert.deepEqual(body.services, [
    { id: 'api', direct: true, matchedPaths: ['/replicas', '/servers'] },
    { id: 'auth', direct: true, matchedPaths: ['/features/tracing'] },
    {
      id: 'config-db',
      direct: true,
      matchedPaths: ['/features/retries', '/features/tracing'],
    },
    { id: 'session', direct: false, matchedPaths: [] },
    { id: 'worker', direct: false, matchedPaths: [] },
  ]);
  // scheduler reads only /tags (unchanged) and is not orchestrated.
  assert.deepEqual(body.rounds, [
    [['auth', 'session'], ['config-db']],
    [['api']],
    [['worker']],
  ]);
});

test('POST restart-plan with no changes returns an empty plan (200)', async () => {
  const record = await createRecord({ base: { a: 1 }, patchA: [], patchB: [] });
  assert.equal(record.status, 'clean');
  const res = await restartPlan(record.id, [{ id: 'a', reads: ['/a'], dependsOn: [] }]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    id: record.id,
    createdAt: record.createdAt,
    status: 'clean',
    changedPaths: [],
    services: [],
    rounds: [],
  });
});

test('POST restart-plan does not modify the record and is byte-identical on repeat', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const before = (await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` }))
    .payload;
  const res1 = await restartPlan(record.id, EXAMPLE_RESTART_PLAN_REQUEST.services);
  const res2 = await restartPlan(record.id, EXAMPLE_RESTART_PLAN_REQUEST.services);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload, res2.payload);
  const afterFetch = (
    await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` })
  ).payload;
  assert.equal(afterFetch, before);
});

test('POST restart-plan returns 404 for an unknown record', async () => {
  const res = await restartPlan('no-such-id', []);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('POST restart-plan returns 409 for a conflict record', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  const res = await restartPlan(record.id, EXAMPLE_RESTART_PLAN_REQUEST.services);
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'Conflict');
  assert.match(body.message, /conflict/);
});

test('POST restart-plan returns 422 for invalid services', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const cases = [
    [{ id: 'a', reads: ['not-a-pointer'], dependsOn: [] }],
    [{ id: 'a', reads: ['/x~'], dependsOn: [] }],
    [
      { id: 'a', reads: [], dependsOn: [] },
      { id: 'a', reads: [], dependsOn: [] },
    ],
    [{ id: 'a', reads: [], dependsOn: ['missing'] }],
    [{ id: 'a', reads: [], dependsOn: [], bogus: true }],
  ];
  for (const services of cases) {
    const res = await restartPlan(record.id, services);
    assert.equal(res.statusCode, 422, JSON.stringify(services));
    const body = res.json();
    assert.equal(body.code, 'INVALID_SERVICES');
    assert.ok(Array.isArray(body.invalid));
  }
});

test('POST restart-plan returns 400 when services is missing; coercion/stripping match the platform', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  // missing required "services"
  const missing = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: {},
  });
  assert.equal(missing.statusCode, 400);
  // Unknown top-level properties are stripped by the platform-wide ajv
  // config (same as the other preview endpoints), not rejected; an empty
  // service list yields an empty plan.
  const stripped = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: { services: [], extra: true },
  });
  assert.equal(stripped.statusCode, 200);
  assert.deepEqual(stripped.json().services, []);
  // A non-array `services` is coerced to a single-element array (Fastify/ajv
  // array coercion), so its single non-object "service" is reported as an
  // invalid service (422), consistent with other service-level problems.
  const coerced = await app.inject({
    method: 'POST',
    url: `/api/v1/merges/${record.id}/restart-plan`,
    payload: { services: 'nope' },
  });
  assert.equal(coerced.statusCode, 422);
  assert.equal(coerced.json().code, 'INVALID_SERVICES');
});

test('example restart-plan request file mirrors the built-in example', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const fileRequest = JSON.parse(
    readFileSync(new URL('../examples/restart-plan-request.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(fileRequest, EXAMPLE_RESTART_PLAN_REQUEST);
  const res = await restartPlan(record.id, fileRequest.services);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().services.length, 5);
});
