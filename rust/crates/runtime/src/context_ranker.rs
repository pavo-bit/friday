//! Relevance-based context ranking for intelligent prompt construction.
//!
//! Instead of blindly truncating instruction files by character limit, this
//! module scores each context chunk against the current user query using a
//! lightweight TF-IDF–inspired algorithm. This ensures the most relevant
//! project context occupies the limited token budget.
//!
//! No external ML dependencies required — pure Rust, zero overhead.

use std::collections::{HashMap, HashSet};


/// A scored context chunk ready for ranked injection into the system prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoredChunk {
    /// Original source path for attribution.
    pub source: String,
    /// The text content of this chunk.
    pub content: String,
    /// Relevance score (higher = more relevant to the query). Range: 0.0..1.0
    pub score: f64,
}

/// Configuration for the context ranking pipeline.
#[derive(Debug, Clone)]
pub struct RankingConfig {
    /// Maximum number of chunks to return after ranking.
    pub max_chunks: usize,
    /// Target character budget for all ranked output combined.
    pub char_budget: usize,
    /// Minimum score threshold; chunks below this are discarded.
    pub min_score: f64,
    /// Approximate characters per chunk when splitting large files.
    pub chunk_size: usize,
    /// Overlap characters between consecutive chunks for continuity.
    pub chunk_overlap: usize,
}

impl Default for RankingConfig {
    fn default() -> Self {
        Self {
            max_chunks: 20,
            char_budget: 12_000,
            min_score: 0.01,
            chunk_size: 800,
            chunk_overlap: 100,
        }
    }
}

/// Ranks context files against a query using term-frequency relevance scoring.
///
/// This is a zero-dependency alternative to vector embeddings that still
/// dramatically outperforms naive truncation. The algorithm:
///
/// 1. Tokenizes the query into normalized terms
/// 2. Splits each context file into overlapping chunks
/// 3. Scores each chunk by weighted term frequency relative to the query
/// 4. Boosts scores for path matches, heading proximity, and term density
/// 5. Returns the top-K chunks within the character budget
#[must_use]
pub fn rank_context(
    query: &str,
    files: &[(String, String)], // (path, content) pairs
    config: &RankingConfig,
) -> Vec<ScoredChunk> {
    if query.trim().is_empty() || files.is_empty() {
        // No query to rank against — return files in original order, truncated
        return files
            .iter()
            .map(|(path, content)| ScoredChunk {
                source: path.clone(),
                content: truncate(content, config.chunk_size),
                score: 0.5,
            })
            .take(config.max_chunks)
            .collect();
    }

    let query_terms = tokenize(query);
    if query_terms.is_empty() {
        return Vec::new();
    }

    // Build inverse document frequency from the entire corpus
    let total_chunks_estimate: usize = files
        .iter()
        .map(|(_, content)| (content.len() / config.chunk_size.max(1)).max(1))
        .sum();
    let idf = compute_idf(&query_terms, files, config.chunk_size);

    // Score every chunk from every file
    let mut all_chunks: Vec<ScoredChunk> = Vec::with_capacity(total_chunks_estimate);

    for (path, content) in files {
        let chunks = split_into_chunks(content, config.chunk_size, config.chunk_overlap);
        let path_bonus = path_relevance_boost(path, &query_terms);

        for chunk_text in chunks {
            let tf_score = compute_tf_idf(&chunk_text, &query_terms, &idf);
            let heading_bonus = heading_proximity_boost(&chunk_text, &query_terms);
            let density_bonus = term_density_boost(&chunk_text, &query_terms);

            let combined = (tf_score * 0.5) + (heading_bonus * 0.2)
                + (density_bonus * 0.15) + (path_bonus * 0.15);

            if combined >= config.min_score {
                all_chunks.push(ScoredChunk {
                    source: path.clone(),
                    content: chunk_text,
                    score: combined.min(1.0),
                });
            }
        }
    }

    // Sort descending by score
    all_chunks.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    // Select top chunks within budget
    let mut selected = Vec::new();
    let mut remaining_budget = config.char_budget;

    for chunk in all_chunks {
        if selected.len() >= config.max_chunks || remaining_budget == 0 {
            break;
        }
        let char_count = chunk.content.chars().count();
        if char_count <= remaining_budget {
            remaining_budget = remaining_budget.saturating_sub(char_count);
            selected.push(chunk);
        }
    }

    selected
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|token| token.len() >= 2)
        .filter(|token| !is_stop_word(token))
        .map(String::from)
        .collect()
}

