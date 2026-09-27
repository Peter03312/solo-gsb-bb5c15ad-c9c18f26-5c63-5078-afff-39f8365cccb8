/**
 * Tenant grayscale rollout-batch planning for a clean merge record.
 *
 * The client submits the tenant groups that must be rolled out together and
 * a sequence of cumulative coverage targets:
 *
 *   { "groups": [
 *       { "id": "core",   "tenantIds": ["t1", "t2", "t3"] },
 *       { "id": "canary", "tenantIds": ["t4"] } ],
 *     "percentages": [20, 50, 100] }
 *
 * Each group enters in exactly ONE stage, as a whole, and stays covered in
 * every later stage. Stage k (0-based) must cover at least
 * ceil(totalTenants * percentages[k] / 100) tenants; the last target is
 * always 100, so every group has entered by the final stage.
 *
 * Among all feasible assignments of groups to entry stages, the planner
 * minimizes the summed overage — the actual cumulative headcount minus the
 * target headcount at each stage (the final stage contributes 0). Ties are
 * broken by the lexicographically smallest sequence of entry-stage numbers
 * built from groups ordered by group id, i.e. plans that let the
 * smallest-id group enter earlier are preferred.
 *
 * The plan never depends on the record contents, only on the request; the
 * stored record is never modified and input order never affects the result
 * (groups and tenant ids are sorted in the output).
 */

export const ROLLOUT_CODES = Object.freeze({
  INVALID_ROLLOUT_PLAN: 'INVALID_ROLLOUT_PLAN',
});

const MIN_GROUPS = 1;
const MAX_GROUPS = 12;
const MIN_STAGES = 2;
const MAX_STAGES = 5;
const MIN_PERCENT = 1;
const MAX_PERCENT = 100;
const GROUP_KEYS = ['id', 'tenantIds'];

export class RolloutError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'RolloutError';
    this.code = code;
    this.details = details;
  }
}

/** Locale-independent ascending order on strings (UTF-16 code units). */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------ validation ------------------------------- */

/**
 * Validate and normalize the submitted groups and percentages.
 *
 * Returns { groups: [{ id, tenantIds }], percentages } with groups sorted by
 * id and every tenantIds list sorted lexicographically. Every structural or
 * semantic problem is collected and reported at once by throwing
 * RolloutError(INVALID_ROLLOUT_PLAN):
 *
 *   - issues:    request-level problems (group/stage counts, percentages)
 *   - invalid:   per-group problems in request order (index, id, issues)
 */
