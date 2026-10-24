/**
 * Unit tests for the lexical match mode: the `match` parameter parser and the
 * BM25 predicate it selects.
 *
 * The predicate is the whole behavior of `match` — `conjunction_mode => true`
 * requires every token, the plain form accepts any — so pinning the string here
 * keeps the choice visible without a Postgres round trip. The DB-backed
 * semantics (default is conjunction, `any` is opt-in) live in
 * `conversation-queries-search-postgres.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  lexicalMatchPredicate,
  parseLexicalMatchMode,
} from "../conversation-queries.js";

const CONJUNCTION = `l."body" @@@ paradedb.match('body', ?, conjunction_mode => true)`;
const PLAIN = `l."body" @@@ paradedb.match('body', ?)`;

describe("parseLexicalMatchMode", () => {
  test("defaults to all when the parameter is absent", () => {
    expect(parseLexicalMatchMode(undefined)).toBe("all");
  });

  test("treats blank and unknown values as all", () => {
    expect(parseLexicalMatchMode("")).toBe("all");
    expect(parseLexicalMatchMode("   ")).toBe("all");
    expect(parseLexicalMatchMode("all")).toBe("all");
    expect(parseLexicalMatchMode("sometimes")).toBe("all");
  });

  test("accepts any, case-insensitively", () => {
    expect(parseLexicalMatchMode("any")).toBe("any");
    expect(parseLexicalMatchMode("ANY")).toBe("any");
    expect(parseLexicalMatchMode(" any ")).toBe("any");
  });
});

describe("lexicalMatchPredicate", () => {
  test("all with two or more tokens requires every token", () => {
    expect(lexicalMatchPredicate("fatture pagate", "all")).toBe(CONJUNCTION);
    expect(lexicalMatchPredicate("come sincronizzo i file", "all")).toBe(
      CONJUNCTION,
    );
  });

  test("any with two or more tokens keeps the plain form", () => {
    expect(lexicalMatchPredicate("fatture pagate", "any")).toBe(PLAIN);
  });

  test("a single token is identical under both modes", () => {
    expect(lexicalMatchPredicate("backup", "all")).toBe(PLAIN);
    expect(lexicalMatchPredicate("backup", "any")).toBe(PLAIN);
  });

  test("token count comes from the encoder tokenizer, not whitespace", () => {
    // `C++` tokenizes to a single token, so there is nothing to conjoin.
    expect(lexicalMatchPredicate("C++", "all")).toBe(PLAIN);
    // Punctuation-only input has no tokens at all.
    expect(lexicalMatchPredicate("+++", "all")).toBe(PLAIN);
    // An apostrophe splits into two tokens under the shared tokenizer.
    expect(lexicalMatchPredicate("dell'ultima immagine", "all")).toBe(
      CONJUNCTION,
    );
  });
});
