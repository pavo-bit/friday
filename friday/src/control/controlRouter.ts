// ============================================================
// FRIDAY — Control Layer Router
// Routes control actions to their specific executors
// ============================================================

import { execFile, exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { createLayerLogger } from '../shared/logger';
import { getConfig } from '../shared/config';
import { Intent, ActionType, TaskResult, RiskLevel } from '../shared/types';

const log = createLayerLogger('Control');

/** Map of application names to their executable names (Windows) */
const APP_MAP: Record<string, string> = {
  notepad: 'notepad',
  calculator: 'calc',
  paint: 'mspaint',
  explorer: 'explorer',
  terminal: 'cmd',
  cmd: 'cmd',
  powershell: 'powershell',
  chrome: 'chrome',
  firefox: 'firefox',
  edge: 'msedge',
  vscode: 'code',
  code: 'code',
  spotify: 'spotify',
  discord: 'discord',
  slack: 'slack',
  teams: 'teams',
};

/**
 * Execute a control layer action and return a TaskResult.
 */
export async function executeControlAction(intent: Intent): Promise<TaskResult> {
  const startTime = Date.now();

  try {
    switch (intent.action) {
      case ActionType.OPEN_APP:
        return await openApplication(intent, startTime);

      case ActionType.CLOSE_APP:
        return await closeApplication(intent, startTime);

      case ActionType.OPEN_BROWSER:
      case ActionType.BROWSER_NAVIGATE:
        return await openBrowser(intent, startTime);

      case ActionType.SEND_WHATSAPP:
        return await sendWhatsApp(intent, startTime);

      case ActionType.TAKE_SCREENSHOT:
        return await takeScreenshot(intent, startTime);

      case ActionType.PC_CONTROL:
        return await pcAutomation(intent, startTime);

      default:
        return {
          id: uuidv4(),
          intentId: intent.id,
          success: false,
          output: '',
          error: `Control action "${intent.action}" is not yet implemented.`,
          executor: 'control',
          durationMs: Date.now() - startTime,
          risk: intent.risk,
          approved: true,
          timestamp: new Date().toISOString(),
        };
    }
  } catch (error) {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: '',
      error: `Control layer error: ${(error as Error).message}`,
      executor: 'control',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }
}

/** Open an application */
async function openApplication(intent: Intent, startTime: number): Promise<TaskResult> {
  const appName = (intent.params.app || '').toLowerCase();
  const executable = APP_MAP[appName];

  if (!executable) {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: '',
      error: `Unknown application: "${appName}". Known apps: ${Object.keys(APP_MAP).join(', ')}`,
      executor: 'control',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  return new Promise((resolve) => {
    // On Windows, use 'start' to launch detached
    exec(`start "" "${executable}"`, { timeout: 10_000 }, (error) => {
      resolve({
        id: uuidv4(),
        intentId: intent.id,
        success: !error,
        output: error ? '' : `Launched ${appName} (${executable})`,
        error: error?.message,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/** Close an application */
async function closeApplication(intent: Intent, startTime: number): Promise<TaskResult> {
  const appName = (intent.params.app || '').toLowerCase();
  const executable = APP_MAP[appName] || appName;

  return new Promise((resolve) => {
    // On Windows, use taskkill
    execFile('taskkill', ['/IM', `${executable}.exe`, '/F'], { timeout: 10_000 }, (error) => {
      resolve({
        id: uuidv4(),
        intentId: intent.id,
        success: !error,
        output: error ? '' : `Closed ${appName}`,
        error: error?.message,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/** Open a URL in the browser */
async function openBrowser(intent: Intent, startTime: number): Promise<TaskResult> {
  let url = intent.params.url || '';

  if (!url) {
    // Try to extract URL from raw input
    const urlMatch = intent.rawInput.match(/(https?:\/\/\S+|www\.\S+|\w+\.\w{2,}\S*)/i);
    url = urlMatch?.[1] || 'https://google.com';
  }

  // Ensure URL has protocol
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }

  return new Promise((resolve) => {
    // On Windows, 'start' opens URLs in default browser
    exec(`start "" "${url}"`, { timeout: 10_000 }, (error) => {
      resolve({
        id: uuidv4(),
        intentId: intent.id,
        success: !error,
        output: error ? '' : `Opened ${url} in browser`,
        error: error?.message,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/** Send a WhatsApp message via WhatsApp Web URL scheme */
async function sendWhatsApp(intent: Intent, startTime: number): Promise<TaskResult> {
  const contact = intent.params.contact || '';
  const message = intent.params.message || '';

  if (!contact || !message) {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: '',
      error: `Missing required parameters: contact="${contact}", message="${message}"`,
      executor: 'control',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  // Use WhatsApp Web URL scheme
  // For named contacts, we open WhatsApp Web and let user select
  // For phone numbers, we can use the API directly
  const encodedMessage = encodeURIComponent(message);
  const isPhoneNumber = /^\+?\d{10,}$/.test(contact.replace(/\s/g, ''));

  let url: string;
  if (isPhoneNumber) {
    const phone = contact.replace(/[^+\d]/g, '');
    url = `https://web.whatsapp.com/send?phone=${phone}&text=${encodedMessage}`;
  } else {
    // Open WhatsApp Web search for the contact name
    url = `https://web.whatsapp.com/send?text=${encodedMessage}`;
  }

  log.info(`WhatsApp: sending "${message}" to ${contact}`, {
    intentId: intent.id,
    isPhoneNumber,
  });

  return new Promise((resolve) => {
    exec(`start "" "${url}"`, { timeout: 10_000 }, (error) => {
      const output = error
        ? ''
        : `Opened WhatsApp Web to send "${message}" to ${contact}. ` +
          (isPhoneNumber
            ? 'The message is pre-filled — just press Send.'
            : `Please search for "${contact}" in WhatsApp Web and press Send.`);

      resolve({
        id: uuidv4(),
        intentId: intent.id,
        success: !error,
        output,
        error: error?.message,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/** Take a screenshot (Windows) */
async function takeScreenshot(intent: Intent, startTime: number): Promise<TaskResult> {
  return new Promise((resolve) => {
    const screenshotPath = require('path').resolve(
      __dirname,
      '..',
      '..',
      'data',
      `screenshot_${Date.now()}.png`
    );

    // Use PowerShell to take a screenshot on Windows
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      $bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
      $bitmap.Save("${screenshotPath.replace(/\\/g, '\\\\')}")
      $graphics.Dispose()
      $bitmap.Dispose()
    `;

    execFile('powershell', ['-Command', psScript], { timeout: 15_000 }, (error) => {
      resolve({
        id: uuidv4(),
        intentId: intent.id,
        success: !error,
        output: error ? '' : `Screenshot saved to: ${screenshotPath}`,
        error: error?.message,
        executor: 'control',
        durationMs: Date.now() - startTime,
        risk: intent.risk,
        approved: true,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/** PC automation using Python pyautogui bridge */
async function pcAutomation(intent: Intent, startTime: number): Promise<TaskResult> {
  const config = getConfig();

  if (!config.enablePcControl) {
    return {
      id: uuidv4(),
      intentId: intent.id,
      success: false,
      output: '',
      error: 'PC automation is disabled. Set ENABLE_PC_CONTROL=true in .env to enable.',
      executor: 'control',
      durationMs: Date.now() - startTime,
      risk: intent.risk,
      approved: true,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    id: uuidv4(),
    intentId: intent.id,
    success: false,
    output: '',
    error: 'PC automation via pyautogui bridge is not yet implemented. Coming in Phase 3.',
    executor: 'control',
    durationMs: Date.now() - startTime,
    risk: intent.risk,
    approved: true,
    timestamp: new Date().toISOString(),
  };
}
