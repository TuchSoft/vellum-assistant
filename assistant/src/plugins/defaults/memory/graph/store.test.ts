import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(30_000);

import { describePg } from "../../../../__tests__/pg-test-db.js";
import { requireMainDb } from "../../../../persistence/db-facade.js";
import {
  applyDiff,
  countNodes,
  createEdge,
  createNode,
  createTrigger,
  deduplicateParagraphs,
  deleteEdge,
  deleteNode,
  deleteTrigger,
  getActiveTriggersByType,
  getEdgesForNode,
  getNode,
  getNodesByIds,
  getTriggersForNode,
  queryNodes,
  reinforceNode,
  supersedeNode,
  updateNode,
  updateTrigger,
} from "./store.js";
import type { NewNode } from "./types.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function makeNewNode(overrides: Partial<NewNode> = {}): NewNode {
  const now = Date.now();
  return {
    content: "Test memory.",
    type: "episodic",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.3,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.3,
    },
    fidelity: "vivid",
    confidence: 0.8,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: ["conv-1"],
    sourceType: "direct",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    ...overrides,
  };
}

beforeEach(async () => {
  // Deleting nodes cascades to edges, triggers, and edits.
  await requireMainDb().run("DELETE FROM memory_graph_nodes");
});

// ---------------------------------------------------------------------------
// Node CRUD
// ---------------------------------------------------------------------------

describePg("node CRUD", () => {
  test("createNode assigns an ID and returns the full node", async () => {
    const node = await createNode(makeNewNode({ content: "Hello world." }));
    expect(node.id).toBeTruthy();
    expect(typeof node.id).toBe("string");
    expect(node.content).toBe("Hello world.");
    expect(node.type).toBe("episodic");
  });

  test("getNode returns the node by ID", async () => {
    const created = await createNode(makeNewNode({ content: "Find me." }));
    const found = await getNode(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.content).toBe("Find me.");
  });

  test("getNode returns null for non-existent ID", async () => {
    expect(await getNode("non-existent")).toBeNull();
  });

  test("getNodesByIds returns multiple nodes", async () => {
    const a = await createNode(makeNewNode({ content: "Node A." }));
    const b = await createNode(makeNewNode({ content: "Node B." }));
    await createNode(makeNewNode({ content: "Node C." }));

    const found = await getNodesByIds([a.id, b.id]);
    expect(found).toHaveLength(2);
    const contents = found.map((n) => n.content).sort();
    expect(contents).toEqual(["Node A.", "Node B."]);
  });

  test("getNodesByIds returns empty for empty input", async () => {
    expect(await getNodesByIds([])).toEqual([]);
  });

  test("updateNode modifies specified fields", async () => {
    const node = await createNode(makeNewNode({ content: "Original." }));
    await updateNode(node.id, {
      content: "Updated.",
      significance: 0.9,
    });
    const updated = await getNode(node.id);
    expect(updated!.content).toBe("Updated.");
    expect(updated!.significance).toBe(0.9);
    // Untouched fields should remain
    expect(updated!.type).toBe("episodic");
  });

  test("updateNode with empty changes is a no-op", async () => {
    const node = await createNode(makeNewNode({ content: "Unchanged." }));
    await updateNode(node.id, {});
    const same = await getNode(node.id);
    expect(same!.content).toBe("Unchanged.");
  });

  test("updateNode serializes emotionalCharge as JSON", async () => {
    const node = await createNode(makeNewNode());
    await updateNode(node.id, {
      emotionalCharge: {
        valence: 0.8,
        intensity: 0.9,
        decayCurve: "permanent",
        decayRate: 0,
        originalIntensity: 0.9,
      },
    });
    const updated = await getNode(node.id);
    expect(updated!.emotionalCharge.valence).toBe(0.8);
    expect(updated!.emotionalCharge.decayCurve).toBe("permanent");
  });

  test("createNode with eventDate round-trips through getNode", async () => {
    const eventDate = Date.now() - 86400000; // yesterday
    const node = await createNode(makeNewNode({ eventDate }));
    const found = await getNode(node.id);
    expect(found).not.toBeNull();
    expect(found!.eventDate).toBe(eventDate);
  });

  test("createNode with null eventDate round-trips as null", async () => {
    const node = await createNode(makeNewNode({ eventDate: null }));
    const found = await getNode(node.id);
    expect(found).not.toBeNull();
    expect(found!.eventDate).toBeNull();
  });

  test("updateNode updates eventDate", async () => {
    const node = await createNode(makeNewNode({ eventDate: null }));
    const newEventDate = Date.now() - 86400000;
    await updateNode(node.id, { eventDate: newEventDate });
    const updated = await getNode(node.id);
    expect(updated!.eventDate).toBe(newEventDate);
  });

  test("updateNode can set eventDate to null", async () => {
    const eventDate = Date.now() - 86400000;
    const node = await createNode(makeNewNode({ eventDate }));
    await updateNode(node.id, { eventDate: null });
    const updated = await getNode(node.id);
    expect(updated!.eventDate).toBeNull();
  });

  test("deleteNode soft-deletes the node by setting fidelity to gone", async () => {
    const node = await createNode(makeNewNode());
    await deleteNode(node.id);
    const deleted = await getNode(node.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.fidelity).toBe("gone");
  });
});

