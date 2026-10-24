/**
 * Unit tests for the language lane's configuration and detection seams.
 *
 * The native addon is replaced with an in-process fake: these tests pin the
 * rules around it (what a detected language must pass to reach an index, what
 * a declared language must satisfy at startup, what the detector sees), not
 * `lingua`'s accuracy, which the evaluation measures.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { AssistantConfig } from "../../config/types.js";
import {
  detectDocumentLanguage,
  detectDocumentLanguages,
  detectQueryLanguage,
  type LanguageDetector,
  setLanguageDetectorForTests,
  stripDetectionPrefix,
  supportedLanguages,
} from "../language-detector.js";
import {
  assertSearchLanguageConfiguration,
  languageForIndexing,
  normalizeLanguageCodes,
  resolveIndexLanguage,
  searchLanguageCandidates,
} from "../language-index.js";

/** A detector whose `detect` answers from a fixed map, keyed by substring. */
function fakeDetector(
  bySubstring: Array<[string, string]>,
  supported: string[] = ["it", "en", "et"],
): LanguageDetector {
  const detect = (text: string): string | null => {
    for (const [needle, code] of bySubstring) {
      if (text.includes(needle)) {
        return code;
      }
    }
    return null;
  };
  return {
    supportedLanguages: () => supported,
    detectWithMinDistance: (text: string) => detect(text),
    detectBatch: (texts: readonly string[]) =>
      texts.map((text) => detect(text)),
  };
}

function configWith(
  search: Partial<AssistantConfig["search"]>,
): AssistantConfig {
  return {
    search: {
      lexicalStore: "postgres",
      thinkingIndexMaxChars: 200,
      languages: [],
      queryMinRelativeDistance: 0.1,
      ...search,
    },
  } as AssistantConfig;
}

afterEach(() => {
  setLanguageDetectorForTests(undefined);
});

describe("stripDetectionPrefix", () => {
  test("removes a bracketed scaffolding header", () => {
    expect(
      stripDetectionPrefix('[Subagent "x" completed] le fatture sono pagate'),
    ).toBe("le fatture sono pagate");
  });

  test("removes a tag header", () => {
    expect(stripDetectionPrefix("<background_event id=1> testo vero")).toBe(
      "testo vero",
    );
  });

  test("removes stacked headers", () => {
    expect(stripDetectionPrefix("[a] <b> corpo")).toBe("corpo");
  });

  test("leaves text without a header untouched", () => {
    expect(stripDetectionPrefix("le fatture sono pagate")).toBe(
      "le fatture sono pagate",
    );
  });

  test("keeps the text when the bracket never closes inside the window", () => {
    const long = `[${"x".repeat(300)}`;
    expect(stripDetectionPrefix(long)).toBe(long);
  });
});

describe("supportedLanguages / detection", () => {
  test("reports nothing when the addon is unavailable", () => {
    setLanguageDetectorForTests(null);
    expect(supportedLanguages()).toEqual([]);
    expect(detectDocumentLanguage("le fatture")).toBeNull();
    expect(detectDocumentLanguages(["a", "b"])).toEqual([null, null]);
  });

  test("strips the prefix before detecting, in both single and batch form", () => {
    const seen: string[] = [];
    setLanguageDetectorForTests({
      supportedLanguages: () => ["it"],
      detectWithMinDistance: (text: string) => {
        seen.push(text);
        return "it";
      },
      detectBatch: (texts: readonly string[]) => {
        seen.push(...texts);
        return texts.map(() => "it");
      },
    });
    detectDocumentLanguage("[Subagent] le fatture");
    detectDocumentLanguages(["[Subagent] le fatture"]);
    expect(seen).toEqual(["le fatture", "le fatture"]);
  });

  test("a native throw becomes null instead of propagating", () => {
    setLanguageDetectorForTests({
      supportedLanguages: () => ["it"],
      detectWithMinDistance: () => {
        throw new Error("native boom");
      },
      detectBatch: () => {
        throw new Error("native boom");
      },
    });
    expect(detectDocumentLanguage("x")).toBeNull();
    expect(detectDocumentLanguages(["x"])).toEqual([null]);
  });
});

