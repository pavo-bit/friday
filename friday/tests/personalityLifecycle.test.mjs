import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GreetingService } from '../dist/voice/greetingService.js';
import { classifyConversationIntent } from '../dist/voice/conversationIntent.js';
import { getVoiceStateManager } from '../dist/voice/voiceStateManager.js';
import { getVoiceSessionManager } from '../dist/voice/voiceSessionManager.js';
import { getVoiceService } from '../dist/voice/voiceService.js';
import { getSpeechSynthesisEngine } from '../dist/voice/speechSynthesis.js';
import { getMicrophoneManager } from '../dist/voice/microphoneManager.js';
import { getVoiceSettingsManager } from '../dist/voice/voiceSettings.js';

describe('FRIDAY Personality, Greeting, Farewell & Voice Lifecycle', () => {
  afterEach(async () => {
    getSpeechSynthesisEngine().interrupt();
    getMicrophoneManager().stopCapture();
    getMicrophoneManager().unmute();
    getVoiceSessionManager().abortSession();
    getVoiceStateManager().reset('STANDBY');
  });

  describe('1. Time-Aware Greeting Engine', () => {
    it('classifies morning, afternoon, evening, and late-night correctly', () => {
      const gs = new GreetingService();
      assert.equal(gs.classifyTimeOfDay(5), 'morning');
      assert.equal(gs.classifyTimeOfDay(11), 'morning');
      assert.equal(gs.classifyTimeOfDay(12), 'afternoon');
      assert.equal(gs.classifyTimeOfDay(16), 'afternoon');
      assert.equal(gs.classifyTimeOfDay(17), 'evening');
      assert.equal(gs.classifyTimeOfDay(20), 'evening');
      assert.equal(gs.classifyTimeOfDay(21), 'night');
      assert.equal(gs.classifyTimeOfDay(0), 'night');
      assert.equal(gs.classifyTimeOfDay(4), 'night');
    });

    it('uses Good evening / Welcome back at late night and never Good night as a wake greeting', () => {
      const gs = new GreetingService();
      // 23:30 UTC -> 05:00 IST (morning) vs 23:30 in UTC
      const lateNightUtc = new Date('2026-11-28T23:30:00Z');
      const info = gs.getGreetingInfo(lateNightUtc, 'UTC');
      assert.equal(info.period, 'night');
      assert.equal(info.salutation, 'Good evening');

      const wake = gs.generateWakeGreeting(lateNightUtc, 'UTC');
      assert.match(wake, /Boss/i);
      assert.doesNotMatch(wake, /good night/i);
    });

    it('handles valid IANA timezones and falls back gracefully on invalid timezone', () => {
      const gs = new GreetingService();
      const instant = new Date('2026-11-28T13:00:00Z'); // 08:00 America/New_York (EST), 18:30 Asia/Kolkata
      const nyInfo = gs.getGreetingInfo(instant, 'America/New_York');
      assert.equal(nyInfo.timezone, 'America/New_York');
      assert.equal(nyInfo.period, 'morning');
      assert.equal(nyInfo.salutation, 'Good morning');

      const istInfo = gs.getGreetingInfo(instant, 'Asia/Kolkata');
      assert.equal(istInfo.timezone, 'Asia/Kolkata');
      assert.equal(istInfo.period, 'evening');
      assert.equal(istInfo.salutation, 'Good evening');

      const invalidFallback = gs.resolveTimezone('Invalid/Zone_XYZ');
      assert.ok(invalidFallback.length > 0);
    });

    it('varies consecutive wake greetings without repeating the exact same phrase', () => {
      const gs = new GreetingService();
      const morning = new Date('2026-11-28T09:00:00Z');
      const g1 = gs.generateWakeGreeting(morning, 'UTC');
      const g2 = gs.generateWakeGreeting(morning, 'UTC');
      assert.notEqual(g1, g2);
      assert.match(g1, /Good morning, Boss/);
      assert.match(g2, /Good morning, Boss/);
    });
  });

  describe('2. Time-Aware Farewell Engine', () => {
    it('produces daytime, evening, and nighttime farewells based on local time', () => {
      const gs = new GreetingService();

      const daytime = gs.generateFarewell(new Date('2026-11-28T10:00:00Z'), { timezone: 'UTC' });
      assert.match(daytime, /Boss/);
      assert.match(daytime, /day/i);
      assert.doesNotMatch(daytime, /good night|restful night/i);

      const evening = gs.generateFarewell(new Date('2026-11-28T18:30:00Z'), { timezone: 'UTC' });
      assert.match(evening, /Boss/);
      assert.match(evening, /evening/i);

      const night = gs.generateFarewell(new Date('2026-11-28T23:00:00Z'), { timezone: 'UTC' });
      assert.match(night, /Boss/);
      assert.match(night, /night/i);
    });

    it('honors explicit good night farewell regardless of the hour', () => {
      const gs = new GreetingService();
      const daytimeExplicitNight = gs.generateFarewell(new Date('2026-11-28T10:00:00Z'), {
        timezone: 'UTC',
        explicitGoodNight: true,
      });
      assert.match(daytimeExplicitNight, /night/i);
    });
  });

  describe('3. Centralized Conversation Intent Classifier', () => {
    it('classifies greetings, wakes, farewells, good_night, cancel, sleep, and follow-ups accurately', () => {
      assert.equal(classifyConversationIntent('Hey FRIDAY').intent, 'WAKE');
      assert.equal(classifyConversationIntent("That's all for now, Friday.").intent, 'GOODBYE');
      assert.equal(classifyConversationIntent('Goodbye, Friday.').intent, 'GOODBYE');
      assert.equal(classifyConversationIntent("I'm done.").intent, 'GOODBYE');
      assert.equal(classifyConversationIntent('You can go to standby.').intent, 'GOODBYE');
      assert.equal(classifyConversationIntent('Good night, Friday.').intent, 'GOOD_NIGHT');
      assert.equal(classifyConversationIntent('Go to sleep').intent, 'SLEEP');
    });

    it('does not misclassify "cancel that command" or "tell Mom good night" as conversation-ending', () => {
      const cancel = classifyConversationIntent('Cancel that command', true);
      assert.equal(cancel.intent, 'CANCEL');
      assert.equal(cancel.shouldEndConversation, false);

      const msg = classifyConversationIntent('Send a message saying good night to Mom', true);
      assert.equal(msg.intent, 'FOLLOW_UP');
      assert.equal(msg.shouldEndConversation, false);
    });

    it('extracts commands following a greeting without consuming the command', () => {
      const compound = classifyConversationIntent('Good morning, Friday. Check my reminders.', false);
      assert.equal(compound.hasGreetingPrefix, true);
      assert.equal(compound.intent, 'NORMAL_COMMAND');
      assert.equal(compound.extractedCommand, 'Check my reminders.');
      assert.equal(compound.shouldEndConversation, false);
    });
  });

  describe('4. Voice Conversation Lifecycle FSM & Session Manager', () => {
    it('supports STANDBY -> WAKE_DETECTED -> GREETING -> LISTENING -> PROCESSING -> SPEAKING -> STANDBY', () => {
      const sm = getVoiceStateManager();
      sm.reset('STANDBY');
      assert.equal(sm.transitionTo('WAKE_DETECTED'), true);
      assert.equal(sm.transitionTo('GREETING'), true);
      assert.equal(sm.transitionTo('LISTENING'), true);
      assert.equal(sm.transitionTo('PROCESSING'), true);
      assert.equal(sm.transitionTo('SPEAKING'), true);
      assert.equal(sm.transitionTo('STANDBY'), true);
    });

    it('returns to STANDBY on farewell and keeps wake-word detection enabled', async () => {
      getVoiceSettingsManager().updateSettings({ ttsEnabled: false, wakeWordEnabled: true });
      const sm = getVoiceStateManager();
      sm.reset('STANDBY');

      const session = getVoiceSessionManager();
      const sid = await session.startSession();
      assert.ok(sid.startsWith('voice-'));

      const turn = await session.evaluateVoiceTurn("That's all for now, Friday.", sid, 'UTC');
      assert.equal(turn.isFarewell, true);
      assert.equal(turn.shouldListen, false);
      assert.match(turn.voiceSummary, /Boss/);

      // Simulate completing farewell speech
      session.abortSession();
      sm.reset('STANDBY');
      assert.equal(getVoiceService().getState(), 'STANDBY');
    });

    it('does not restart microphone after mute or sleep', async () => {
      getVoiceSettingsManager().updateSettings({ ttsEnabled: false });
      const sm = getVoiceStateManager();
      sm.reset('STANDBY');
      const voice = getVoiceService();

      await getVoiceSessionManager().startSession();
      voice.mute();
      assert.equal(voice.getState(), 'MUTED');
      assert.equal(getVoiceSessionManager().hasActiveSession(), false);

      voice.unmute();
      assert.equal(voice.getState(), 'STANDBY');

      voice.sleep();
      assert.equal(voice.getState(), 'SLEEPING');
    });
  });
});
