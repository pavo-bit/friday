// ============================================================
// FRIDAY — Claw Bridge
// The SOLE interface between FRIDAY and the Claw Rust runtime.
// Uses execFile() for process isolation and injection safety.
// ============================================================

import { execFile, ChildProcess, ExecFileException } from 'child_process';
import * as fs from 'fs';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { TaskResult, RiskLevel, FridayId } from '../shared/types';
import { v4 as uuidv4 } from 'uuid';

const log = createLayerLogger('ClawBridge');

/** ANSI escape code stripper (same as existing web-ui) */
function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ''
  );
}

/** Options for a Claw invocation */
export interface ClawInvocationOptions {
  /** The prompt to send to Claw */
  prompt: string;
  /** Timeout in milliseconds (default: 120000) */
  timeout?: number;
  /** Working directory for Claw (default: project root) */
  cwd?: string;
  /** Maximum output buffer in bytes (default: 10MB) */
  maxBuffer?: number;
  /** Intent ID for correlation */
  intentId?: FridayId;
  /** Risk level for audit logging */
  risk?: RiskLevel;
}

/** Result from a Claw invocation */
export interface ClawResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  exitCode: number | null;
}

/**
 * ClawBridge — manages all communication with the Claw Rust binary.
 *
 * Design principles:
 * - NEVER uses exec() or shell interpretation
 * - ALWAYS passes user input as argv (execFile), never interpolated
 * - Strips ANSI escape codes from all output
 * - Enforces hard timeout and buffer limits
 * - Logs every invocation for audit trail
 */
export class ClawBridge {
  private binaryPath: string;
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private invocationCount = 0;

  constructor() {
    const config = getConfig();
    this.binaryPath = config.clawBinaryPath;
  }

  /** Check if the Claw binary exists and is accessible */
  isAvailable(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  /** Get the path to the Claw binary */
  getBinaryPath(): string {
    return this.binaryPath;
  }

  /**
   * Send a prompt to Claw and return the result.
   *
   * This is the ONLY method that should ever invoke the Claw binary.
   * All FRIDAY actions that need Claw must go through this method.
   */
  async invoke(options: ClawInvocationOptions): Promise<ClawResult> {
    const {
      prompt,
      timeout = 120_000,
      cwd,
      maxBuffer = 10 * 1024 * 1024,
      intentId,
      risk = RiskLevel.LOW,
    } = options;

    if (!this.isAvailable()) {
      return {
        success: false,
        output: '',
        error: `Claw binary not found at: ${this.binaryPath}`,
        durationMs: 0,
        exitCode: null,
      };
    }

    const invocationId = uuidv4();
    this.invocationCount++;

    log.info(`Invoking Claw #${this.invocationCount}`, {
      invocationId,
      intentId,
      risk,
      promptLength: prompt.length,
      timeout,
    });

    const startTime = Date.now();

    return new Promise<ClawResult>((resolve) => {
      const env = {
        ...process.env,
        HOME: process.env.USERPROFILE || process.env.HOME,
      };

      // CRITICAL: execFile passes arguments as an array directly to the
      // executable, completely bypassing shell interpretation.
      // This makes command injection IMPOSSIBLE.
      const isJs = this.binaryPath.endsWith('.js');
      const bin = isJs ? process.execPath : this.binaryPath;
      const args = isJs ? [this.binaryPath, 'prompt', prompt] : ['prompt', prompt];

      const child = execFile(
        bin,
        args,
        {
          encoding: 'utf8',
          env,
          timeout,
          maxBuffer,
          cwd: cwd || undefined,
        },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          const durationMs = Date.now() - startTime;
          this.activeProcesses.delete(invocationId);

          let output = stdout || '';
          if (stderr) output += '\n' + stderr;
          if (error && !output) output = error.message;

          output = stripAnsi(output).trim();

          const success = !error;
          const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number }).code ? null : 1 : 0;

          log.info(`Claw invocation completed`, {
            invocationId,
            intentId,
            success,
            durationMs,
            outputLength: output.length,
          });

          resolve({ success, output, error: error?.message, durationMs, exitCode });
        }
      );

      // Track active process for potential cancellation
      this.activeProcesses.set(invocationId, child);
    });
  }

  /**
   * Convert a Claw invocation result into a FRIDAY TaskResult.
   */
  toTaskResult(
    clawResult: ClawResult,
    intentId: FridayId,
    risk: RiskLevel
  ): TaskResult {
    return {
      id: uuidv4(),
      intentId,
      success: clawResult.success,
      output: clawResult.output,
      error: clawResult.error,
      executor: 'claw',
      durationMs: clawResult.durationMs,
      risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  /** Cancel all active Claw processes */
  cancelAll(): void {
    for (const [id, child] of this.activeProcesses) {
      log.warn(`Cancelling Claw process: ${id}`);
      child.kill('SIGTERM');
    }
    this.activeProcesses.clear();
  }

  /** Get the number of active Claw processes */
  getActiveCount(): number {
    return this.activeProcesses.size;
  }

  /** Get total invocation count (lifetime) */
  getTotalInvocations(): number {
    return this.invocationCount;
  }
}

/** Singleton bridge instance */
let _bridge: ClawBridge | null = null;

export function getClawBridge(): ClawBridge {
  if (!_bridge) {
    _bridge = new ClawBridge();
  }
  return _bridge;
}