fn is_stop_word(word: &str) -> bool {
    matches!(
        word,
        "the" | "and" | "for" | "are" | "but" | "not" | "you"
            | "all" | "can" | "had" | "her" | "was" | "one" | "our"
            | "out" | "has" | "have" | "with" | "this" | "that" | "from"
            | "they" | "been" | "some" | "what" | "when" | "who" | "will"
            | "more" | "than" | "them" | "its" | "into" | "only" | "come"
            | "made" | "after" | "use" | "two" | "how" | "each" | "which"
            | "do" | "if" | "is" | "it" | "be" | "as" | "in" | "on"
            | "so" | "we" | "an" | "my" | "of" | "to" | "or" | "no"
            | "he" | "by" | "at" | "me"
    )
}

// ---------------------------------------------------------------------------
// TF-IDF Scoring
// ---------------------------------------------------------------------------

fn compute_idf(
    query_terms: &[String],
    files: &[(String, String)],
    chunk_size: usize,
) -> HashMap<String, f64> {
    let mut doc_frequency: HashMap<String, usize> = HashMap::new();
    let mut total_docs = 0usize;

    for (_, content) in files {
        let chunks = split_into_chunks(content, chunk_size, 0);
        for chunk in &chunks {
            total_docs += 1;
            let unique_terms: HashSet<String> = tokenize(chunk).into_iter().collect();
            for term in query_terms {
                if unique_terms.contains(term) {
                    *doc_frequency.entry(term.clone()).or_insert(0) += 1;
                }
            }
        }
    }

    let total = total_docs.max(1) as f64;
    query_terms
        .iter()
        .map(|term| {
            let df = *doc_frequency.get(term).unwrap_or(&0) as f64;
            let idf_value = ((total + 1.0) / (df + 1.0)).ln() + 1.0;
            (term.clone(), idf_value)
        })
        .collect()
}

fn compute_tf_idf(
    chunk: &str,
    query_terms: &[String],
    idf: &HashMap<String, f64>,
) -> f64 {
    let chunk_tokens = tokenize(chunk);
    if chunk_tokens.is_empty() {
        return 0.0;
    }

    let total = chunk_tokens.len() as f64;
    let mut term_counts: HashMap<&str, usize> = HashMap::new();
    for token in &chunk_tokens {
        *term_counts.entry(token.as_str()).or_insert(0) += 1;
    }

    let mut score = 0.0;
    for term in query_terms {
        let tf = *term_counts.get(term.as_str()).unwrap_or(&0) as f64 / total;
        let idf_value = idf.get(term).copied().unwrap_or(1.0);
        score += tf * idf_value;
    }

    // Normalize by number of query terms to keep score in reasonable range
    score / query_terms.len().max(1) as f64
}

// ---------------------------------------------------------------------------
// Boost Functions
// ---------------------------------------------------------------------------

/// Boost chunks where query terms appear in markdown headings.
fn heading_proximity_boost(chunk: &str, query_terms: &[String]) -> f64 {
    let mut boost: f64 = 0.0;
    for line in chunk.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let heading_lower = trimmed.to_lowercase();
            for term in query_terms {
                if heading_lower.contains(term.as_str()) {
                    boost += 0.3;
                }
            }
        }
    }
    boost.min(1.0)
}

/// Boost when the file path itself matches query terms.
fn path_relevance_boost(path: &str, query_terms: &[String]) -> f64 {
    let path_lower = path.to_lowercase();
    let path_tokens: HashSet<String> = path_lower
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|s| s.len() >= 2)
        .map(String::from)
        .collect();

    let matches = query_terms
        .iter()
        .filter(|term| path_tokens.contains(term.as_str()))
        .count();

    (matches as f64 / query_terms.len().max(1) as f64).min(1.0)
}

