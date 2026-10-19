import { beforeEach, describe, expect, test } from "bun:test";

import {
  createMockProvider,
  textResponse,
} from "../__tests__/helpers/mock-provider.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import type { Message, Provider } from "../providers/types.js";
import { type AgentEvent, AgentLoop } from "./loop.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Say something" }],
};

function buildLoop(provider: Provider): AgentLoop {
  return new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId: "conversation-123",
    tools: [],
  });
}

describe("AgentLoop: repetition guard", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("ends the turn with a repetition error when the model loops", async () => {
    const { provider, calls } = createMockProvider([
      textResponse("a".repeat(400)),
    ]);
    const events: AgentEvent[] = [];
    const loop = buildLoop(provider);

    await loop.run({
      requestId: "request-loop",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Exactly one provider call: the loop-guard trip must not be resumed.
    expect(calls).toHaveLength(1);

    const exits = events.filter(
      (event): event is Extract<AgentEvent, { type: "agent_loop_exit" }> =>
        event.type === "agent_loop_exit",
    );
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe("error");

    const errors = events.filter(
      (event): event is Extract<AgentEvent, { type: "error" }> =>
        event.type === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error.name).toBe("LoopDetectedError");

    // The trip is not a provider rejection, so no provider_error is emitted.
    expect(
      events.filter((event) => event.type === "provider_error"),
    ).toHaveLength(0);
  });

  test("leaves a normal reply untouched", async () => {
    const reply = "Hello, this is a normal reply with no repetition at all.";
    const { provider, calls } = createMockProvider([textResponse(reply)]);
    const events: AgentEvent[] = [];
    const loop = buildLoop(provider);

    await loop.run({
      requestId: "request-ok",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);

    const exits = events.filter(
      (event): event is Extract<AgentEvent, { type: "agent_loop_exit" }> =>
        event.type === "agent_loop_exit",
    );
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe("no_tool_calls");

    const text = events
      .filter(
        (event): event is Extract<AgentEvent, { type: "text_delta" }> =>
          event.type === "text_delta",
      )
      .map((event) => event.text)
      .join("");
    expect(text).toContain(reply);
  });

  test("does not trip on a report with padded table rows", async () => {
    const reply = [
      "## Report",
      "",
      "```",
      "      | assignsubmission_file_maxsizebytes  | 10485760               |",
      "      | assignsubmission_file_maxfiles      | 1                      |",
      "```",
      "",
      "Done.",
    ].join("\n");
    const { provider, calls } = createMockProvider([textResponse(reply)]);
    const events: AgentEvent[] = [];
    const loop = buildLoop(provider);

    await loop.run({
      requestId: "request-padding",
      messages: [userMessage],
      onEvent: (event) => {
        events.push(event);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    expect(calls).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);

    const exits = events.filter(
      (event): event is Extract<AgentEvent, { type: "agent_loop_exit" }> =>
        event.type === "agent_loop_exit",
    );
    expect(exits).toHaveLength(1);
    expect(exits[0].reason).toBe("no_tool_calls");
  });
});
