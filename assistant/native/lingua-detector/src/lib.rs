//! Thin napi binding around `lingua` for the WS-27 search index.
//!
//! Only what the index needs: detect one text, detect a batch, and the
//! per-language confidence values. The compiled language set is fixed at build
//! time (the twelve languages the instance declares); `supported_languages`
//! reports it so a caller can refuse an unsupported configuration instead of
//! silently degrading.
//!
//! `minimum_relative_distance` is quantized to the three values Fase A
//! measures (0.0, 0.1, 0.2) and the detector for each value is built once and
//! cached: building a detector loads the language models.

use std::sync::OnceLock;

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

fn code(language: Language) -> String {
    language.iso_code_639_1().to_string()
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
