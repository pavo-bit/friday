// ============================================================
// FRIDAY — Windows Lifecycle
// Windows background startup, registry integration, and system control
// ============================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { createLayerLogger } from '../shared/logger';
import { getVoiceSettingsManager } from './voiceSettings';

const execAsync = promisify(exec);
const log = createLayerLogger('WindowsLifecycle');

export interface WindowsStartupStatus {
  supported: boolean;
  enabled: boolean;
  registryKey: string;
  command?: string;
}

export class WindowsLifecycleManager {
  private readonly registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  private readonly appName = 'FRIDAY';

  isWindows(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Inspects Windows Registry to verify if autostart is registered.
   */
  async checkAutostart(): Promise<WindowsStartupStatus> {
    if (!this.isWindows()) {
      return {
        supported: false,
        enabled: false,
        registryKey: this.registryKey,
      };
    }

    try {
      const { stdout } = await execAsync(
        `reg query "${this.registryKey}" /v "${this.appName}"`
      );
      const isRegistered = stdout.includes(this.appName);
      return {
        supported: true,
        enabled: isRegistered,
        registryKey: this.registryKey,
        command: isRegistered ? stdout.trim() : undefined,
      };
    } catch {
      return {
        supported: true,
        enabled: false,
        registryKey: this.registryKey,
      };
    }
  }

  /**
   * Registers FRIDAY in the Windows Run registry key.
   */
  async enableAutostart(executablePath?: string): Promise<boolean> {
    if (!this.isWindows()) {
      log.warn('Windows autostart is only supported on Windows platforms');
      return false;
    }

    const targetPath =
      executablePath ||
      process.execPath + ' ' + path.resolve(__dirname, '..', '..', 'dist', 'index.js');
    const safeCommand = `"${targetPath.replace(/"/g, '\\"')}"`;

    try {
      await execAsync(
        `reg add "${this.registryKey}" /v "${this.appName}" /t REG_SZ /d ${safeCommand} /f`
      );
      log.info('Windows autostart registered successfully', { command: safeCommand });
      getVoiceSettingsManager().updateSettings({ autostart: true });
      return true;
    } catch (err) {
      log.error('Failed to register Windows autostart', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Unregisters FRIDAY from Windows Run registry key.
   */
  async disableAutostart(): Promise<boolean> {
    if (!this.isWindows()) {
      return false;
    }

    try {
      await execAsync(
        `reg delete "${this.registryKey}" /v "${this.appName}" /f`
      );
      log.info('Windows autostart unregistered successfully');
      getVoiceSettingsManager().updateSettings({ autostart: false });
      return true;
    } catch {
      // Key might not exist, which is fine
      getVoiceSettingsManager().updateSettings({ autostart: false });
      return true;
    }
  }
}

let _windowsLifecycleManager: WindowsLifecycleManager | null = null;

export function getWindowsLifecycleManager(): WindowsLifecycleManager {
  if (!_windowsLifecycleManager) {
    _windowsLifecycleManager = new WindowsLifecycleManager();
  }
  return _windowsLifecycleManager;
}
