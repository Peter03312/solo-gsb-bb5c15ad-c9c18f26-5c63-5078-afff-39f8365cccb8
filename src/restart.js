/**
 * Service restart orchestration for a clean merge record.
 *
 * The client submits the services that read configuration from the merged
 * document:
 *
 *   { "services": [
 *       { "id": "api",                         // unique service id
 *         "reads": ["/servers", "/replicas"],  // RFC 6901 pointers into the config
 *         "dependsOn": ["config-db"] } ] }     // ids of services it depends on
 *
 * The saved base and merged documents are compared recursively:
 *
 *   - a member MISSING on one side is a change at that member's path — a
 *     present null is a value, not a missing member;
 *   - ANY difference involving an array is recorded at the array's own path
 *     only (never at element paths);
 *   - objects are recursed key by key; scalar differences are recorded at
 *     the scalar's path; a change of the whole document is recorded as "".
 *
 * A service is DIRECTLY affected when any changed path and any of its read
 * paths — both decoded to reference tokens — are segment-prefixes of one
 * another ("/features" hits "/features/tracing" and vice versa; the root ""
 * prefixes everything).
 *
 * Impact then propagates along the REVERSE of the declared dependencies:
 * when a service is affected, every service that depends on it (directly or
 * transitively) must restart as well. Only affected services are
 * orchestrated:
 *
 *   - strongly connected components of the affected dependency graph are
 *     scheduled as ONE group (their members cannot be ordered relative to
 *     each other);
 *   - groups are emitted in rounds: a group is ready once every group it
 *     depends on was emitted in an earlier round, and each round lists ALL
 *     groups ready at that point (dependencies first);
 *   - service ids are sorted inside each group, and groups are sorted by
 *     their smallest id inside each round.
 *
 * The response carries the changed paths, the per-service direct-hit paths,
 * the affected services after propagation and the restart rounds. When base
 * and merged are identical the plan is empty. The plan is a pure function
 * of the stored record and the submitted services: the record is never
 * modified and repeated identical requests produce identical responses.
 */

import { deepEqual, formatPointer } from './merge.js';
import { parseRulePointer } from './constraint.js';

export const RESTART_CODES = Object.freeze({
  INVALID_SERVICES: 'INVALID_SERVICES',
});

export class RestartError extends Error {
  constructor(message, { code, ...details } = {}) {
    super(message);
    this.name = 'RestartError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------ changed paths ---------------------------- */

function isContainer(v) {
  return v !== null && typeof v === 'object';
}

/**
 * Append the segments of every path at which base and merged differ.
 * Missing members and null values are distinct: a member present on one
 * side only is a change at that member's path. Any difference involving an
 * array is recorded at the array's own path; objects are recursed in
 * sorted key order.
 */
function diffInto(base, merged, segments, out) {
  if (deepEqual(base, merged)) return;
  if (Array.isArray(base) || Array.isArray(merged)) {
    out.push(segments);
    return;
  }
  if (isContainer(base) && isContainer(merged)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(merged)])].sort();
    for (const key of keys) {
      const inBase = Object.prototype.hasOwnProperty.call(base, key);
      const inMerged = Object.prototype.hasOwnProperty.call(merged, key);
      if (inBase && inMerged) {
        diffInto(base[key], merged[key], [...segments, key], out);
      } else {
        out.push([...segments, key]);
      }
    }
    return;
  }
  out.push(segments);
}

/**
 * Changed paths between two documents as RFC 6901 pointers, sorted in
 * UTF-16 code-unit order. "" denotes a change of the whole document.
 */
export function changedPaths(base, merged) {
  const out = [];
  diffInto(base, merged, [], out);
  return out.map(formatPointer).sort();
}

/* -------------------------- service validation --------------------------- */

const SERVICE_KEYS = ['id', 'reads', 'dependsOn'];

