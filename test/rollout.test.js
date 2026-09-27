import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import {
  validateRolloutRequest,
  buildRolloutPlan,
  RolloutError,
  ROLLOUT_CODES,
} from '../src/rollout.js';
import {
  EXAMPLE_REQUEST,
  EXAMPLE_CONFLICT_REQUEST,
  EXAMPLE_ROLLOUT_PLAN_REQUEST,
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

function rolloutPlan(id, body) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/merges/${id}/rollout-plan`,
    payload: body,
  });
}

/* ------------------------------ validation ------------------------------- */

test('validateRolloutRequest sorts groups by id and tenant ids', () => {
  const { groups } = validateRolloutRequest(
    [
      { id: 'b', tenantIds: ['t2', 't1'] },
      { id: 'a', tenantIds: ['t4', 't3'] },
    ],
    [50, 100],
  );
  assert.deepEqual(groups, [
    { id: 'a', tenantIds: ['t3', 't4'] },
    { id: 'b', tenantIds: ['t1', 't2'] },
  ]);
});

test('validateRolloutRequest accepts 1 group and the 2..5 stage range', () => {
  for (const percentages of [
    [1, 100],
    [20, 50, 100],
    [1, 2, 3, 4, 100],
  ]) {
    const result = validateRolloutRequest([{ id: 'g', tenantIds: ['t1'] }], percentages);
    assert.deepEqual(result.percentages, percentages);
  }
});

test('validateRolloutRequest rejects out-of-range group/stage counts', () => {
  const tooFewGroups = () => validateRolloutRequest([], [50, 100]);
  const tooManyGroups = () =>
    validateRolloutRequest(
      Array.from({ length: 13 }, (_, i) => ({ id: `g${i}`, tenantIds: [`t${i}`] })),
      [50, 100],
    );
  assert.throws(tooFewGroups, (err) => {
    assert.ok(err instanceof RolloutError);
    assert.match(err.details.issues.join(' '), /at least 1 group/);
    return true;
  });
  assert.throws(tooManyGroups, (err) => {
    assert.match(err.details.issues.join(' '), /at most 12 groups/);
    return true;
  });
  assert.throws(() => validateRolloutRequest([{ id: 'g', tenantIds: ['t'] }], [100]), (err) =>
    err.details.issues.some((m) => m.includes('at least 2 stages')),
  );
  assert.throws(
    () =>
      validateRolloutRequest([{ id: 'g', tenantIds: ['t'] }], [1, 2, 3, 4, 5, 100]),
    (err) => err.details.issues.some((m) => m.includes('at most 5 stages')),
  );
});

test('validateRolloutRequest rejects malformed groups with per-group details', () => {
  try {
    validateRolloutRequest(
      [
        null,
        { id: '', tenantIds: ['t1'] },
        { id: 'ok', tenantIds: [] },
        { id: 'ok', tenantIds: ['t2'] },
        { id: 'x', tenantIds: ['ok', 3] },
        { id: 'y', tenantIds: ['t1'] },
        { id: 'z', tenantIds: ['z1'], extra: true },
      ],
      [50, 100],
    );
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, ROLLOUT_CODES.INVALID_ROLLOUT_PLAN);
    assert.deepEqual(
      err.details.invalid.map((e) => e.index),
      [0, 1, 2, 3, 4, 6],
    );
    assert.equal(err.details.invalid[0].id, null);
    assert.match(err.details.invalid[0].issues[0], /must be an object/);
    assert.match(err.details.invalid[1].issues[0], /non-empty string/);
    assert.match(err.details.invalid[2].issues[0], /non-empty array/);
    assert.match(err.details.invalid[3].issues[0], /duplicate group id "ok"/);
    assert.match(err.details.invalid[4].issues[0], /tenantIds\[1\]/);
    // the well-formed group at index 5 is not reported among invalid entries
    assert.ok(!err.details.invalid.some((e) => e.index === 5));
    assert.match(err.details.invalid[5].issues[0], /unknown property "extra"/);
  }
});

test('validateRolloutRequest rejects globally duplicate and within-group duplicate tenant ids', () => {
  try {
    validateRolloutRequest(
      [
        { id: 'a', tenantIds: ['x', 'x'] },
        { id: 'b', tenantIds: ['x', 'y'] },
        { id: 'c', tenantIds: ['z'] },
      ],
      [50, 100],
    );
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, ROLLOUT_CODES.INVALID_ROLLOUT_PLAN);
    const byIndex = Object.fromEntries(err.details.invalid.map((e) => [e.id, e.issues]));
    assert.ok(byIndex.a.some((m) => m.includes('duplicate tenant id "x" at tenantIds[1]')));
    assert.ok(byIndex.b.some((m) => m.includes('already in group "a"')));
    assert.equal(byIndex.c, undefined);
  }
});

test('validateRolloutRequest rejects bad percentage sequences', () => {
  const oneGroup = [{ id: 'g', tenantIds: ['t'] }];
  const cases = [
    [0, 100], // below 1
    [50, 99], // last must be 100
    [50, 50, 100], // not strictly increasing
    [60, 40, 100], // decreasing
    [101, 100], // above 100
    [20.5, 100], // not an integer
    ['50', 100], // not a number
  ];
  for (const percentages of cases) {
    assert.throws(
      () => validateRolloutRequest(oneGroup, percentages),
      (err) => {
        assert.ok(err instanceof RolloutError);
        assert.equal(err.code, ROLLOUT_CODES.INVALID_ROLLOUT_PLAN);
        assert.ok(err.details.issues.length > 0);
        return true;
      },
      JSON.stringify(percentages),
    );
  }
});

/* ------------------------------ planning --------------------------------- */

test('buildRolloutPlan meets ceil(total*p/100) targets and keeps groups whole', () => {
  const { groups, percentages } = validateRolloutRequest(
    [
      { id: 'a', tenantIds: ['a1', 'a2', 'a3'] },
      { id: 'b', tenantIds: ['b1', 'b2', 'b3'] },
      { id: 'c', tenantIds: ['c1', 'c2', 'c3', 'c4'] },
    ],
    [20, 60, 100],
  );
  // total 10; targets: ceil(2)=2, ceil(6)=6, 10
  const plan = buildRolloutPlan(groups, percentages);
  assert.equal(plan.totalTenants, 10);
  assert.equal(plan.totalGroups, 3);
  assert.deepEqual(
    plan.stages.map((s) => s.targetTenants),
    [2, 6, 10],
  );
  assert.deepEqual(plan.stages[0].newGroups, ['a']); // 3 >= 2 (smallest feasible batch)
  assert.equal(plan.stages[0].cumulativeTenants, 3);
  assert.equal(plan.stages[0].overage, 1);
  assert.deepEqual(plan.stages[1].newGroups, ['b']); // 6 >= 6 exactly
  assert.equal(plan.stages[1].cumulativeTenants, 6);
  assert.equal(plan.stages[1].overage, 0);
  assert.deepEqual(plan.stages[2].newGroups, ['c']);
  assert.equal(plan.stages[2].actualCoveragePercent, 100);
  assert.equal(plan.totalOverage, 1);
});

test('buildRolloutPlan breaks ties by the group-id-ordered entry-stage sequence', () => {
  // total 10; targets 2 / 10. {core} and {early} both satisfy stage 1 at
  // overage 1; the lex-smallest entry vector starts with the smallest id, so
  // "core" enters first and "early" waits for the final stage.
  const { groups, percentages } = validateRolloutRequest(
    [
      { id: 'early', tenantIds: ['e1', 'e2', 'e3'] },
      { id: 'rest', tenantIds: ['r1', 'r2', 'r3', 'r4'] },
      { id: 'core', tenantIds: ['c1', 'c2', 'c3'] },
    ],
    [20, 100],
  );
  const plan = buildRolloutPlan(groups, percentages);
  assert.deepEqual(plan.stages[0].newGroups, ['core']);
  assert.deepEqual(plan.stages[1].newGroups, ['early', 'rest']);
  assert.equal(plan.stages[0].overage, 1);
  assert.equal(plan.totalOverage, 1);
});

test('buildRolloutPlan prefers less overage over lexicographic earliness', () => {
  // total 10; targets 4 / 10. Putting size-3 "a" in stage 1 forces a second
  // group (overage >= 1); the size-4 "b" alone reaches 4 exactly.
  const { groups, percentages } = validateRolloutRequest(
    [
      { id: 'a', tenantIds: ['a1', 'a2', 'a3'] },
      { id: 'b', tenantIds: ['b1', 'b2', 'b3', 'b4'] },
      { id: 'c', tenantIds: ['c1', 'c2', 'c3'] },
    ],
    [40, 100],
  );
  const plan = buildRolloutPlan(groups, percentages);
  assert.deepEqual(plan.stages[0].newGroups, ['b']);
  assert.equal(plan.stages[0].overage, 0);
  assert.equal(plan.totalOverage, 0);
});

test('buildRolloutPlan allows an empty intermediate stage when targets align', () => {
  // total 100; targets 20 / 25 / 100. No combination smaller than 30 meets 20,
  // so stage 2 adds no groups and contributes its own overage (5).
  const { groups, percentages } = validateRolloutRequest(
    [
      { id: 'a', tenantIds: Array.from({ length: 30 }, (_, i) => `a${i}`) },
      { id: 'b', tenantIds: Array.from({ length: 30 }, (_, i) => `b${i}`) },
      { id: 'c', tenantIds: Array.from({ length: 40 }, (_, i) => `c${i}`) },
    ],
    [20, 25, 100],
  );
  const plan = buildRolloutPlan(groups, percentages);
  assert.deepEqual(plan.stages[0].newGroups, ['a']);
  assert.deepEqual(plan.stages[1].newGroups, []);
  assert.deepEqual(plan.stages[1].newTenantIds, []);
  assert.equal(plan.stages[1].cumulativeTenants, 30);
  assert.equal(plan.stages[1].overage, 5);
  assert.deepEqual(plan.stages[2].newGroups, ['b', 'c']);
  assert.equal(plan.totalOverage, 15); // 10 (stage 1) + 5 (stage 2) + 0
});

test('buildRolloutPlan reports rounded actual coverage percentages', () => {
  // total 3; stage 1 target ceil(0.33)=1: one single-tenant group enters ->
  // 33.33% actual; stage 2 takes the remaining pair -> 100%.
  const { groups, percentages } = validateRolloutRequest(
    [
      { id: 'a', tenantIds: ['t1'] },
      { id: 'b', tenantIds: ['t2', 't3'] },
    ],
    [10, 100],
  );
  const plan = buildRolloutPlan(groups, percentages);
  assert.equal(plan.stages[0].targetTenants, 1);
  assert.equal(plan.stages[0].actualCoveragePercent, 33.33);
  assert.equal(plan.stages[1].actualCoveragePercent, 100);
});

test('buildRolloutPlan is input-order independent and complete', () => {
  const body = EXAMPLE_ROLLOUT_PLAN_REQUEST;
  const shuffled = {
    groups: [...body.groups].reverse().map((g) => ({
      id: g.id,
      tenantIds: [...g.tenantIds].reverse(),
    })),
    percentages: body.percentages,
  };
  const p1 = (() => {
    const n = validateRolloutRequest(body.groups, body.percentages);
    return buildRolloutPlan(n.groups, n.percentages);
  })();
  const p2 = (() => {
    const n = validateRolloutRequest(shuffled.groups, shuffled.percentages);
    return buildRolloutPlan(n.groups, n.percentages);
  })();
  assert.deepEqual(p1, p2);
  assert.deepEqual(
    p1.stages.map((s) => s.newGroups),
    [['canary'], ['core'], ['early', 'rest']],
  );
  // cumulative tenant ids are sorted and grow monotonically
  assert.deepEqual(p1.stages[0].cumulativeTenantIds, ['t1', 't2']);
  assert.deepEqual(p1.stages[1].cumulativeTenantIds, ['t1', 't2', 't3', 't4', 't5']);
  assert.equal(p1.stages[2].cumulativeTenantIds.length, 10);
  // every tenant appears as new exactly once
  const allNew = p1.stages.flatMap((s) => s.newTenantIds);
  assert.deepEqual([...allNew].sort(), [
    't1', 't10', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9',
  ]);
});

/* --------------------------------- API ----------------------------------- */

test('POST rollout-plan plans the example groups (200)', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  assert.equal(record.status, 'clean');
  const res = await rolloutPlan(record.id, EXAMPLE_ROLLOUT_PLAN_REQUEST);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.id, record.id);
  assert.equal(body.status, 'clean');
  assert.ok(body.createdAt);
  assert.equal(body.totalTenants, 10);
  assert.equal(body.totalGroups, 4);
  assert.equal(body.totalOverage, 0);
  assert.deepEqual(
    body.stages.map((s) => [s.stage, s.targetPercentage, s.targetTenants, s.newGroups]),
    [
      [1, 20, 2, ['canary']],
      [2, 50, 5, ['core']],
      [3, 100, 10, ['early', 'rest']],
    ],
  );
  assert.equal(body.stages[1].actualCoveragePercent, 50);
});

test('POST rollout-plan does not modify the record and is byte-identical on repeat', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const before = (await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` }))
    .payload;
  const res1 = await rolloutPlan(record.id, EXAMPLE_ROLLOUT_PLAN_REQUEST);
  const shuffled = {
    groups: [...EXAMPLE_ROLLOUT_PLAN_REQUEST.groups].reverse(),
    percentages: [...EXAMPLE_ROLLOUT_PLAN_REQUEST.percentages].reverse().reverse(),
  };
  const res2 = await rolloutPlan(record.id, shuffled);
  assert.equal(res1.statusCode, 200);
  // shuffled group order yields the same deterministic response
  assert.equal(res1.payload, res2.payload);
  const afterFetch = (
    await app.inject({ method: 'GET', url: `/api/v1/merges/${record.id}` })
  ).payload;
  assert.equal(afterFetch, before);
});

