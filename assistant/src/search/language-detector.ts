/**
 * Lazy access to the compiled `lingua` language detector.
 *
 * The detector is a native N-API addon (`assistant/native/lingua-detector`,
 * crate `lingua` 1.8.0) built for the image's target platform and copied into
 * the runtime image by `assistant/Dockerfile`. Its language models are ~150 MB
 * of resident memory once a detection runs, so the addon is loaded on the
 * FIRST detection and never at boot: an instance that never searches, or whose
 * rows all fall in the agnostic index, pays nothing.
 *
 * The addon is the one soft dependency of message search. If it is missing or
 * fails to load, detection returns `null` for everything and search keeps
 * working on the language-agnostic index, the single declared degradation.
 * The failure is logged once, loudly.
 *
 * Every call is guarded: a native throw becomes a logged `null` rather than a
 * failed indexing job or a failed search.
 *
 * Detection is candidate-set aware: when the caller passes the configured
 * `search.languages`, the addon restricts its detector to that subset, so a
 * language the instance does not care about can never be returned.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { getLogger } from "../util/logger.js";

const log = getLogger("language-detector");

/**
 * Where the addon lives relative to this module. The image copies the built
 * `.node` next to its crate, so the source tree and the runtime layout agree.
 */
const ADDON_PATH = fileURLToPath(
  new URL("../../native/lingua-detector/lingua_detector.node", import.meta.url),
);

/** How far into the text a removable scaffolding block may close. */
const PREFIX_WINDOW = 200;

/** Consecutive scaffolding blocks removed at most (headers can stack). */
const MAX_PREFIX_BLOCKS = 3;

/** The subset of the addon's surface this module uses. */
export interface LanguageDetector {
  /** ISO 639-1 codes this addon was compiled with. */
  supportedLanguages(): string[];
  /** Detect one text; `null` means no language cleared the distance. */
  detectWithMinDistance(
    text: string,
    minimumRelativeDistance: number,
  ): string | null;
  /** Detect a batch in parallel; one entry per input, same order. */
  detectBatch(texts: readonly string[]): Array<string | null>;
  /**
   * Detect one text considering only `languages` (ISO 639-1), so a language
   * outside the candidate set can never be returned. An empty list means every
   * compiled language. Optional: an addon built before the candidate set
   * existed has no such entry point, and detection then falls back to the
   * unrestricted call.
   */
  detectWithLanguages?(
    text: string,
    languages: readonly string[],
    minimumRelativeDistance: number,
  ): string | null;
  /** Batch form of {@link LanguageDetector.detectWithLanguages}. */
  detectBatchWithLanguages?(
    texts: readonly string[],
    languages: readonly string[],
    minimumRelativeDistance: number,
  ): Array<string | null>;
}

const loadModule = createRequire(import.meta.url);

let cached: LanguageDetector | null | undefined;

function load(): LanguageDetector | null {
  if (!existsSync(ADDON_PATH)) {
    log.error(
      { path: ADDON_PATH },
      "Language detector addon missing, message search stays language-agnostic",
    );
    return null;
  }
  try {
    const addon = loadModule(ADDON_PATH) as LanguageDetector;
    if (typeof addon.detectBatch !== "function") {
      log.error(
        { path: ADDON_PATH },
        "Language detector addon has no detectBatch, message search stays language-agnostic",
      );
      return null;
    }
    return addon;
  } catch (err) {
    log.error(
      { err, path: ADDON_PATH },
      "Language detector addon failed to load, message search stays language-agnostic",
    );
    return null;
  }
}

/**
 * The detector, loaded on first use, or `null` when it is unavailable. The
 * result is memoized in both directions: a missing addon is not re-probed on
 * every message.
 */
export function getLanguageDetector(): LanguageDetector | null {
  if (cached === undefined) {
    cached = load();
  }
  return cached;
}

/**
 * Test seam: install a detector (or force the unavailable state) and reset the
 * memoized load. Not for production use.
 */
export function setLanguageDetectorForTests(
  detector: LanguageDetector | null | undefined,
): void {
  cached = detector;
}

