/**
 * Tests for {@link hasLexicalTokens}: the gate that decides whether a search
 * query can be served by message-content matching at all.
 *
 * The gate must agree with the sparse tokenizer (`tokenize`, Unicode-aware
 * `\p{L}\p{N}`), not with an ASCII-only character class. A query in a
 * non-Latin script is searchable; a one-character query is not (the encoder
 * would emit a single noisy token for it).
 */

import { describe, expect, test } from "bun:test";

import { hasLexicalTokens } from "../conversation-queries.js";

describe("hasLexicalTokens", () => {
  test("accepts a Latin word", () => {
    expect(hasLexicalTokens("fattura")).toBe(true);
  });

  test("accepts an accented word", () => {
    expect(hasLexicalTokens("città")).toBe(true);
    expect(hasLexicalTokens("perché")).toBe(true);
  });

  test("accepts a word in a non-Latin script", () => {
    expect(hasLexicalTokens("привет")).toBe(true);
    expect(hasLexicalTokens("你好")).toBe(true);
    expect(hasLexicalTokens("こんにちは")).toBe(true);
  });

  test("rejects a query whose only token is one character", () => {
    expect(hasLexicalTokens("C++")).toBe(false);
    expect(hasLexicalTokens("a")).toBe(false);
    expect(hasLexicalTokens("你")).toBe(false);
  });

  test("rejects punctuation-only and empty input", () => {
    expect(hasLexicalTokens("...")).toBe(false);
    expect(hasLexicalTokens("   ")).toBe(false);
    expect(hasLexicalTokens("")).toBe(false);
  });

  test("keeps the current behavior for mixed identifier-like input", () => {
    expect(hasLexicalTokens("fattura_2024")).toBe(true);
    expect(hasLexicalTokens("file-name")).toBe(true);
  });
});