test('POST rollout-plan returns 404 for an unknown record', async () => {
  const res = await rolloutPlan('no-such-id', EXAMPLE_ROLLOUT_PLAN_REQUEST);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'Not Found');
});

test('POST rollout-plan returns 409 for a conflict record', async () => {
  const record = await createRecord(EXAMPLE_CONFLICT_REQUEST);
  assert.equal(record.status, 'conflict');
  const res = await rolloutPlan(record.id, EXAMPLE_ROLLOUT_PLAN_REQUEST);
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.error, 'Conflict');
  assert.match(body.message, /rollout plan requires a clean merge record/);
});

test('POST rollout-plan returns 422 for invalid requests', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const cases = [
    { groups: [], percentages: [50, 100] },
    {
      groups: [{ id: 'a', tenantIds: ['t1'] }, { id: 'a', tenantIds: ['t2'] }],
      percentages: [50, 100],
    },
    { groups: [{ id: 'a', tenantIds: ['t1'] }, { id: 'b', tenantIds: ['t1'] }], percentages: [50, 100] },
    { groups: [{ id: 'a', tenantIds: [] }], percentages: [50, 100] },
    { groups: [{ id: 'a', tenantIds: ['t1'] }], percentages: [50, 99] },
    { groups: [{ id: 'a', tenantIds: ['t1'] }], percentages: [50, 50, 100] },
    { groups: [{ id: 'a', tenantIds: ['t1'] }], percentages: [50] },
    { groups: [{ id: 'a', tenantIds: ['t1'] }], percentages: [0, 100] },
    { groups: [{ id: 1, tenantIds: ['t1'] }], percentages: [50, 100] },
  ];
  for (const body of cases) {
    const res = await rolloutPlan(record.id, body);
    assert.equal(res.statusCode, 422, JSON.stringify(body));
    const out = res.json();
    assert.equal(out.code, 'INVALID_ROLLOUT_PLAN');
    assert.ok(out.issues || out.invalid);
  }
});