/**
 * Strip a leading scaffolding block before detection.
 *
 * A message that opens with `[Subagent "…" completed]` or
 * `<background_event …>` is Italian prose behind an English header, and the
 * header dominates the detection: the whole text comes back `en` with
 * confidence 1.0. The strip only feeds the detector: the indexed body is
 * untouched, so search still matches the header words.
 *
 * Only a block that CLOSES within the first {@link PREFIX_WINDOW} characters
 * is removed, so a message that merely starts with a bracket does not lose its
 * beginning.
 */
export function stripDetectionPrefix(text: string): string {
  let rest = text;
  for (let i = 0; i < MAX_PREFIX_BLOCKS; i++) {
    const window = rest.slice(0, PREFIX_WINDOW);
    const match = /^\s*(\[[^\]]*\]|<[^>]*>)/.exec(window);
    if (!match) {
      break;
    }
    rest = rest.slice(match[0].length).replace(/^\s+/, "");
  }
  return rest;
}

/**
 * Detect one text with the caller's candidate set.
 *
 * A non-empty `languages` list is handed to the addon, which builds and caches
 * a detector restricted to it: a language outside the set can never be
 * returned. An empty list, or an addon without the restricted entry point,
 * keeps the unrestricted behavior (every compiled language).
 */
function detectWithCandidates(
  detector: LanguageDetector,
  text: string,
  languages: readonly string[],
  minimumRelativeDistance: number,
): string | null {
  if (languages.length > 0 && detector.detectWithLanguages) {
    return detector.detectWithLanguages(
      text,
      languages,
      minimumRelativeDistance,
    );
  }
  return detector.detectWithMinDistance(text, minimumRelativeDistance);
}

/** Batch form of {@link detectWithCandidates}. */
function detectBatchWithCandidates(
  detector: LanguageDetector,
  texts: readonly string[],
  languages: readonly string[],
  minimumRelativeDistance: number,
): Array<string | null> {
  if (languages.length > 0 && detector.detectBatchWithLanguages) {
    return detector.detectBatchWithLanguages(
      texts,
      languages,
      minimumRelativeDistance,
    );
  }
  return detector.detectBatch(texts);
}

/**
 * Detect one document's language at `minimumRelativeDistance` 0.0: on the
 * write side a wrong language costs nothing (the agnostic index always
 * matches), so coverage wins over precision.
 *
 * `languages` is the candidate set (`search.languages`); empty means every
 * compiled language.
 */
export function detectDocumentLanguage(
  text: string,
  languages: readonly string[] = [],
): string | null {
  const detector = getLanguageDetector();
  if (!detector) {
    return null;
  }
  try {
    return detectWithCandidates(
      detector,
      stripDetectionPrefix(text),
      languages,
      0,
    );
  } catch (err) {
    log.warn({ err }, "Language detection failed for a document");
    return null;
  }
}

/**
 * Detect a batch of documents at distance 0.0. The addon runs the batch in
 * parallel; scaffolding prefixes are stripped here exactly as in
 * {@link detectDocumentLanguage}, and the same candidate set applies.
 */
export function detectDocumentLanguages(
  texts: readonly string[],
  languages: readonly string[] = [],
): Array<string | null> {
  const detector = getLanguageDetector();
  if (!detector) {
    return texts.map(() => null);
  }
  try {
    const detected = detectBatchWithCandidates(
      detector,
      texts.map((text) => stripDetectionPrefix(text)),
      languages,
      0,
    );
    return texts.map((_, index) => detected[index] ?? null);
  } catch (err) {
    log.warn({ err }, "Language detection failed for a batch");
    return texts.map(() => null);
  }
}

/**
 * Detect a query's language at the configured confidence floor. A `null`
 * result means "agnostic lane only". `languages` is the candidate set, exactly
 * as on the write side.
 */
export function detectQueryLanguage(
  text: string,
  minimumRelativeDistance: number,
  languages: readonly string[] = [],
): string | null {
  const detector = getLanguageDetector();
  if (!detector) {
    return null;
  }
  try {
    return detectWithCandidates(
      detector,
      text,
      languages,
      minimumRelativeDistance,
    );
  } catch (err) {
    log.warn({ err }, "Language detection failed for a query");
    return null;
  }
}

/** The compiled language set, or an empty list when the addon is unavailable. */
export function supportedLanguages(): string[] {
  const detector = getLanguageDetector();
  if (!detector) {
    return [];
  }
  try {
    return detector.supportedLanguages();
  } catch (err) {
    log.warn({ err }, "Language detector supportedLanguages() failed");
    return [];
  }
}
