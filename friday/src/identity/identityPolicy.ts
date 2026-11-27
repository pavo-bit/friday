// ============================================================
// FRIDAY — Personal Identity Policy & Privacy Guard
// Rejects secrets and sensitive personal characteristic inference
// ============================================================

import { containsSensitiveCredential, redactSecrets } from '../memory/redaction';

const SENSITIVE_INFERENCE_RE =
  /\b(religion|caste|political\s+party|sexual\s+orientation|medical\s+diagnosis|psychiatric|mental\s+disorder|ethnicity|race|genetic)\b/i;

export class IdentityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityPolicyError';
  }
}

export function validateIdentityText(fieldName: string, value: string): string {
  if (typeof value !== 'string') {
    throw new IdentityPolicyError(`${fieldName} must be a string.`);
  }
  const trimmed = value.trim();
  if (containsSensitiveCredential(trimmed)) {
    throw new IdentityPolicyError(
      `Refusing to store plaintext credentials, API keys, or tokens in ${fieldName}.`
    );
  }
  if (SENSITIVE_INFERENCE_RE.test(trimmed)) {
    throw new IdentityPolicyError(
      `Refusing to store or infer sensitive personal characteristics in ${fieldName}.`
    );
  }
  return redactSecrets(trimmed);
}

export function validateIdentityArray(fieldName: string, items: unknown): string[] {
  if (!Array.isArray(items)) {
    throw new IdentityPolicyError(`${fieldName} must be an array of strings.`);
  }
  return items
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((item) => validateIdentityText(fieldName, item));
}