// ---------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------

describePg("queryNodes", () => {
  test("filters by type", async () => {
    await createNode(makeNewNode({ type: "episodic", content: "Ep." }));
    await createNode(makeNewNode({ type: "semantic", content: "Sem." }));
    await createNode(makeNewNode({ type: "emotional", content: "Em." }));

    const results = await queryNodes({ types: ["semantic", "emotional"] });
    expect(results).toHaveLength(2);
  });

  test("excludes fidelity levels", async () => {
    await createNode(makeNewNode({ fidelity: "vivid", content: "Vivid." }));
    await createNode(makeNewNode({ fidelity: "gone", content: "Gone." }));

    const results = await queryNodes({ fidelityNot: ["gone"] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Vivid.");
  });

  test("filters by minimum significance", async () => {
    await createNode(makeNewNode({ significance: 0.3, content: "Low." }));
    await createNode(makeNewNode({ significance: 0.7, content: "High." }));

    const results = await queryNodes({ minSignificance: 0.5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("High.");
  });

  test("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createNode(makeNewNode({ content: `Node ${i}.` }));
    }
    const results = await queryNodes({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("orders by significance descending", async () => {
    await createNode(makeNewNode({ significance: 0.3 }));
    await createNode(makeNewNode({ significance: 0.9 }));
    await createNode(makeNewNode({ significance: 0.6 }));

    const results = await queryNodes({});
    expect(results[0].significance).toBe(0.9);
    expect(results[1].significance).toBe(0.6);
    expect(results[2].significance).toBe(0.3);
  });

  test("filters by hasEventDate", async () => {
    await createNode(
      makeNewNode({ content: "Dated.", eventDate: 1700000000000 }),
    );
    await createNode(makeNewNode({ content: "Undated.", eventDate: null }));

    const results = await queryNodes({ hasEventDate: true });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Dated.");
  });

  test("filters by eventDateAfter", async () => {
    await createNode(
      makeNewNode({ content: "Old.", eventDate: 1700000000000 }),
    );
    await createNode(
      makeNewNode({ content: "Recent.", eventDate: 1710000000000 }),
    );
    await createNode(makeNewNode({ content: "None.", eventDate: null }));

    const results = await queryNodes({ eventDateAfter: 1705000000000 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Recent.");
  });

  test("filters by eventDateBefore", async () => {
    await createNode(
      makeNewNode({ content: "Old.", eventDate: 1700000000000 }),
    );
    await createNode(
      makeNewNode({ content: "Recent.", eventDate: 1710000000000 }),
    );
    await createNode(makeNewNode({ content: "None.", eventDate: null }));

    const results = await queryNodes({ eventDateBefore: 1705000000000 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Old.");
  });

  test("combines eventDateAfter and eventDateBefore for range query", async () => {
    await createNode(
      makeNewNode({ content: "Before.", eventDate: 1690000000000 }),
    );
    await createNode(
      makeNewNode({ content: "In range.", eventDate: 1700000000000 }),
    );
    await createNode(
      makeNewNode({ content: "After.", eventDate: 1720000000000 }),
    );

    const results = await queryNodes({
      eventDateAfter: 1695000000000,
      eventDateBefore: 1710000000000,
    });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("In range.");
  });
});

describePg("countNodes", () => {
  test("counts non-gone nodes", async () => {
    await createNode(makeNewNode({ fidelity: "vivid" }));
    await createNode(makeNewNode({ fidelity: "clear" }));
    await createNode(makeNewNode({ fidelity: "gone" }));

    expect(await countNodes()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge CRUD
// ---------------------------------------------------------------------------

describePg("edge CRUD", () => {
  test("createEdge assigns an ID and returns the full edge", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    const edge = await createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "caused-by",
      weight: 0.8,
      created: Date.now(),
    });
    expect(edge.id).toBeTruthy();
    expect(edge.sourceNodeId).toBe(a.id);
    expect(edge.targetNodeId).toBe(b.id);
    expect(edge.relationship).toBe("caused-by");
    expect(edge.weight).toBe(0.8);
  });

  test("getEdgesForNode returns all edges (both directions)", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    const c = await createNode(makeNewNode());
    await createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    await createEdge({
      sourceNodeId: c.id,
      targetNodeId: a.id,
      relationship: "part-of",
      weight: 0.5,
      created: Date.now(),
    });

    const edges = await getEdgesForNode(a.id);
    expect(edges).toHaveLength(2);
  });

  test("getEdgesForNode with outgoing direction", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    await createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    await createEdge({
      sourceNodeId: b.id,
      targetNodeId: a.id,
      relationship: "caused-by",
      weight: 1.0,
      created: Date.now(),
    });

    const outgoing = await getEdgesForNode(a.id, "outgoing");
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].targetNodeId).toBe(b.id);
  });

  test("getEdgesForNode with incoming direction", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    await createEdge({
      sourceNodeId: b.id,
      targetNodeId: a.id,
      relationship: "caused-by",
      weight: 1.0,
      created: Date.now(),
    });

    const incoming = await getEdgesForNode(a.id, "incoming");
    expect(incoming).toHaveLength(1);
    expect(incoming[0].sourceNodeId).toBe(b.id);
  });

  test("deleteEdge removes the edge", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    const edge = await createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });
    await deleteEdge(edge.id);
    expect(await getEdgesForNode(a.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

describePg("trigger CRUD", () => {
  test("createTrigger assigns an ID and returns the full trigger", async () => {
    const node = await createNode(makeNewNode());
    const trigger = await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "day-of-week:monday",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: true,
      consumed: false,
      cooldownMs: 1000 * 60 * 60 * 12,
      lastFired: null,
    });
    expect(trigger.id).toBeTruthy();
    expect(trigger.type).toBe("temporal");
    expect(trigger.schedule).toBe("day-of-week:monday");
    expect(trigger.recurring).toBe(true);
  });

  test("getTriggersForNode returns triggers for a given node", async () => {
    const node = await createNode(makeNewNode());
    await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    await createTrigger({
      nodeId: node.id,
      type: "semantic",
      schedule: null,
      condition: "cooking topic",
      conditionEmbedding: null,
      threshold: 0.7,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const triggers = await getTriggersForNode(node.id);
    expect(triggers).toHaveLength(2);
  });

  test("updateTrigger modifies consumed and lastFired", async () => {
    const node = await createNode(makeNewNode());
    const trigger = await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "date:04-08",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const now = Date.now();
    await updateTrigger(trigger.id, { consumed: true, lastFired: now });

    const updated = await getTriggersForNode(node.id);
    expect(updated[0].consumed).toBe(true);
    expect(updated[0].lastFired).toBe(now);
  });

  test("getActiveTriggersByType returns only non-consumed triggers", async () => {
    const node = await createNode(makeNewNode());
    await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:evening",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: true,
      cooldownMs: null,
      lastFired: null,
    });

    const active = await getActiveTriggersByType("temporal");
    expect(active).toHaveLength(1);
    expect(active[0].schedule).toBe("time:morning");
  });
});

// ---------------------------------------------------------------------------
// Reinforcement
// ---------------------------------------------------------------------------

describePg("reinforceNode", () => {
  test("increments reinforcementCount", async () => {
    const node = await createNode(
      makeNewNode({ reinforcementCount: 0, stability: 14, significance: 0.5 }),
    );
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.reinforcementCount).toBe(1);
  });

  test("multiplies stability by 1.5", async () => {
    const node = await createNode(makeNewNode({ stability: 14 }));
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.stability).toBeCloseTo(21, 5); // 14 × 1.5
  });

  test("boosts significance by 10%, capped at 1.0", async () => {
    const node = await createNode(makeNewNode({ significance: 0.5 }));
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.significance).toBeCloseTo(0.55, 5); // 0.5 × 1.1
  });

  test("significance does not exceed 1.0", async () => {
    const node = await createNode(makeNewNode({ significance: 0.95 }));
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.significance).toBeLessThanOrEqual(1.0);
  });

  test("updates lastReinforced timestamp", async () => {
    const oldTime = Date.now() - 10000;
    const node = await createNode(makeNewNode({ lastReinforced: oldTime }));
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.lastReinforced).toBeGreaterThan(oldTime);
  });

  test("multiple reinforcements compound stability", async () => {
    const node = await createNode(makeNewNode({ stability: 14 }));
    await reinforceNode(node.id);
    await reinforceNode(node.id);
    await reinforceNode(node.id);
    const updated = (await getNode(node.id))!;
    expect(updated.reinforcementCount).toBe(3);
    // 14 × 1.5^3 = 47.25
    expect(updated.stability).toBeCloseTo(47.25, 1);
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describePg("supersedeNode", () => {
  test("creates new node with inherited durability", async () => {
    const old = await createNode(
      makeNewNode({
        content: "Old fact.",
        stability: 50,
        reinforcementCount: 5,
        significance: 0.9,
      }),
    );
    const newNodeInput = makeNewNode({
      content: "Updated fact.",
      stability: 14,
      reinforcementCount: 0,
      significance: 0.5,
    });

    const { newNode, oldNode } = await supersedeNode(old.id, newNodeInput);

    expect(newNode.content).toBe("Updated fact.");
    // Inherits max of each durability metric
    expect(newNode.stability).toBe(50); // max(14, 50)
    expect(newNode.reinforcementCount).toBe(5); // max(0, 5)
    expect(newNode.significance).toBe(0.9); // max(0.5, 0.9)
    expect(oldNode).not.toBeNull();
    expect(oldNode!.id).toBe(old.id);
  });

  test("creates a supersedes edge between new and old node", async () => {
    const old = await createNode(makeNewNode({ content: "Old." }));
    const { newNode } = await supersedeNode(
      old.id,
      makeNewNode({ content: "New." }),
    );

    const edges = await getEdgesForNode(newNode.id, "outgoing");
    expect(edges).toHaveLength(1);
    expect(edges[0].relationship).toBe("supersedes");
    expect(edges[0].targetNodeId).toBe(old.id);
    expect(edges[0].weight).toBe(1.0);
  });

  test("inherits eventDate from old node when new node has null eventDate", async () => {
    const eventDate = 1712534400000; // April 8 2024
    const old = await createNode(
      makeNewNode({ content: "Dentist April 8.", eventDate }),
    );
    const newNodeInput = makeNewNode({
      content: "Dentist appointment rescheduled.",
      eventDate: null,
    });

    const { newNode } = await supersedeNode(old.id, newNodeInput);

    expect(newNode.eventDate).toBe(eventDate);
  });

  test("uses new node eventDate when both nodes have eventDate", async () => {
    const old = await createNode(
      makeNewNode({ content: "Flight Tuesday.", eventDate: 1712534400000 }),
    );
    const newEventDate = 1712620800000;
    const newNodeInput = makeNewNode({
      content: "Flight moved to Thursday.",
      eventDate: newEventDate,
    });

    const { newNode } = await supersedeNode(old.id, newNodeInput);

    expect(newNode.eventDate).toBe(newEventDate);
  });

  test("handles non-existent old node by just creating new node", async () => {
    const { newNode, oldNode } = await supersedeNode(
      "non-existent",
      makeNewNode({ content: "Brand new." }),
    );
    expect(newNode.content).toBe("Brand new.");
    expect(oldNode).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// applyDiff
// ---------------------------------------------------------------------------

describePg("applyDiff", () => {
  test("creates nodes and returns counts", async () => {
    const result = await applyDiff({
      createNodes: [
        makeNewNode({ content: "Node 1." }),
        makeNewNode({ content: "Node 2." }),
      ],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });

    expect(result.nodesCreated).toBe(2);
    expect(result.createdNodeIds).toHaveLength(2);
  });

  test("deletes nodes", async () => {
    const node = await createNode(makeNewNode());
    const result = await applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [node.id],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.nodesDeleted).toBe(1);
    const deleted = await getNode(node.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.fidelity).toBe("gone");
  });

  test("updates nodes", async () => {
    const node = await createNode(makeNewNode({ content: "Before." }));
    const result = await applyDiff({
      createNodes: [],
      updateNodes: [{ id: node.id, changes: { content: "After." } }],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.nodesUpdated).toBe(1);
    expect((await getNode(node.id))!.content).toBe("After.");
  });

  test("reinforces nodes", async () => {
    const node = await createNode(makeNewNode({ reinforcementCount: 0 }));
    const result = await applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [node.id],
    });
    expect(result.nodesReinforced).toBe(1);
    expect((await getNode(node.id))!.reinforcementCount).toBe(1);
  });

  test("creates and deletes edges", async () => {
    const a = await createNode(makeNewNode());
    const b = await createNode(makeNewNode());
    const existingEdge = await createEdge({
      sourceNodeId: a.id,
      targetNodeId: b.id,
      relationship: "reminds-of",
      weight: 1.0,
      created: Date.now(),
    });

    const result = await applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [
        {
          sourceNodeId: b.id,
          targetNodeId: a.id,
          relationship: "caused-by",
          weight: 0.5,
          created: Date.now(),
        },
      ],
      deleteEdgeIds: [existingEdge.id],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [],
    });
    expect(result.edgesCreated).toBe(1);
    expect(result.edgesDeleted).toBe(1);
  });

  test("creates and deletes triggers", async () => {
    const node = await createNode(makeNewNode());
    const existingTrigger = await createTrigger({
      nodeId: node.id,
      type: "temporal",
      schedule: "time:morning",
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    const result = await applyDiff({
      createNodes: [],
      updateNodes: [],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [
        {
          nodeId: node.id,
          type: "semantic",
          schedule: null,
          condition: "test",
          conditionEmbedding: null,
          threshold: 0.7,
          eventDate: null,
          rampDays: null,
          followUpDays: null,
          recurring: false,
          consumed: false,
          cooldownMs: null,
          lastFired: null,
        },
      ],
      deleteTriggerIds: [existingTrigger.id],
      reinforceNodeIds: [],
    });
    expect(result.triggersCreated).toBe(1);
    expect(result.triggersDeleted).toBe(1);
    const remaining = await getTriggersForNode(node.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe("semantic");
  });

  test("applies all operations atomically", async () => {
    // Verify all operations are in the same transaction by creating
    // a complex diff and checking the result counts.
    const existingNode = await createNode(
      makeNewNode({ content: "Existing." }),
    );

    const result = await applyDiff({
      createNodes: [makeNewNode({ content: "New 1." })],
      updateNodes: [{ id: existingNode.id, changes: { content: "Updated." } }],
      deleteNodeIds: [],
      createEdges: [],
      deleteEdgeIds: [],
      createTriggers: [],
      deleteTriggerIds: [],
      reinforceNodeIds: [existingNode.id],
    });

    expect(result.nodesCreated).toBe(1);
    expect(result.nodesUpdated).toBe(1);
    expect(result.nodesReinforced).toBe(1);
    expect((await getNode(existingNode.id))!.content).toBe("Updated.");
    expect((await getNode(existingNode.id))!.reinforcementCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deleteTrigger
// ---------------------------------------------------------------------------

describePg("deleteTrigger", () => {
  test("removes a trigger by ID", async () => {
    const node = await createNode(makeNewNode());
    const trigger = await createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: Date.now(),
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    await deleteTrigger(trigger.id);
    expect(await getTriggersForNode(node.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateNode — event trigger sync
// ---------------------------------------------------------------------------

describePg("updateNode event trigger sync", () => {
  test("syncs event trigger eventDate when node eventDate is updated", async () => {
    const originalDate = 1712534400000;
    const newDate = 1712620800000;
    const node = await createNode(makeNewNode({ eventDate: originalDate }));
    await createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: originalDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    await updateNode(node.id, { eventDate: newDate });

    const triggers = await getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].eventDate).toBe(newDate);
  });

  test("deletes event trigger when node eventDate is cleared to null", async () => {
    const eventDate = 1712534400000;
    const node = await createNode(makeNewNode({ eventDate }));
    await createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    await updateNode(node.id, { eventDate: null });

    const triggers = await getTriggersForNode(node.id);
    expect(triggers).toHaveLength(0);
  });

  test("does not affect non-event triggers when eventDate changes", async () => {
    const node = await createNode(makeNewNode({ eventDate: 1712534400000 }));
    await createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate: 1712534400000,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });
    await createTrigger({
      nodeId: node.id,
      type: "semantic",
      schedule: null,
      condition: "cooking topic",
      conditionEmbedding: null,
      threshold: 0.7,
      eventDate: null,
      rampDays: null,
      followUpDays: null,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    await updateNode(node.id, { eventDate: null });

    const triggers = await getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe("semantic");
  });

  test("does not touch triggers when eventDate is not in changes", async () => {
    const eventDate = 1712534400000;
    const node = await createNode(makeNewNode({ eventDate }));
    await createTrigger({
      nodeId: node.id,
      type: "event",
      schedule: null,
      condition: null,
      conditionEmbedding: null,
      threshold: null,
      eventDate,
      rampDays: 7,
      followUpDays: 2,
      recurring: false,
      consumed: false,
      cooldownMs: null,
      lastFired: null,
    });

    // Update something other than eventDate
    await updateNode(node.id, { content: "Updated content." });

    const triggers = await getTriggersForNode(node.id);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].eventDate).toBe(eventDate);
  });
});

// ---------------------------------------------------------------------------
// Paragraph deduplication
// ---------------------------------------------------------------------------

describePg("deduplicateParagraphs", () => {
  test("content with no duplicates passes through unchanged", async () => {
    const input = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    expect(deduplicateParagraphs(input)).toBe(input);
  });

  test("two identical paragraphs separated by \\n\\n collapses to one", async () => {
    const input = "Hello world.\n\nHello world.";
    expect(deduplicateParagraphs(input)).toBe("Hello world.");
  });

  test("paragraphs that differ only in trailing whitespace are treated as duplicates", async () => {
    const input = "Hello world.  \n\nHello world.";
    expect(deduplicateParagraphs(input)).toBe("Hello world.  ");
  });

  test("bullet lists with repeated items are deduped", async () => {
    const input = "- item one\n- item two\n- item one\n- item three";
    expect(deduplicateParagraphs(input)).toBe(
      "- item one\n- item two\n- item three",
    );
  });

  test("empty content returns empty string", async () => {
    expect(deduplicateParagraphs("")).toBe("");
  });

  test("multiple duplicate paragraphs with different content", async () => {
    const input = "Alpha.\n\nBeta.\n\nAlpha.\n\nGamma.\n\nBeta.";
    expect(deduplicateParagraphs(input)).toBe("Alpha.\n\nBeta.\n\nGamma.");
  });

  test("bullet dedup within a paragraph preserves non-bullet lines", async () => {
    const input = "Header:\n- item A\n- item B\n- item A";
    expect(deduplicateParagraphs(input)).toBe("Header:\n- item A\n- item B");
  });

  test("paragraphs differing only in internal whitespace are treated as duplicates", async () => {
    const input = "hello   world\n\nhello world";
    expect(deduplicateParagraphs(input)).toBe("hello   world");
  });
});