/**
 * Validate the submitted services and return them normalized as
 * { id, reads, readTokens, dependsOn } in request order (dependsOn
 * deduplicated, first occurrence wins). Every problem is collected (one
 * entry per offending service, in request order) and reported by throwing
 * RestartError(INVALID_SERVICES).
 */
export function validateServices(services) {
  const issuesAt = services.map(() => []);
  const normalized = [];
  const seen = new Map(); // service id -> index of its first occurrence
  services.forEach((service, index) => {
    const issues = issuesAt[index];
    if (service === null || typeof service !== 'object' || Array.isArray(service)) {
      issues.push('service must be an object');
      return;
    }
    for (const key of Object.keys(service)) {
      if (!SERVICE_KEYS.includes(key)) issues.push(`unknown property "${key}"`);
    }
    if (typeof service.id !== 'string' || service.id.length === 0) {
      issues.push('"id" must be a non-empty string');
    } else if (seen.has(service.id)) {
      issues.push(
        `duplicate service id "${service.id}" (first used at index ${seen.get(service.id)})`,
      );
    } else {
      seen.set(service.id, index);
    }
    let readTokens = null;
    if (!Array.isArray(service.reads)) {
      issues.push('"reads" must be an array of JSON Pointer strings');
    } else {
      readTokens = [];
      service.reads.forEach((pointer, i) => {
        const tokens = parseRulePointer(pointer);
        if (tokens === null) {
          issues.push(
            typeof pointer === 'string'
              ? `"reads[${i}]" is not a valid JSON Pointer: "${pointer}"`
              : `"reads[${i}]" must be a JSON Pointer string ("" or starting with "/")`,
          );
        } else {
          readTokens.push(tokens);
        }
      });
    }
    let dependsOn = null;
    if (!Array.isArray(service.dependsOn)) {
      issues.push('"dependsOn" must be an array of service id strings');
    } else {
      dependsOn = [];
      const seenDeps = new Set();
      service.dependsOn.forEach((dep, i) => {
        if (typeof dep !== 'string' || dep.length === 0) {
          issues.push(`"dependsOn[${i}]" must be a non-empty service id string`);
        } else if (!seenDeps.has(dep)) {
          seenDeps.add(dep);
          dependsOn.push(dep);
        }
      });
    }
    if (issues.length) return;
    normalized.push({
      id: service.id,
      reads: service.reads,
      readTokens,
      dependsOn,
    });
  });
  // Unknown dependencies are resolved against the full id set in a second
  // pass, so a reference is validated no matter where its target is declared.
  services.forEach((service, index) => {
    if (service === null || typeof service !== 'object' || Array.isArray(service)) return;
    if (!Array.isArray(service.dependsOn)) return;
    for (const dep of new Set(service.dependsOn)) {
      if (typeof dep === 'string' && dep.length > 0 && !seen.has(dep)) {
        issuesAt[index].push(`unknown dependency "${dep}"`);
      }
    }
  });
  const invalid = [];
  issuesAt.forEach((issues, index) => {
    if (!issues.length) return;
    const service = services[index];
    invalid.push({
      index,
      id:
        service !== null &&
        typeof service === 'object' &&
        !Array.isArray(service) &&
        typeof service.id === 'string'
          ? service.id
          : null,
      issues,
    });
  });
  if (invalid.length) {
    throw new RestartError(`${invalid.length} of ${services.length} service(s) are invalid`, {
      code: RESTART_CODES.INVALID_SERVICES,
      invalid,
    });
  }
  return normalized;
}

/* ------------------------------- planning -------------------------------- */

/** True when `a` is a segment-prefix of `b` (equal counts as prefix). */
function isSegmentPrefix(a, b) {
  if (a.length > b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

/**
 * Strongly connected components of the graph `adj` (id -> dependency ids)
 * over `nodes` (Tarjan's algorithm). `nodes` is iterated in the given
 * order, which — together with the caller's sorting — makes the output
 * deterministic.
 */
function stronglyConnectedComponents(nodes, adj) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  function visit(v) {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v)) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component);
    }
  }
  for (const v of nodes) {
    if (!index.has(v)) visit(v);
  }
  return components;
}