describe("candidate set", () => {
  /** A detector that records the candidate list it was handed. */
  function recordingDetector(answer: string | null): {
    detector: LanguageDetector;
    single: Array<readonly string[]>;
    batch: Array<readonly string[]>;
    unrestricted: number;
  } {
    const single: Array<readonly string[]> = [];
    const batch: Array<readonly string[]> = [];
    const state = { unrestricted: 0 };
    return {
      single,
      batch,
      get unrestricted() {
        return state.unrestricted;
      },
      detector: {
        supportedLanguages: () => ["it", "en", "et"],
        detectWithMinDistance: () => {
          state.unrestricted++;
          return answer;
        },
        detectBatch: (texts: readonly string[]) => {
          state.unrestricted++;
          return texts.map(() => answer);
        },
        detectWithLanguages: (_text: string, languages: readonly string[]) => {
          single.push(languages);
          return answer;
        },
        detectBatchWithLanguages: (
          texts: readonly string[],
          languages: readonly string[],
        ) => {
          batch.push(languages);
          return texts.map(() => answer);
        },
      },
    };
  }

  test("the configured list is handed to the detector on the write path", () => {
    const recorder = recordingDetector("it");
    setLanguageDetectorForTests(recorder.detector);
    expect(
      languageForIndexing(
        "le fatture",
        configWith({ languages: ["IT", "en"] }),
      ),
    ).toBe("it");
    expect(recorder.single).toEqual([["it", "en"]]);
    expect(recorder.unrestricted).toBe(0);
  });

  test("the batch and query paths carry the same candidate set", () => {
    const recorder = recordingDetector("en");
    setLanguageDetectorForTests(recorder.detector);
    detectDocumentLanguages(["a", "b"], ["it", "en"]);
    detectQueryLanguage("invoices", 0.1, ["it", "en"]);
    expect(recorder.batch).toEqual([["it", "en"]]);
    expect(recorder.single).toEqual([["it", "en"]]);
    expect(recorder.unrestricted).toBe(0);
  });

  test("an empty list keeps the unrestricted call", () => {
    const recorder = recordingDetector("it");
    setLanguageDetectorForTests(recorder.detector);
    expect(detectDocumentLanguage("le fatture")).toBe("it");
    expect(detectDocumentLanguages(["a"])).toEqual(["it"]);
    expect(detectQueryLanguage("fatture", 0.1)).toBe("it");
    expect(recorder.single).toEqual([]);
    expect(recorder.batch).toEqual([]);
    expect(recorder.unrestricted).toBe(3);
  });

  test("an addon without the restricted entry point falls back to the unrestricted call", () => {
    let calls = 0;
    setLanguageDetectorForTests({
      supportedLanguages: () => ["it", "en"],
      detectWithMinDistance: () => {
        calls++;
        return "it";
      },
      detectBatch: (texts: readonly string[]) => texts.map(() => "it"),
    });
    expect(detectDocumentLanguage("le fatture", ["it", "en"])).toBe("it");
    expect(calls).toBe(1);
  });

  test("a native throw on the restricted call still degrades to null", () => {
    setLanguageDetectorForTests({
      supportedLanguages: () => ["it", "en"],
      detectWithMinDistance: () => "it",
      detectBatch: (texts: readonly string[]) => texts.map(() => "it"),
      detectWithLanguages: () => {
        throw new Error('unsupported language(s) ["ja"]');
      },
      detectBatchWithLanguages: () => {
        throw new Error('unsupported language(s) ["ja"]');
      },
    });
    expect(detectDocumentLanguage("x", ["it", "en"])).toBeNull();
    expect(detectDocumentLanguages(["x"], ["it", "en"])).toEqual([null]);
    expect(detectQueryLanguage("x", 0.1, ["it", "en"])).toBeNull();
  });
});

describe("normalizeLanguageCodes", () => {
  test("trims, lowercases and dedupes", () => {
    expect(normalizeLanguageCodes([" IT ", "it", "", "en"])).toEqual([
      "it",
      "en",
    ]);
  });

  test("the configured list is the candidate set, normalized", () => {
    expect(
      searchLanguageCandidates(configWith({ languages: [" IT ", "en", "it"] })),
    ).toEqual(["it", "en"]);
    expect(searchLanguageCandidates(configWith({ languages: [] }))).toEqual([]);
  });
});

describe("assertSearchLanguageConfiguration", () => {
  test("an empty list needs no detector and never throws", () => {
    setLanguageDetectorForTests(null);
    expect(() =>
      assertSearchLanguageConfiguration(configWith({ languages: [] })),
    ).not.toThrow();
  });

  test("accepts a declared language the detector supports", () => {
    setLanguageDetectorForTests(fakeDetector([]));
    expect(() =>
      assertSearchLanguageConfiguration(
        configWith({ languages: ["it", "EN"] }),
      ),
    ).not.toThrow();
  });

  test("refuses a language the detector was not compiled with, listing the supported set", () => {
    setLanguageDetectorForTests(fakeDetector([], ["it", "en"]));
    expect(() =>
      assertSearchLanguageConfiguration(
        configWith({ languages: ["it", "ja"] }),
      ),
    ).toThrow(/unsupported language\(s\): ja\..*en, it/s);
  });

  test("refuses a malformed code", () => {
    setLanguageDetectorForTests(fakeDetector([]));
    expect(() =>
      assertSearchLanguageConfiguration(configWith({ languages: ["it-IT"] })),
    ).toThrow(/unsupported language\(s\): it-it/);
  });

  test("a missing detector is the declared degradation, not a failed boot", () => {
    setLanguageDetectorForTests(null);
    expect(() =>
      assertSearchLanguageConfiguration(configWith({ languages: ["it"] })),
    ).not.toThrow();
  });
});

describe("languageForIndexing / resolveIndexLanguage", () => {
  test("returns the detected language when it has an index", () => {
    setLanguageDetectorForTests(fakeDetector([["fatture", "it"]]));
    expect(
      languageForIndexing("le fatture", configWith({ languages: [] })),
    ).toBe("it");
  });

  test("returns null for a detected language with no stemmer", () => {
    setLanguageDetectorForTests(fakeDetector([["tere", "et"]]));
    expect(languageForIndexing("tere", configWith({}))).toBeNull();
    expect(resolveIndexLanguage("et", configWith({}))).toBeNull();
  });

  test("returns null when the detected language is outside the configured list", () => {
    setLanguageDetectorForTests(fakeDetector([["fatture", "it"]]));
    expect(
      languageForIndexing("le fatture", configWith({ languages: ["en"] })),
    ).toBeNull();
    expect(
      resolveIndexLanguage("it", configWith({ languages: ["en"] })),
    ).toBeNull();
  });

  test("returns null when no language cleared the floor", () => {
    setLanguageDetectorForTests(fakeDetector([]));
    expect(languageForIndexing("???", configWith({}))).toBeNull();
    expect(resolveIndexLanguage(null, configWith({}))).toBeNull();
  });
});