export function validateRolloutRequest(groups, percentages) {
  const issues = [];

  /* ------------------------------- groups -------------------------------- */

  const invalid = [];
  let validCount = 0;
  if (!Array.isArray(groups)) {
    issues.push('"groups" must be an array');
  } else {
    if (groups.length < MIN_GROUPS) issues.push('"groups" must contain at least 1 group');
    if (groups.length > MAX_GROUPS) issues.push('"groups" may contain at most 12 groups');

    const idFirstIndex = new Map(); // group id -> first request index
    groups.forEach((group, index) => {
      const groupIssues = [];
      if (group === null || typeof group !== 'object' || Array.isArray(group)) {
        groupIssues.push('group must be an object');
        invalid.push({ index, id: null, issues: groupIssues });
        return;
      }
      for (const key of Object.keys(group)) {
        if (!GROUP_KEYS.includes(key)) groupIssues.push(`unknown property "${key}"`);
      }
      let id = null;
      if (typeof group.id !== 'string' || group.id.length === 0) {
        groupIssues.push('"id" must be a non-empty string');
      } else {
        id = group.id;
        if (idFirstIndex.has(id)) {
          groupIssues.push(
            `duplicate group id "${id}" (first used at index ${idFirstIndex.get(id)})`,
          );
        } else {
          idFirstIndex.set(id, index);
        }
      }
      if (!Array.isArray(group.tenantIds)) {
        groupIssues.push('"tenantIds" must be an array of non-empty tenant id strings');
      } else if (group.tenantIds.length === 0) {
        groupIssues.push('"tenantIds" must be a non-empty array');
      } else {
        group.tenantIds.forEach((tenantId, i) => {
          if (typeof tenantId !== 'string' || tenantId.length === 0) {
            groupIssues.push(`"tenantIds[${i}]" must be a non-empty tenant id string`);
          }
        });
      }
      if (groupIssues.length === 0) validCount += 1;
      invalid.push({ index, id, issues: groupIssues });
    });

    // Tenant ids must be globally unique across groups. Only groups whose own
    // shape is valid participate, so duplicate-id noise stays interpretable.
    if (validCount > 0) {
      const tenantOwner = new Map(); // tenant id -> first { groupIndex, groupId }
      groups.forEach((group, index) => {
        if (group === null || typeof group !== 'object' || Array.isArray(group)) return;
        if (typeof group.id !== 'string' || group.id.length === 0) return;
        if (!Array.isArray(group.tenantIds)) return;
        const localSeen = new Set();
        group.tenantIds.forEach((tenantId, i) => {
          if (typeof tenantId !== 'string' || tenantId.length === 0) return;
          if (localSeen.has(tenantId)) {
            invalid[index].issues.push(
              `duplicate tenant id "${tenantId}" at tenantIds[${i}] within group "${group.id}"`,
            );
            return;
          }
          localSeen.add(tenantId);
          if (tenantOwner.has(tenantId)) {
            const first = tenantOwner.get(tenantId);
            invalid[index].issues.push(
              `duplicate tenant id "${tenantId}" (already in group "${first.groupId}" at index ${first.groupIndex})`,
            );
          } else {
            tenantOwner.set(tenantId, { groupIndex: index, groupId: group.id });
          }
        });
      });
    }
  }

  /* ----------------------------- percentages ----------------------------- */

  if (!Array.isArray(percentages)) {
    issues.push('"percentages" must be an array');
  } else {
    if (percentages.length < MIN_STAGES) {
      issues.push('"percentages" must contain at least 2 stages');
    }
    if (percentages.length > MAX_STAGES) {
      issues.push('"percentages" may contain at most 5 stages');
    }
    percentages.forEach((p, i) => {
      if (typeof p !== 'number' || !Number.isInteger(p)) {
        issues.push(`"percentages[${i}]" must be an integer`);
      } else if (p < MIN_PERCENT || p > MAX_PERCENT) {
        issues.push(`"percentages[${i}]" must be an integer between 1 and 100`);
      }
    });
    if (percentages.every((p) => typeof p === 'number' && Number.isInteger(p))) {
      for (let i = 1; i < percentages.length; i += 1) {
        if (percentages[i] <= percentages[i - 1]) {
          issues.push(`"percentages[${i}]" must be strictly greater than percentages[${i - 1}]`);
        }
      }
      if (percentages[percentages.length - 1] !== MAX_PERCENT) {
        issues.push('the last percentage must be 100');
      }
    }
  }

  const badGroups = invalid.filter((entry) => entry.issues.length > 0);
  if (issues.length > 0 || badGroups.length > 0) {
    throw new RolloutError('invalid rollout plan request', {
      code: ROLLOUT_CODES.INVALID_ROLLOUT_PLAN,
      ...(issues.length ? { issues } : {}),
      ...(badGroups.length ? { invalid: badGroups } : {}),
    });
  }

  // Normalize: groups by id (UTF-16 order), tenant ids lexicographically.
  // Planning and serialization are therefore independent of input order.
  const normalizedGroups = groups
    .map((group) => ({
      id: group.id,
      tenantIds: [...new Set(group.tenantIds)].sort(compareStrings),
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  return { groups: normalizedGroups, percentages: [...percentages] };
}

/* ------------------------------- planning -------------------------------- */

/** ceil(numerator / denominator) for non-negative integers. */
function ceilDiv(numerator, denominator) {
  return Math.ceil(numerator / denominator);
}

/**
 * Build the optimal rollout plan from normalized groups and percentages.
 *
 * Dynamic program over (stage, covered-group mask). For each stage a
 * within-stage subset DP grows the covered mask from the previous stage's
 * feasible states, one entering group at a time (the empty batch allowed);
 * states below the cumulative ceil(target) headcount are pruned when the
 * stage closes and its overage (actual minus target) is charged. Each
 * (stage, mask) keeps one state: the minimum summed overage so far, and on a
 * cost tie the lexicographically smallest entry-stage vector — entry[i] is
 * the 1-based stage group i enters in (NOT_ENTERED = k+1 marks the future),
 * so smaller ids entering earlier win. The single retained state dominates
 * every other reaching the same mask, since future overage depends only on
 * the mask and extensions only write not-yet-entered positions.
 */
export function buildRolloutPlan(groups, percentages) {
  const n = groups.length;
  const k = percentages.length;
  const size = 1 << n;
  const totalTenants = groups.reduce((sum, g) => sum + g.tenantIds.length, 0);
  const targets = percentages.map((p) => ceilDiv(totalTenants * p, 100));

  // Subset headcounts: weight[mask] = sum of group sizes in mask.
  const weight = new Array(size).fill(0);
  for (let mask = 1; mask < size; mask += 1) {
    const bit = mask & -mask;
    const i = Math.log2(bit) | 0;
    weight[mask] = weight[mask ^ bit] + groups[i].tenantIds.length;
  }

  const NOT_ENTERED = k + 1;
  // dp[mask] = { cost, entry } for the stage just processed: minimum summed
  // overage with exactly `mask` covered, and the lex-smallest entry vector
  // among the minima (NOT_ENTERED marks groups not entered yet).
  let dp = new Map();
  dp.set(0, { cost: 0, entry: new Int8Array(n).fill(NOT_ENTERED) });

  for (let j = 0; j < k; j += 1) {
    const stageNo = j + 1;
    // Within-stage subset DP: f[mask] is the best (previous-stage cost,
    // vector) continuation covering exactly `mask` at this stage, BEFORE this
    // stage's overage is charged. It is seeded by the empty-batch
    // continuation dp[mask] and extended one group at a time, so ascending
    // mask order finalizes every strict-subset predecessor first. A
    // dominated f[mask] can never win later (extensions only write
    // NOT_ENTERED positions and keep the cost), so one state per mask
    // suffices.
    const f = new Map();
    for (let mask = 0; mask < size; mask += 1) {
      let best = dp.get(mask) ?? null; // empty batch: nothing enters here
      let bits = mask;
      while (bits) {
        const bit = bits & -bits;
        bits ^= bit;
        const pred = f.get(mask ^ bit);
        if (!pred) continue;
        if (best && pred.cost > best.cost) continue;
        const i = Math.log2(bit) | 0;
        // Compare the extension (pred vector with position i set to this
        // stage) with the incumbent without materializing it.
        if (!best || pred.cost < best.cost || vectorWith(pred.entry, i, stageNo, best.entry)) {
          const entryOut = pred.entry.slice();
          entryOut[i] = stageNo;
          best = { cost: pred.cost, entry: entryOut };
        }
      }
      if (best) f.set(mask, best);
    }
    // Close the stage: only masks meeting the cumulative target are feasible;
    // charge the actual-minus-target overage at this point. At the last stage
    // target == totalTenants, so the full mask closes with zero overage.
    const next = new Map();
    for (const [mask, state] of f) {
      if (weight[mask] < targets[j]) continue;
      next.set(mask, { cost: state.cost + weight[mask] - targets[j], entry: state.entry });
    }
    dp = next;
  }

  const finalState = dp.get(size - 1);
  /* c8 ignore next 3: percentages end at 100, so the full mask is reachable */
  if (!finalState) throw new RolloutError('no feasible rollout plan', { code: ROLLOUT_CODES.INVALID_ROLLOUT_PLAN });

  // Assemble per-stage results in group-id order (groups are pre-sorted).
  const stages = [];
  let cumulativeCount = 0;
  const coveredIds = new Set();
  for (let j = 0; j < k; j += 1) {
    const newGroups = [];
    const newTenantIds = [];
    for (let i = 0; i < n; i += 1) {
      if (finalState.entry[i] === j + 1) {
        newGroups.push(groups[i].id);
        for (const tenantId of groups[i].tenantIds) {
          coveredIds.add(tenantId);
          newTenantIds.push(tenantId);
        }
      }
    }
    newTenantIds.sort(compareStrings);
    cumulativeCount = coveredIds.size;
    stages.push({
      stage: j + 1,
      targetPercentage: percentages[j],
      targetTenants: targets[j],
      newGroups,
      newTenantIds,
      cumulativeGroups: groups
        .map((g, i) => g.id)
        .filter((_, i) => finalState.entry[i] <= j + 1),
      cumulativeTenantIds: [...coveredIds].sort(compareStrings),
      cumulativeTenants: cumulativeCount,
      actualCoveragePercent: roundHalfUp((cumulativeCount * 100) / totalTenants, 2),
      overage: cumulativeCount - targets[j],
    });
  }

  return {
    totalTenants,
    totalGroups: n,
    stages,
    totalOverage: finalState.cost,
  };
}

/**
 * Lex comparison of `entry` with position `i` replaced by `stageNo` against
 * `against`: true when the modified vector is strictly smaller. Only invoked
 * between equal-cost states; the replaced position is NOT_ENTERED in `entry`
 * (its group was not yet covered by the predecessor mask).
 */
function vectorWith(entry, i, stageNo, against) {
  for (let p = 0; p < entry.length; p += 1) {
    const v = p === i ? stageNo : entry[p];
    if (v !== against[p]) return v < against[p];
  }
  return false;
}

/** Round to `digits` decimal places using half-up (away-from-zero) rounding. */
function roundHalfUp(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
