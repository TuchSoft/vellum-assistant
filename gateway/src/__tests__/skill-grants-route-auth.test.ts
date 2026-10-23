/**
 * Source-level authorization assertions for the skill grant routes.
 *
 * The gateway route table is a literal array in `index.ts`, so the cheapest
 * reliable check is to read it: every skill grant route must be edge-scoped,
 * reads must require `settings.read`, and every write must require
 * `settings.write`. A route that drifted to `auth: "edge"` or to no scope
 * would let a read-only token grant a capability.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSource = readFileSync(
  join(import.meta.dir, "..", "index.ts"),
  "utf8",
);

function extractSkillGrantRouteObjects(): string[] {
  const start = indexSource.indexOf(
    "// ── Skill capability grants (scope-protected) ──",
  );
  const end = indexSource.indexOf("  ];", start);
  const block = indexSource.slice(start, end);

  return block
    .split(/\n    \},\n/)
    .filter((routeObject) => routeObject.includes("handleSkillGrant"));
}

describe("skill grant route authorization", () => {
  test("every route is edge-scoped", () => {
    const routeObjects = extractSkillGrantRouteObjects();

    expect(routeObjects).toHaveLength(8);

    for (const routeObject of routeObjects) {
      expect(routeObject).toContain('auth: "edge-scoped"');
      expect(routeObject).not.toContain('auth: "edge"');
      expect(routeObject).not.toContain('auth: "none"');
    }
  });

  test("reads require settings.read and writes require settings.write", () => {
    const routeObjects = extractSkillGrantRouteObjects();

    const reads = routeObjects.filter(
      (routeObject) =>
        routeObject.includes("handleSkillGrantList") ||
        routeObject.includes("handleSkillGrantGet"),
    );
    const writes = routeObjects.filter(
      (routeObject) =>
        routeObject.includes("handleSkillGrantPut") ||
        routeObject.includes("handleSkillGrantDelete"),
    );

    expect(reads).toHaveLength(4);
    expect(writes).toHaveLength(4);

    for (const routeObject of reads) {
      expect(routeObject).toContain('scope: "settings.read"');
    }
    for (const routeObject of writes) {
      expect(routeObject).toContain('scope: "settings.write"');
    }
  });

  test("each route is registered flat and assistant-scoped", () => {
    const routeObjects = extractSkillGrantRouteObjects();

    for (const handlerName of [
      "handleSkillGrantList",
      "handleSkillGrantGet",
      "handleSkillGrantPut",
      "handleSkillGrantDelete",
    ]) {
      const matching = routeObjects.filter((routeObject) =>
        routeObject.includes(handlerName),
      );
      expect(matching).toHaveLength(2);
    }
  });
});
