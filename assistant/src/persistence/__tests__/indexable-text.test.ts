/**
 * Tests for {@link indexableTextOfRow}: the text a message contributes to the
 * lexical (search) index.
 *
 * The index answers message-content search over what a reader can read. It must
 * never carry the stored JSON envelope (block `type` keys, `tool_use_id`,
 * `image_url`, base64 payloads), and it must be empty when a row has no
 * readable text at all.
 */

import { describe, expect, test } from "bun:test";

import {
  indexableTextOfRow,
  projectPersistedRowText,
} from "../user-facing-content.js";

const json = (value: unknown): string => JSON.stringify(value);

describe("indexableTextOfRow", () => {
  test("returns the text of text blocks", () => {
    expect(
      indexableTextOfRow(json([{ type: "text", text: "ciao mondo" }]), null),
    ).toBe("ciao mondo");
  });

  test("returns only the readable part of a tool_result, never the envelope", () => {
    const text = indexableTextOfRow(
      json([
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: "Saved 2 facts to knowledge base.",
        },
      ]),
      null,
    );
    expect(text).toBe("Saved 2 facts to knowledge base.");
    expect(text).not.toContain("tool_result");
    expect(text).not.toContain("tool_use_id");
  });

  test("drops base64 payloads embedded in a tool_result", () => {
    const payload = "iVBORw0KGgo" + "A".repeat(600);
    const text = indexableTextOfRow(
      json([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: `bytes=516\ndata:image/png;base64,${payload}\ntotal len:\n72`,
        },
      ]),
      null,
    );
    expect(text).toContain("bytes=516");
    expect(text).toContain("total len:");
    expect(text).not.toContain("base64");
    expect(text).not.toContain("iVBORw0KGgo");
  });

  test("reads the text sub-blocks of a tool_result array and skips images", () => {
    const text = indexableTextOfRow(
      json([
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [
            { type: "text", text: "first line" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUg==",
              },
            },
            { type: "text", text: "second line" },
          ],
        },
      ]),
      null,
    );
    expect(text).toBe("first line\nsecond line");
    expect(text).not.toContain("iVBORw0KGgo");
  });

  test("drops image blocks entirely (no image_url, no base64)", () => {
    expect(
      indexableTextOfRow(
        json([
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUg==",
            },
          },
        ]),
        null,
      ),
    ).toBe("");
  });

  test("returns an empty string when a row has no readable text", () => {
    expect(
      indexableTextOfRow(
        json([
          {
            type: "tool_use",
            id: "tu_1",
            name: "bash",
            input: { command: "ls", token: "secret-value" },
          },
        ]),
        null,
      ),
    ).toBe("");
  });

  test("keeps the delivered message of a private row and drops the scratchpad", () => {
    const metadata = { assistantTextVisibility: "private" };
    const text = indexableTextOfRow(
      json([
        { type: "text", text: "private working notes" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "send_user_message",
          input: { message: "Ecco il risultato." },
        },
      ]),
      metadata,
    );
    expect(text).toBe("Ecco il risultato.");
    expect(text).not.toContain("private working notes");
  });

  test("keeps an unmarked row's text blocks as they are", () => {
    const text = indexableTextOfRow(
      json([
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ]),
      json({ assistantTextVisibility: "visible" }),
    );
    expect(text).toBe("part one\npart two");
  });

  test("returns a legacy plain-text row trimmed", () => {
    expect(indexableTextOfRow("  legacy plain text  ", null)).toBe(
      "legacy plain text",
    );
  });

  test("strips NUL characters a JSON escape can introduce", () => {
    expect(
      indexableTextOfRow(json([{ type: "text", text: "a\u0000b" }]), null),
    ).toBe("ab");
  });

  test("the raw stored JSON is what the buggy projection yields", () => {
    // Documents the defect this function replaces: `projectPersistedRowText`
    // hands the whole JSON envelope to the encoder for an unmarked row.
    const stored = json([
      { type: "tool_result", tool_use_id: "call_1", content: "hello" },
    ]);
    expect(projectPersistedRowText(stored, null)).toBe(stored);
    expect(projectPersistedRowText(stored, null)).toContain('"tool_use_id"');
  });
});
