// ============================================================
// FRIDAY — Learning Source Validator & Injection Guard
// Untrusted external content can NEVER become privileged instructions
// or silent verified facts.
// ============================================================

import { containsSensitiveCredential, redactSecrets } from '../memory/redaction';
import { sanitizeRetrievedText } from '../orchestration/contextResolution';
import { LearningSourceType, SourceQuality } from './learningTypes';

export interface SourceValidationResult {
  allowed: boolean;
  sanitizedContent: string;
  untrustedSanitized: boolean;
  resolvedQuality: SourceQuality;
  verified: boolean;
  reason?: string;
}

export function validateLearningSource(params: {
  sourceType: LearningSourceType;
  rawContent: string;
  declaredQuality?: SourceQuality;
  approvedSource?: boolean;
}): SourceValidationResult {
  const { sourceType, rawContent, declaredQuality, approvedSource } = params;

  if (!rawContent || !rawContent.trim()) {
    return {
      allowed: false,
      sanitizedContent: '',
      untrustedSanitized: false,
      resolvedQuality: 'UNVERIFIED',
      verified: false,
      reason: 'Content cannot be empty.',
    };
  }

  if (containsSensitiveCredential(rawContent)) {
    return {
      allowed: false,
      sanitizedContent: '',
      untrustedSanitized: false,
      resolvedQuality: 'UNVERIFIED',
      verified: false,
      reason: 'Refusing to ingest plaintext credentials, API keys, or auth tokens.',
    };
  }

  // External sources require explicit approval when marked as website/directory/app
  const isExternal =
    sourceType === 'approved_website' ||
    sourceType === 'approved_directory' ||
    sourceType === 'connected_app';
  if (isExternal && approvedSource === false) {
    return {
      allowed: false,
      sanitizedContent: '',
      untrustedSanitized: false,
      resolvedQuality: 'UNVERIFIED',
      verified: false,
      reason: `Source "${sourceType}" is not approved for ingestion.`,
    };
  }

  // Quarantine prompt injection attempts in external/user content
  const sanitized = sanitizeRetrievedText(redactSecrets(rawContent.trim()));

  // Enforce strict provenance: external claims & unverified user statements NEVER silently become VERIFIED_FACT
  let resolvedQuality: SourceQuality = declaredQuality || 'UNVERIFIED';
  let verified = false;

  if (sourceType === 'verified_task_outcome' || sourceType === 'monitoring_event') {
    resolvedQuality = declaredQuality === 'OUTDATED' ? 'OUTDATED' : 'VERIFIED_FACT';
    verified = resolvedQuality === 'VERIFIED_FACT';
  } else if (sourceType === 'approved_website') {
    resolvedQuality = 'EXTERNAL_CLAIM';
    verified = false;
  } else if (sourceType === 'conversation_correction') {
    resolvedQuality = 'USER_STATEMENT';
    verified = false;
  } else if (resolvedQuality === 'VERIFIED_FACT' && sourceType !== 'user_file') {
    resolvedQuality = 'USER_STATEMENT';
    verified = false;
  } else if (resolvedQuality === 'VERIFIED_FACT') {
    verified = true;
  }

  return {
    allowed: true,
    sanitizedContent: sanitized.safe,
    untrustedSanitized: sanitized.flagged,
    resolvedQuality,
    verified,
  };
}
