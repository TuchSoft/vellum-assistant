//! Thin napi binding around `lingua` for the WS-27 search index.
//!
//! Only what the index needs: detect one text, detect a batch, and the
//! per-language confidence values. The compiled language set is fixed at build
//! time (the twelve languages the instance declares); `supported_languages`
//! reports it so a caller can refuse an unsupported configuration instead of
//! silently degrading.
//!
//! Detection comes in two shapes. The plain functions consider every compiled
//! language. The `*_with_languages` variants take the caller's candidate set
//! and build a detector restricted to it, so a language outside the set can
//! never be returned: a short Italian query cannot be classified Portuguese
//! when Portuguese is not a candidate. An unknown code is an error, not a
//! silent omission, because the caller's configuration would otherwise be
//! honored only in part.
//!
//! `minimum_relative_distance` is quantized to the three values Fase A
//! measures (0.0, 0.1, 0.2) and a detector is built once per (language set,
//! distance) pair and cached: building a detector loads the language models.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use lingua::{Language, LanguageDetector, LanguageDetectorBuilder};
use napi_derive::napi;

const LANGUAGES: [Language; 12] = [
    Language::Italian,
    Language::English,
    Language::French,
    Language::German,
    Language::Spanish,
    Language::Portuguese,
    Language::Dutch,
    Language::Polish,
    Language::Romanian,
    Language::Swedish,
    Language::Danish,
    Language::Estonian,
];

fn code(language: Language) -> String {
    language.iso_code_639_1().to_string()
}

/// The compiled languages as a comma-separated list, for error messages.
fn supported_codes() -> String {
    LANGUAGES.iter().map(|l| code(*l)).collect::<Vec<_>>().join(", ")
}

/// Collapse a requested distance to the nearest built-in value.
fn quantize(minimum_relative_distance: f64) -> f64 {
    if minimum_relative_distance >= 0.2 {
        0.2
    } else if minimum_relative_distance >= 0.1 {
        0.1
    } else {
        0.0
    }
}

/// Map the caller's ISO 639-1 codes to compiled languages.
///
/// An empty list means "every compiled language". A code this detector was not
/// compiled with is an error: the alternative (dropping it) would let the
/// caller believe the restriction was honored.
fn resolve_languages(codes: &[String]) -> Result<Vec<Language>, String> {
    if codes.is_empty() {
        return Ok(LANGUAGES.to_vec());
    }
    let mut resolved: Vec<Language> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    for raw in codes {
        let normalized = raw.trim().to_lowercase();
        match LANGUAGES
            .iter()
            .copied()
            .find(|language| code(*language) == normalized)
        {
            Some(language) => {
                if !resolved.contains(&language) {
                    resolved.push(language);
                }
            }
            None => unknown.push(raw.clone()),
        }
    }
    if !unknown.is_empty() {
        return Err(format!(
            "unsupported language(s) {:?}: this detector was compiled with {}",
            unknown,
            supported_codes()
        ));
    }
    Ok(resolved)
}

/// The detector for a language set and a distance, built once and shared.
///
/// The number of distinct sets is small (the configured list and the full
/// compiled set), so the cache is unbounded by design; what it must avoid is
/// rebuilding, because each build loads the language models.
fn detector_for_languages(
    languages: &[Language],
    minimum_relative_distance: f64,
) -> Arc<LanguageDetector> {
    static DETECTORS: OnceLock<Mutex<HashMap<String, Arc<LanguageDetector>>>> = OnceLock::new();
    let distance = quantize(minimum_relative_distance);
    let mut codes: Vec<String> = languages.iter().map(|language| code(*language)).collect();
    codes.sort();
    let key = format!("{}|{}", codes.join(","), distance);
    let cache = DETECTORS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(detector) = guard.get(&key) {
        return Arc::clone(detector);
    }
    let detector = Arc::new(
        LanguageDetectorBuilder::from_languages(languages)
            .with_minimum_relative_distance(distance)
            .build(),
    );
    guard.insert(key, Arc::clone(&detector));
    detector
}

fn build(minimum_relative_distance: f64) -> LanguageDetector {
    LanguageDetectorBuilder::from_languages(&LANGUAGES)
        .with_minimum_relative_distance(minimum_relative_distance)
        .build()
}

fn detector_for(minimum_relative_distance: f64) -> &'static LanguageDetector {
    static ZERO: OnceLock<LanguageDetector> = OnceLock::new();
    static TENTH: OnceLock<LanguageDetector> = OnceLock::new();
    static FIFTH: OnceLock<LanguageDetector> = OnceLock::new();
    if minimum_relative_distance >= 0.2 {
        FIFTH.get_or_init(|| build(0.2))
    } else if minimum_relative_distance >= 0.1 {
        TENTH.get_or_init(|| build(0.1))
    } else {
        ZERO.get_or_init(|| build(0.0))
    }
}

#[napi(object)]
pub struct LanguageConfidence {
    pub language: String,
    pub confidence: f64,
}

/// The languages this addon was compiled with, as ISO 639-1 codes.
#[napi]
pub fn supported_languages() -> Vec<String> {
    LANGUAGES.iter().map(|l| code(*l)).collect()
}

/// Detect one text. `None` means "no language cleared the distance".
#[napi]
pub fn detect(text: String) -> Option<String> {
    detector_for(0.0).detect_language_of(text).map(code)
}

/// Detect one text with a caller-chosen `minimum_relative_distance`.
#[napi]
pub fn detect_with_min_distance(text: String, minimum_relative_distance: f64) -> Option<String> {
    detector_for(minimum_relative_distance)
        .detect_language_of(text)
        .map(code)
}

/// Detect a batch in parallel. One entry per input, same order.
#[napi]
pub fn detect_batch(texts: Vec<String>) -> Vec<Option<String>> {
    detector_for(0.0)
        .detect_languages_in_parallel_of(&texts)
        .into_iter()
        .map(|l| l.map(code))
        .collect()
}

/// Per-language confidence values for one text, highest first.
#[napi]
pub fn confidence_values(text: String) -> Vec<LanguageConfidence> {
    detector_for(0.0)
        .compute_language_confidence_values(text)
        .into_iter()
        .map(|(language, confidence)| LanguageConfidence {
            language: code(language),
            confidence,
        })
        .collect()
}

/// Detect one text considering only `languages` (ISO 639-1).
///
/// An empty `languages` list means every compiled language. A code the addon
/// was not compiled with throws: the caller's configuration is honored whole or
/// reported.
#[napi]
pub fn detect_with_languages(
    text: String,
    languages: Vec<String>,
    minimum_relative_distance: f64,
) -> napi::Result<Option<String>> {
    let candidates = resolve_languages(&languages).map_err(napi::Error::from_reason)?;
    Ok(detector_for_languages(&candidates, minimum_relative_distance)
        .detect_language_of(text)
        .map(code))
}

/// Detect a batch considering only `languages`; one entry per input, same order.
///
/// Same contract as [`detect_with_languages`] for the candidate set.
#[napi]
pub fn detect_batch_with_languages(
    texts: Vec<String>,
    languages: Vec<String>,
    minimum_relative_distance: f64,
) -> napi::Result<Vec<Option<String>>> {
    let candidates = resolve_languages(&languages).map_err(napi::Error::from_reason)?;
    Ok(detector_for_languages(&candidates, minimum_relative_distance)
        .detect_languages_in_parallel_of(&texts)
        .into_iter()
        .map(|language| language.map(code))
        .collect())
}
