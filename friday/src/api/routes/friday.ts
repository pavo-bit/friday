// ============================================================
// FRIDAY — API Routes: /friday/run, /friday/voice
// Main task execution and voice endpoints
// ============================================================

import { Router, Request, Response } from 'express';
import { createLayerLogger } from '../../shared/logger';
import { getIntentParser } from '../../intelligence/intentParser';
import { getTaskRouter } from '../../orchestration/taskRouter';
import { getSafetyGate } from '../../orchestration/safetyGate';
import { getMemoryStore } from '../../memory/store';
import { getStt } from '../../voice/stt';
import { getTts } from '../../voice/tts';
import { TaskResult } from '../../shared/types';
import { toStructuredIntent } from '../../intelligence/systemPrompt';
import { getAssistantBrain } from '../../orchestration/assistantBrain';

const log = createLayerLogger('Routes');

export const fridayRoutes = Router();

/**
 * POST /friday/run
 *
 * Main endpoint for text-based task execution.
 * Accepts a text prompt, parses intent, evaluates safety,
 * and routes to the appropriate executor.
 */
fridayRoutes.post('/run', async (req: Request, res: Response) => {
  const { text, sessionId, approved } = req.body as { text?: string; sessionId?: string; approved?: boolean };

  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing "text" field in request body' });
    return;
  }

  if (text.length > 32_000) {
    res.status(413).json({ error: 'Input exceeds maximum length (32,000 chars)' });
    return;
  }

  try {
    const result = await processTextInput(text, sessionId, Boolean(approved));
    res.json(result);
  } catch (error) {
    log.error('Error processing request', { error: (error as Error).message });
    res.status(500).json({ error: 'Internal processing error' });
  }
});

/**
 * POST /friday/voice
 *
 * Voice endpoint — accepts audio data, transcribes with Whisper,
 * processes the text, and returns both text and audio response.
 */
fridayRoutes.post('/voice', async (req: Request, res: Response) => {
  const stt = getStt();
  const tts = getTts();

  if (!stt.isAvailable()) {
    res.status(503).json({
      error: 'Speech-to-text is not configured. Set STT_ENGINE and OPENAI_API_KEY in .env',
    });
    return;
  }

  try {
    // Extract audio from request body (base64 encoded)
    const { audio, format } = req.body as { audio?: string; format?: string };

    if (!audio) {
      res.status(400).json({ error: 'Missing "audio" field (base64 encoded)' });
      return;
    }

    // Step 1: Transcribe audio to text
    const audioBuffer = Buffer.from(audio, 'base64');
    const transcript = await stt.transcribe(audioBuffer, format || 'webm');

    if (!transcript) {
      res.json({
        transcript: '',
        response: { text: "I couldn't understand the audio. Please try again.", audio: null },
      });
      return;
    }

    // Step 2: Process the transcribed text
    const result = await processTextInput(transcript);

    // Step 3: Generate TTS audio response
    let audioResponse: string | null = null;
    if (tts.isAvailable() && result.output) {
      const audioBuf = await tts.synthesize(result.output);
      if (audioBuf) {
        audioResponse = audioBuf.toString('base64');
      }
    }

    res.json({
      transcript,
      response: {
        text: result.output || result.error || 'No response',
        audio: audioResponse,
        result,
      },
    });
  } catch (error) {
    log.error('Voice processing error', { error: (error as Error).message });
    res.status(500).json({ error: 'Voice processing failed' });
  }
});

/**
 * POST /friday/approve
 *
 * Approve or deny a pending high-risk action.
 */
fridayRoutes.post('/approve', async (req: Request, res: Response) => {
  const { requestId, approved } = req.body as { requestId?: string; approved?: boolean };

  if (!requestId || typeof approved !== 'boolean') {
    res.status(400).json({ error: 'Missing "requestId" and/or "approved" fields' });
    return;
  }

  const safetyGate = getSafetyGate();
  const success = safetyGate.processApproval(requestId, approved);

  if (!success) {
    res.status(404).json({ error: 'Approval request not found or already processed' });
    return;
  }

  res.json({ success: true, approved });
});

/**
 * GET /friday/pending
 *
 * Get all pending approval requests.
 */
fridayRoutes.get('/pending', async (_req: Request, res: Response) => {
  const safetyGate = getSafetyGate();
  res.json({ pending: safetyGate.getPendingApprovals() });
});

/**
 * GET /friday/history
 *
 * Get recent task history.
 */
fridayRoutes.get('/history', async (req: Request, res: Response) => {
  const limit = parseInt((req.query.limit as string) || '20', 10);
  const router = getTaskRouter();
  res.json({ tasks: router.getRecentTasks(limit) });
});

/**
 * Core text processing pipeline — used by both /run and /voice endpoints.
 */
export async function processTextInput(
  text: string,
  sessionId?: string,
  approvedHighRisk = false
): Promise<TaskResult & { intent?: unknown; toolResult?: unknown }> {
  return getAssistantBrain().process(text, sessionId, approvedHighRisk);
}
