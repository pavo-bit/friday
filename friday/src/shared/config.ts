// ============================================================
// FRIDAY — Configuration Loader
// Loads and validates environment variables into typed config
// ============================================================

import * as path from 'path';
import * as fs from 'fs';
import { FridayConfig } from './types';

const ROOT = path.resolve(__dirname, '..', '..');
const CLAW_ROOT = path.resolve(ROOT, '..');

/**
 * Auto-detect the Claw binary path across platforms.
 * Checks standard build output locations.
 */
function detectClawBinary(): string {
  const candidates = [
    path.join(CLAW_ROOT, 'rust', 'target', 'debug', 'claw.exe'),
    path.join(CLAW_ROOT, 'rust', 'target', 'debug', 'claw'),
    path.join(CLAW_ROOT, 'rust', 'target', 'release', 'claw.exe'),
    path.join(CLAW_ROOT, 'rust', 'target', 'release', 'claw'),
    path.join(CLAW_ROOT, 'rust', 'target', 'debug', 'claw.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback — will be validated at runtime
  return candidates[0];
}

/**
 * Load FRIDAY configuration from environment variables.
 * Applies sensible defaults for all optional values.
 */
export function loadConfig(): FridayConfig {
  return {
    port: parseInt(process.env.FRIDAY_PORT || '3141', 10),
    host: process.env.FRIDAY_HOST || '127.0.0.1',
    clawBinaryPath: process.env.CLAW_BINARY_PATH || detectClawBinary(),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:4b',

    // Safety
    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30', 10),
    highRiskLimitPerHour: parseInt(process.env.HIGH_RISK_LIMIT_PER_HOUR || '5', 10),
    requireHighRiskApproval: process.env.REQUIRE_HIGH_RISK_APPROVAL !== 'false',

    // Voice
    sttEngine: (process.env.STT_ENGINE as FridayConfig['sttEngine']) || 'none',
    ttsEngine: (process.env.TTS_ENGINE as FridayConfig['ttsEngine']) || 'none',
    wakeWord: process.env.WAKE_WORD || 'friday',

    // Memory
    dbPath: process.env.FRIDAY_DB_PATH || path.join(ROOT, 'data', 'friday.db'),

    // Control
    allowedDirectories: (process.env.ALLOWED_DIRECTORIES || '.')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    enableBrowserControl: process.env.ENABLE_BROWSER_CONTROL === 'true',
    enablePcControl: process.env.ENABLE_PC_CONTROL === 'true',
  };
}

/**
 * Validate that critical configuration is present and correct.
 * Returns an array of error messages (empty = valid).
 */
export function validateConfig(config: FridayConfig): string[] {
  const errors: string[] = [];

  if (!fs.existsSync(config.clawBinaryPath)) {
    errors.push(
      `Claw binary not found at: ${config.clawBinaryPath}. ` +
        'Build it with: cd rust && cargo build --workspace'
    );
  }

  if (config.port < 1 || config.port > 65535) {
    errors.push(`Invalid port: ${config.port}`);
  }

  return errors;
}

/** Singleton config instance */
let _config: FridayConfig | null = null;

export function getConfig(): FridayConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