/**
 * Build the restart plan for a clean record and normalized services.
 * Returns { changedPaths, services, rounds }: services as
 * { id, direct, matchedPaths } sorted by id; rounds as arrays of groups of
 * service ids (ids sorted inside each group, groups sorted by their
 * smallest id inside each round, dependencies in earlier rounds).
 */
export function buildRestartPlan(record, services) {
  const paths = changedPaths(record.base, record.merged);
  if (paths.length === 0 || services.length === 0) {
    // No configuration changed (or nothing to orchestrate): empty plan.
    return { changedPaths: paths, services: [], rounds: [] };
  }
  const changeTokens = paths.map(parseRulePointer);

  // Direct hits: a changed path and a read path that segment-prefix each
  // other (compared on decoded reference tokens).
  const directHits = new Map(); // service id -> matched changed paths
  for (const service of services) {
    const matched = paths.filter((path, i) =>
      service.readTokens.some(
        (read) =>
          isSegmentPrefix(read, changeTokens[i]) || isSegmentPrefix(changeTokens[i], read),
      ),
    );
    if (matched.length) directHits.set(service.id, matched);
  }

  // Propagate impact along the REVERSE of the dependencies: an affected
  // service forces a restart of everything that depends on it.
  const dependents = new Map(services.map((s) => [s.id, []]));
  for (const service of services) {
    for (const dep of service.dependsOn) dependents.get(dep).push(service.id);
  }
  const affected = new Set(directHits.keys());
  const queue = [...directHits.keys()];
  while (queue.length) {
    const id = queue.shift();
    for (const dependent of dependents.get(id)) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  if (affected.size === 0) {
    return { changedPaths: paths, services: [], rounds: [] };
  }

  // Orchestrate affected services only; dependencies on unaffected services
  // need no restart and impose no ordering constraint.
  const nodes = services
    .filter((s) => affected.has(s.id))
    .map((s) => s.id)
    .sort();
  const byId = new Map(services.map((s) => [s.id, s]));
  const adj = new Map(
    nodes.map((id) => [id, byId.get(id).dependsOn.filter((dep) => affected.has(dep))]),
  );
  const groups = stronglyConnectedComponents(nodes, adj).map((component) => component.sort());
  const groupOf = new Map();
  groups.forEach((group, gi) => group.forEach((id) => groupOf.set(id, gi)));

  // Condensation edges: a group depends on every OTHER group containing one
  // of its members' dependencies.
  const remaining = groups.map(() => new Set());
  for (const id of nodes) {
    const gi = groupOf.get(id);
    for (const dep of byId.get(id).dependsOn) {
      if (!affected.has(dep)) continue;
      const gj = groupOf.get(dep);
      if (gj !== gi) remaining[gi].add(gj);
    }
  }

  // Layered scheduling: every round emits ALL groups whose dependencies are
  // already placed in earlier rounds (the condensation is a DAG, so at
  // least one group is always ready).
  const rounds = [];
  const placed = new Array(groups.length).fill(false);
  let unplaced = groups.length;
  while (unplaced > 0) {
    const ready = [];
    for (let gi = 0; gi < groups.length; gi++) {
      if (!placed[gi] && remaining[gi].size === 0) ready.push(gi);
    }
    ready.sort((a, b) => (groups[a][0] < groups[b][0] ? -1 : 1));
    rounds.push(ready.map((gi) => groups[gi]));
    for (const gi of ready) {
      placed[gi] = true;
      unplaced -= 1;
      for (const deps of remaining) deps.delete(gi);
    }
  }

  const planned = nodes.map((id) => ({
    id,
    direct: directHits.has(id),
    matchedPaths: directHits.get(id) ?? [],
  }));
  return { changedPaths: paths, services: planned, rounds };
}
