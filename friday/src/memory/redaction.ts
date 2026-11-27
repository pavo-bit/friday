// ============================================================
// FRIDAY — Secret Redaction Utility
// Prevents passwords, tokens, and API keys from entering memory/logs
// ============================================================

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, replacement: '$1[REDACTED]' },
  { pattern: /\b(sk-or-v1-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/g, replacement: '[REDACTED_KEY]' },
  { pattern: /\b(ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, replacement: '[REDACTED_TOKEN]' },
  {
    pattern: /((?:password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token)\s*[:=]\s*["']?)([^\s"',;]+)/gi,
    replacement: '$1[REDACTED]',
  },
];

/**
 * Redact sensitive credentials from arbitrary text before persisting
 * to SQLite memory, conversation history, or audit logs.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let output = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/**
 * Check if text appears to contain an explicit instruction to store a secret.
 */
export function containsSensitiveCredential(input: string): boolean {
  return /\b(my\s+password\s+is|password\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|bearer\s+[a-z0-9._-]{10,})/i.test(
    input
  );
}