/// Boost chunks with higher concentration of query terms (density).
fn term_density_boost(chunk: &str, query_terms: &[String]) -> f64 {
    let chunk_lower = chunk.to_lowercase();
    let total_matches: usize = query_terms
        .iter()
        .map(|term| chunk_lower.matches(term.as_str()).count())
        .sum();
    let word_count = chunk.split_whitespace().count().max(1);

    // Density = matches per 100 words, capped at 1.0
    ((total_matches as f64 / word_count as f64) * 10.0).min(1.0)
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

fn split_into_chunks(content: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.chars().count() <= chunk_size {
        return vec![trimmed.to_string()];
    }

    // Prefer splitting on paragraph boundaries
    let paragraphs: Vec<&str> = trimmed.split("\n\n").collect();
    let mut chunks = Vec::new();
    let mut current = String::new();

    for para in paragraphs {
        if current.chars().count() + para.chars().count() + 2 > chunk_size && !current.is_empty() {
            chunks.push(current.clone());
            // Overlap: keep the last `overlap` chars
            if overlap > 0 && current.chars().count() > overlap {
                current = current
                    .chars()
                    .skip(current.chars().count() - overlap)
                    .collect();
            } else {
                current.clear();
            }
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }

    chunks
}

fn truncate(content: &str, max_chars: usize) -> String {
    let trimmed = content.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let mut out: String = trimmed.chars().take(max_chars).collect();
        out.push_str("\n\n[truncated]");
        out
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_and_removes_stop_words() {
        let tokens = tokenize("How to fix the Rust build errors");
        assert!(tokens.contains(&"fix".to_string()));
        assert!(tokens.contains(&"rust".to_string()));
        assert!(tokens.contains(&"build".to_string()));
        assert!(tokens.contains(&"errors".to_string()));
        assert!(!tokens.contains(&"the".to_string()));
        assert!(!tokens.contains(&"how".to_string()));
        assert!(!tokens.contains(&"to".to_string()));
    }

    #[test]
    fn ranks_relevant_chunk_higher() {
        let files = vec![
            ("docs/deploy.md".to_string(), "Deploying to AWS with Terraform modules and ECS clusters. Infrastructure setup guide.".to_string()),
            ("docs/testing.md".to_string(), "Unit testing in Rust with cargo test. How to write integration tests and fix build errors.".to_string()),
            ("docs/style.md".to_string(), "Code style guidelines for the project. Use rustfmt for formatting.".to_string()),
        ];

        let config = RankingConfig::default();
        let ranked = rank_context("fix rust build errors", &files, &config);

        assert!(!ranked.is_empty());
        // The testing doc should rank highest because it matches the query terms
        assert!(ranked[0].source.contains("testing"));
    }

    #[test]
    fn respects_character_budget() {
        let big_content = "x ".repeat(5000);
        let files = vec![
            ("a.md".to_string(), big_content.clone()),
            ("b.md".to_string(), big_content),
        ];

        let config = RankingConfig {
            char_budget: 2000,
            ..RankingConfig::default()
        };
        let ranked = rank_context("test query", &files, &config);

        let total: usize = ranked.iter().map(|c| c.content.chars().count()).sum();
        assert!(total <= 2000);
    }

    #[test]
    fn empty_query_returns_files_in_order() {
        let files = vec![
            ("first.md".to_string(), "First file content".to_string()),
            ("second.md".to_string(), "Second file content".to_string()),
        ];
        let config = RankingConfig::default();
        let ranked = rank_context("", &files, &config);
        assert_eq!(ranked.len(), 2);
        assert!(ranked[0].source.contains("first"));
    }

    #[test]
    fn heading_boost_works() {
        let boost = heading_proximity_boost("# Rust Build Guide\nSome content here", &["rust".to_string(), "build".to_string()]);
        assert!(boost > 0.0);
    }

    #[test]
    fn splits_large_content_into_chunks() {
        let content = (0..20).map(|i| format!("Paragraph {} with some content.", i)).collect::<Vec<_>>().join("\n\n");
        let chunks = split_into_chunks(&content, 200, 50);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            // Each chunk should be roughly within the size limit (allowing some flexibility for paragraph boundaries)
            assert!(chunk.chars().count() <= 400, "chunk too large: {} chars", chunk.chars().count());
        }
    }

    #[test]
    fn path_boost_matches_query_terms() {
        let boost = path_relevance_boost("src/runtime/sandbox.rs", &["sandbox".to_string(), "runtime".to_string()]);
        assert!(boost > 0.5);

        let no_boost = path_relevance_boost("src/config/theme.rs", &["sandbox".to_string()]);
        assert!(no_boost < 0.01);
    }
}