test('POST rollout-plan returns 400 when required fields are missing', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const missingGroups = await rolloutPlan(record.id, { percentages: [50, 100] });
  assert.equal(missingGroups.statusCode, 400);
  const missingPercentages = await rolloutPlan(record.id, {
    groups: [{ id: 'a', tenantIds: ['t1'] }],
  });
  assert.equal(missingPercentages.statusCode, 400);
  const empty = await rolloutPlan(record.id, {});
  assert.equal(empty.statusCode, 400);
  // Unknown top-level properties are stripped by the platform-wide ajv
  // config (same as the other plan endpoints), not rejected.
  const stripped = await rolloutPlan(record.id, {
    ...EXAMPLE_ROLLOUT_PLAN_REQUEST,
    extra: 1,
  });
  assert.equal(stripped.statusCode, 200);
});

test('example rollout-plan request file mirrors the built-in example', async () => {
  const record = await createRecord(EXAMPLE_REQUEST);
  const fileRequest = JSON.parse(
    readFileSync(new URL('../examples/rollout-plan-request.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(fileRequest, EXAMPLE_ROLLOUT_PLAN_REQUEST);
  const res = await rolloutPlan(record.id, fileRequest);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().stages.length, 3);
});

test('GET /api/v1/example advertises the rollout-plan example', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/example' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.rolloutPlanRequest);
  assert.deepEqual(body.rolloutPlanRequest, EXAMPLE_ROLLOUT_PLAN_REQUEST);
});
