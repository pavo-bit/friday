import 'package:flutter_test/flutter_test.dart';
import 'package:friday_companion/core/voice/friday_personality_engine.dart';
import 'package:friday_companion/core/voice/voice_session_controller.dart';

class FakeSttAdapter implements VoiceSpeechRecognizerAdapter {
  bool shouldInitialize = true;
  bool isListening = false;
  void Function(String words, bool isFinal)? _onResult;

  @override
  Future<bool> initialize() async => shouldInitialize;

  @override
  Future<void> startListening({
    required void Function(String words, bool isFinal) onResult,
  }) async {
    isListening = true;
    _onResult = onResult;
  }

  @override
  Future<void> stopListening() async {
    isListening = false;
  }

  void simulateSpeech(String words, {bool isFinal = true}) {
    _onResult?.call(words, isFinal);
  }
}

class FakeTtsAdapter implements VoiceTtsAdapter {
  final List<String> spoken = [];
  bool stopped = false;

  @override
  Future<void> speak(String text) async {
    spoken.add(text);
  }

  @override
  Future<void> stop() async {
    stopped = true;
  }
}

void main() {
  group('FridayPersonalityEngine (Android)', () {
    test('classifies local time periods accurately and never uses Good night as greeting', () {
      final engine = FridayPersonalityEngine();
      expect(engine.classifyTimeOfDay(6), TimeOfDayPeriod.morning);
      expect(engine.classifyTimeOfDay(14), TimeOfDayPeriod.afternoon);
      expect(engine.classifyTimeOfDay(19), TimeOfDayPeriod.evening);
      expect(engine.classifyTimeOfDay(23), TimeOfDayPeriod.night);
      expect(engine.classifyTimeOfDay(2), TimeOfDayPeriod.night);

      final nightGreeting =
          engine.generateWakeGreeting(now: DateTime(2026, 11, 28, 23, 30));
      expect(nightGreeting.toLowerCase(), isNot(contains('good night')));
      expect(nightGreeting, contains('Boss'));

      final dashboardNight =
          engine.generateDashboardGreeting(now: DateTime(2026, 11, 28, 23, 30));
      expect(dashboardNight, 'Good evening, Boss.');
    });

    test('generates time-aware farewells and honors explicit good night', () {
      final engine = FridayPersonalityEngine();
      final dayFarewell =
          engine.generateFarewell(now: DateTime(2026, 11, 28, 10, 0));
      expect(dayFarewell, contains('Boss'));
      expect(dayFarewell.toLowerCase(), contains('day'));

      final explicitNight = engine.generateFarewell(
        now: DateTime(2026, 11, 28, 10, 0),
        explicitGoodNight: true,
      );
      expect(explicitNight.toLowerCase(), contains('night'));
    });

    test('intent classifier handles farewells, cancel, and compound greeting+command', () {
      final engine = FridayPersonalityEngine();
      expect(
        engine.classifyConversationIntent("That's all for now, Friday.").intent,
        ConversationIntentType.goodbye,
      );
      expect(
        engine.classifyConversationIntent('Good night, Friday.').intent,
        ConversationIntentType.goodNight,
      );
      expect(
        engine.classifyConversationIntent('Cancel that command', inActiveSession: true).intent,
        ConversationIntentType.cancel,
      );

      final compound = engine.classifyConversationIntent(
          'Good morning, Friday. Check my reminders.');
      expect(compound.intent, ConversationIntentType.normalCommand);
      expect(compound.extractedCommand, 'Check my reminders.');
      expect(compound.hasGreetingPrefix, isTrue);
    });
  });

  group('VoiceSessionController (Android Lifecycle)', () {
    test('startSession speaks TTS greeting, enters listening, processes command, and says farewell to standby', () async {
      final stt = FakeSttAdapter();
      final tts = FakeTtsAdapter();
      final commands = <String>[];
      final ctrl = VoiceSessionController(
        personality: FridayPersonalityEngine(),
        stt: stt,
        tts: tts,
        now: () => DateTime(2026, 11, 28, 9, 0),
        executeCommand: (text, _) async {
          commands.add(text);
          return const VoiceBackendTurnResponse(
            reply: 'You have 2 reminders, Boss.',
            voiceSummary: 'You have 2 reminders, Boss.',
            shouldListen: true,
          );
        },
      );

      await ctrl.startSession();
      expect(tts.spoken.length, 1);
      expect(tts.spoken.first, contains('Good morning, Boss'));
      expect(ctrl.state.state, VoiceLifecycleState.listening);
      expect(stt.isListening, isTrue);

      await ctrl.handleSpokenTranscript('Check my reminders');
      expect(commands, ['Check my reminders']);
      expect(tts.spoken.last, 'You have 2 reminders, Boss.');
      expect(ctrl.state.state, VoiceLifecycleState.listening);

      await ctrl.handleSpokenTranscript("That's all for now, Friday.");
      expect(tts.spoken.last.toLowerCase(), contains('day'));
      expect(ctrl.state.state, VoiceLifecycleState.standby);
      expect(ctrl.state.isSessionActive, isFalse);
    });

    test('handles microphone permission denial and recovery', () async {
      final stt = FakeSttAdapter()..shouldInitialize = false;
      final tts = FakeTtsAdapter();
      final ctrl = VoiceSessionController(
        personality: FridayPersonalityEngine(),
        stt: stt,
        tts: tts,
        executeCommand: (_, __) async =>
            const VoiceBackendTurnResponse(reply: 'ok', voiceSummary: 'ok'),
      );

      await ctrl.startSession();
      expect(ctrl.state.state, VoiceLifecycleState.error);
      expect(ctrl.state.permissionDenied, isTrue);

      stt.shouldInitialize = true;
      await ctrl.startSession();
      expect(ctrl.state.permissionDenied, isFalse);
      expect(ctrl.state.state, VoiceLifecycleState.listening);
    });

    test('prevents duplicate greeting from backend WebSocket events during active session', () async {
      final stt = FakeSttAdapter();
      final tts = FakeTtsAdapter();
      final ctrl = VoiceSessionController(
        personality: FridayPersonalityEngine(),
        stt: stt,
        tts: tts,
        executeCommand: (_, __) async =>
            const VoiceBackendTurnResponse(reply: 'ok', voiceSummary: 'ok'),
      );

      await ctrl.startSession();
      expect(
        ctrl.shouldSpeakBackendEvent('evt-1', 'voice:session_start'),
        isFalse,
      );
      expect(
        ctrl.shouldSpeakBackendEvent('evt-1', 'voice:session_start'),
        isFalse,
      );
    });
  });
}
