// ============================================================
// FRIDAY — Voice API Routes
// Controls for Windows native voice activation, settings, and audio turns
// ============================================================

import { Router, Request, Response } from 'express';
import { createLayerLogger } from '../../shared/logger';
import { getVoiceService } from '../../voice/voiceService';
import { getWindowsLifecycleManager } from '../../voice/windowsLifecycle';
import { getSpeechRecognitionEngine } from '../../voice/speechRecognition';
import { getSpeechSynthesisEngine } from '../../voice/speechSynthesis';
import { resolveCallerIdentity } from '../authContext';

const log = createLayerLogger('VoiceRoutes');

export const voiceRoutes = Router();

/**
 * GET /friday/voice/status
 * Returns current voice service state, health metrics, and active settings.
 */
voiceRoutes.get('/status', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  res.json({
    state: voice.getState(),
    health: voice.getHealth(),
    settings: voice.getSettings(),
  });
});

/**
 * GET /friday/voice/health
 * Returns voice subsystem health diagnostics.
 */
voiceRoutes.get('/health', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  res.json({ health: voice.getHealth() });
});

/**
 * POST /friday/voice/settings
 * Updates voice runtime configuration.
 */
voiceRoutes.post('/settings', (req: Request, res: Response) => {
  try {
    const voice = getVoiceService();
    const updated = voice.updateSettings(req.body);
    res.json({ settings: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /friday/voice/mute
 * Physically halts microphone capture.
 */
voiceRoutes.post('/mute', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  voice.mute();
  res.json({ muted: true, state: voice.getState() });
});

/**
 * POST /friday/voice/unmute
 * Resumes microphone capture readiness.
 */
voiceRoutes.post('/unmute', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  voice.unmute();
  res.json({ muted: false, state: voice.getState() });
});

/**
 * POST /friday/voice/sleep
 * Puts voice service into sleep mode (wake word listening disabled).
 */
voiceRoutes.post('/sleep', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  const ok = voice.sleep();
  res.json({ sleeping: ok, state: voice.getState() });
});

/**
 * POST /friday/voice/wake
 * Wakes voice service from sleep mode.
 */
voiceRoutes.post('/wake', (_req: Request, res: Response) => {
  const voice = getVoiceService();
  const ok = voice.wake();
  res.json({ awake: ok, state: voice.getState() });
});

/**
 * POST /friday/voice/start
 * Starts the voice service.
 */
voiceRoutes.post('/start', async (_req: Request, res: Response) => {
  const voice = getVoiceService();
  const ok = await voice.start();
  res.json({ started: ok, state: voice.getState() });
});

/**
 * POST /friday/voice/stop
 * Stops the voice service.
 */
voiceRoutes.post('/stop', async (_req: Request, res: Response) => {
  const voice = getVoiceService();
  await voice.stop();
  res.json({ stopped: true, state: voice.getState() });
});

/**
 * GET /friday/voice/autostart
 * Inspects Windows Registry autostart status.
 */
voiceRoutes.get('/autostart', async (_req: Request, res: Response) => {
  const lifecycle = getWindowsLifecycleManager();
  const status = await lifecycle.checkAutostart();
  res.json(status);
});

/**
 * POST /friday/voice/autostart
 * Enables or disables Windows Registry autostart.
 */
voiceRoutes.post('/autostart', async (req: Request, res: Response) => {
  const { enabled, executablePath } = req.body as {
    enabled?: boolean;
    executablePath?: string;
  };

  const lifecycle = getWindowsLifecycleManager();
  let ok = false;
  if (enabled) {
    ok = await lifecycle.enableAutostart(executablePath);
  } else {
    ok = await lifecycle.disableAutostart();
  }

  res.json({ autostart: Boolean(enabled), success: ok });
});

/**
 * POST /friday/voice/utterance
 * Programmatically simulates or submits a spoken utterance to the voice pipeline.
 */
voiceRoutes.post('/utterance', async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string };
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing "text" field' });
    return;
  }

  try {
    const voice = getVoiceService();
    const sessionId = await voice.processSpokenUtterance(text);
    res.json({ sessionId, state: voice.getState() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * POST /friday/voice/interrupt
 * Immediately halts any active text-to-speech output.
 */
voiceRoutes.post('/interrupt', (_req: Request, res: Response) => {
  const tts = getSpeechSynthesisEngine();
  tts.interrupt();
  res.json({ interrupted: true });
});

/**
 * POST /friday/voice
 * Audio data upload compatibility endpoint.
 */
voiceRoutes.post('/', async (req: Request, res: Response) => {
  const { audio } = req.body as { audio?: string; format?: string };
  if (!audio) {
    res.status(400).json({ error: 'Missing "audio" base64 field' });
    return;
  }

  try {
    const audioBuffer = Buffer.from(audio, 'base64');
    const stt = getSpeechRecognitionEngine();
    const result = await stt.transcribe(audioBuffer);

    if (!result.text) {
      res.json({
        transcript: '',
        response: { text: "I couldn't hear any speech, Boss.", audio: null },
      });
      return;
    }

    const voice = getVoiceService();
    const sessionId = await voice.processSpokenUtterance(result.text);

    res.json({
      transcript: result.text,
      sessionId,
      state: voice.getState(),
    });
  } catch (err) {
    log.error('Error processing audio upload', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to process audio' });
  }
});
