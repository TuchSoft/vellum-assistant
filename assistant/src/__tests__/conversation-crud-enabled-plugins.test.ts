import { beforeEach, expect, setDefaultTimeout, test } from "bun:test";

import {
  addMessage,
  createConversation,
  forkConversation,
  getConversation,
  getConversationEnabledPlugins,
  setConversationEnabledPlugins,
} from "../persistence/conversation-crud.js";
import { requireMainDb } from "../persistence/db-facade.js";
import { describePg } from "./pg-test-db.js";

setDefaultTimeout(30_000);

describePg(
  "getConversationEnabledPlugins / setConversationEnabledPlugins",
  () => {
    beforeEach(async () => {
      const db = requireMainDb();
      await db.run(`DELETE FROM messages`);
      await db.run(`DELETE FROM conversations`);
    });

    test("defaults to null on a fresh conversation", async () => {
      const conv = await createConversation("enabled-plugins-default");
      expect(await getConversationEnabledPlugins(conv.id)).toBeNull();
      expect((await getConversation(conv.id))?.enabledPlugins).toBeNull();
    });

    test("round-trips a plugin list and clears it with null", async () => {
      const conv = await createConversation("enabled-plugins-roundtrip");

      await setConversationEnabledPlugins(conv.id, ["a", "b"]);
      expect(await getConversationEnabledPlugins(conv.id)).toEqual(["a", "b"]);
      expect((await getConversation(conv.id))?.enabledPlugins).toEqual([
        "a",
        "b",
      ]);

      await setConversationEnabledPlugins(conv.id, null);
      expect(await getConversationEnabledPlugins(conv.id)).toBeNull();
      expect((await getConversation(conv.id))?.enabledPlugins).toBeNull();
    });

    test("stores an empty list distinctly from null", async () => {
      const conv = await createConversation("enabled-plugins-empty");
      await setConversationEnabledPlugins(conv.id, []);
      expect(await getConversationEnabledPlugins(conv.id)).toEqual([]);
    });

    test("a forked conversation carries the plugin selection", async () => {
      const conv = await createConversation("enabled-plugins-fork-source");
      await setConversationEnabledPlugins(conv.id, ["x", "y"]);
      await addMessage(conv.id, "user", "hi");

      const forked = await forkConversation({ conversationId: conv.id });
      expect(await getConversationEnabledPlugins(forked.id)).toEqual([
        "x",
        "y",
      ]);
    });
  },
);
