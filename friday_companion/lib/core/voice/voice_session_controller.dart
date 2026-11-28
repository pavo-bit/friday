import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'friday_personality_engine.dart';

enum VoiceLifecycleState {
  standby,
  wakeDetected,
  greeting,
  listening,
  processing,
  speaking,
  muted,
  error,
}

class VoiceSessionSnapshot {
  final VoiceLifecycleState state;
  final String? activeSessionId;
  final String statusText;
  final String lastSpokenText;
  final String lastTranscript;
  final bool hasGreetedInSession;
  final bool permissionDenied;

  const VoiceSessionSnapshot({
    this.state = VoiceLifecycleState.standby,
    this.activeSessionId,
    this.statusText = 'Standby. Tap microphone to start a voice session.',
    this.lastSpokenText = '',
    this.lastTranscript = '',
    this.hasGreetedInSession = false,
    this.permissionDenied = false,
  });

  bool get isSessionActive =>
      state != VoiceLifecycleState.standby &&
      state != VoiceLifecycleState.muted &&
      state != VoiceLifecycleState.error;

  VoiceSessionSnapshot copyWith({
    VoiceLifecycleState? state,
    String? activeSessionId,
    bool clearSessionId = false,
    String? statusText,
    String? lastSpokenText,
    String? lastTranscript,
    bool? hasGreetedInSession,
    bool? permissionDenied,
  }) {
    return VoiceSessionSnapshot(
      state: state ?? this.state,
      activeSessionId:
          clearSessionId ? null : (activeSessionId ?? this.activeSessionId),
      statusText: statusText ?? this.statusText,
      lastSpokenText: lastSpokenText ?? this.lastSpokenText,
      lastTranscript: lastTranscript ?? this.lastTranscript,
      hasGreetedInSession: hasGreetedInSession ?? this.hasGreetedInSession,
      permissionDenied: permissionDenied ?? this.permissionDenied,
    );
  }
}

abstract class VoiceSpeechRecognizerAdapter {
  Future<bool> initialize();
  Future<void> startListening({
    required void Function(String words, bool isFinal) onResult,
  });
  Future<void> stopListening();
}

abstract class VoiceTtsAdapter {
  Future<void> speak(String text);
  Future<void> stop();
}

class DeviceSpeechRecognizerAdapter implements VoiceSpeechRecognizerAdapter {
  final SpeechToText _stt = SpeechToText();

  @override
  Future<bool> initialize() => _stt.initialize();

  @override
  Future<void> startListening({
    required void Function(String words, bool isFinal) onResult,
  }) async {
    await _stt.listen(
      onResult: (res) => onResult(res.recognizedWords, res.finalResult),
    );
  }

  @override
  Future<void> stopListening() => _stt.stop();
}

class DeviceTtsAdapter implements VoiceTtsAdapter {
  final FlutterTts _tts = FlutterTts();
  bool _configured = false;

  Future<void> _ensureConfigured() async {
    if (_configured) return;
    _configured = true;
    await _tts.awaitSpeakCompletion(true);
  }

  @override
  Future<void> speak(String text) async {
    await _ensureConfigured();
    await _tts.speak(text);
  }

  @override
  Future<void> stop() => _tts.stop();
}

typedef VoiceCommandExecutor = Future<VoiceBackendTurnResponse> Function(
  String text,
  String sessionId,
);

class VoiceBackendTurnResponse {
  final String reply;
  final String voiceSummary;
  final bool isFarewell;
  final bool shouldListen;

  const VoiceBackendTurnResponse({
    required this.reply,
    required this.voiceSummary,
    this.isFarewell = false,
    this.shouldListen = true,
  });
}

class VoiceSessionController extends StateNotifier<VoiceSessionSnapshot> {
  final FridayPersonalityEngine _personality;
  final VoiceSpeechRecognizerAdapter _stt;
  final VoiceTtsAdapter _tts;
  final VoiceCommandExecutor _executeCommand;
  final DateTime Function() _now;
  final Set<String> _handledBackendEventIds = <String>{};

  bool _isDisposed = false;

  VoiceSessionController({
    required FridayPersonalityEngine personality,
    required VoiceSpeechRecognizerAdapter stt,
    required VoiceTtsAdapter tts,
    required VoiceCommandExecutor executeCommand,
    DateTime Function()? now,
  })  : _personality = personality,
        _stt = stt,
        _tts = tts,
        _executeCommand = executeCommand,
        _now = now ?? DateTime.now,
        super(const VoiceSessionSnapshot());

  Future<void> startSession({String? extractedCommand}) async {
    if (state.isSessionActive && (extractedCommand == null || extractedCommand.trim().isEmpty)) {
      return;
    }

    final ok = await _stt.initialize();
    if (!ok) {
      state = state.copyWith(
        state: VoiceLifecycleState.error,
        permissionDenied: true,
        statusText:
            'Microphone permission or speech recognition is unavailable, Boss.',
      );
      return;
    }

    final sessionId = 'android-voice-${_now().millisecondsSinceEpoch}';
    state = state.copyWith(
      state: VoiceLifecycleState.wakeDetected,
      activeSessionId: sessionId,
      hasGreetedInSession: false,
      permissionDenied: false,
      statusText: 'Wake detected…',
    );

    if (extractedCommand != null && extractedCommand.trim().isNotEmpty) {
      await handleSpokenTranscript(extractedCommand.trim());
      return;
    }

    final greeting = _personality.generateWakeGreeting(now: _now());
    state = state.copyWith(
      state: VoiceLifecycleState.greeting,
      hasGreetedInSession: true,
      lastSpokenText: greeting,
      statusText: greeting,
    );

    await _speakAndThen(greeting, () async {
      if (_isDisposed || state.activeSessionId != sessionId) return;
      await _beginListening();
    });
  }

  Future<void> _beginListening() async {
    if (_isDisposed || state.activeSessionId == null) return;
    await _tts.stop();
    state = state.copyWith(
      state: VoiceLifecycleState.listening,
      statusText: 'Listening…',
    );

    await _stt.startListening(
      onResult: (words, isFinal) {
        if (_isDisposed || state.state != VoiceLifecycleState.listening) return;
        state = state.copyWith(lastTranscript: words);
        if (isFinal && words.trim().isNotEmpty) {
          handleSpokenTranscript(words.trim());
        }
      },
    );
  }

  Future<void> handleSpokenTranscript(String transcript) async {
    final trimmed = transcript.trim();
    if (trimmed.isEmpty) return;

    await _stt.stopListening();
    final sessionId =
        state.activeSessionId ?? 'android-voice-${_now().millisecondsSinceEpoch}';
    state = state.copyWith(
      state: VoiceLifecycleState.processing,
      activeSessionId: sessionId,
      lastTranscript: trimmed,
      statusText: 'Processing…',
    );

    final intent = _personality.classifyConversationIntent(
      trimmed,
      inActiveSession: state.hasGreetedInSession || state.isSessionActive,
    );

    if (intent.shouldEndConversation) {
      final farewell = _personality.generateFarewell(
        now: _now(),
        explicitGoodNight: intent.explicitGoodNight,
      );
      await _speakFarewellAndStandby(farewell);
      return;
    }

    if (intent.intent == ConversationIntentType.sleep) {
      await stopSession();
      return;
    }

    if (intent.intent == ConversationIntentType.cancel) {
      const cancelReply = 'Understood, Boss. Cancelled.';
      await _speakAndThen(cancelReply, () async {
        if (_isDisposed || state.activeSessionId != sessionId) return;
        await _beginListening();
      });
      return;
    }

    final commandText = intent.extractedCommand ?? trimmed;
    try {
      final res = await _executeCommand(commandText, sessionId);
      if (res.isFarewell) {
        await _speakFarewellAndStandby(
          _personality.sanitizeForSpeech(
              res.voiceSummary.isNotEmpty ? res.voiceSummary : res.reply),
        );
        return;
      }

      final toSpeak = _personality.sanitizeForSpeech(
        res.voiceSummary.isNotEmpty ? res.voiceSummary : res.reply,
      );
      await _speakAndThen(toSpeak, () async {
        if (_isDisposed || state.activeSessionId != sessionId) return;
        if (res.shouldListen) {
          await _beginListening();
        } else {
          await stopSession();
        }
      });
    } catch (_) {
      const errMsg = "I'm unable to reach FRIDAY at the moment, Boss.";
      await _speakAndThen(errMsg, () async {
        if (_isDisposed || state.activeSessionId != sessionId) return;
        await _beginListening();
      });
    }
  }

  /// Deduplicates backend WebSocket voice events so Android never speaks a duplicate greeting
  /// when it already owns the active local voice session.
  bool shouldSpeakBackendEvent(String eventId, String eventType) {
    if (_handledBackendEventIds.contains(eventId)) return false;
    _handledBackendEventIds.add(eventId);
    if (eventType == 'voice:session_start' && state.isSessionActive) {
      return false;
    }
    return true;
  }

  Future<void> onListeningTimeout() async {
    await _stt.stopListening();
    state = state.copyWith(
      state: VoiceLifecycleState.standby,
      clearSessionId: true,
      hasGreetedInSession: false,
      statusText: 'Standby. Tap microphone to start a voice session.',
    );
  }

  Future<void> stopSession() async {
    await _stt.stopListening();
    await _tts.stop();
    state = state.copyWith(
      state: VoiceLifecycleState.standby,
      clearSessionId: true,
      hasGreetedInSession: false,
      statusText: 'Standby. Tap microphone to start a voice session.',
    );
  }

  Future<void> _speakFarewellAndStandby(String farewell) async {
    await _speakAndThen(farewell, () async {
      if (_isDisposed) return;
      state = state.copyWith(
        state: VoiceLifecycleState.standby,
        clearSessionId: true,
        hasGreetedInSession: false,
        statusText: 'Standby. Tap microphone to start a voice session.',
      );
    });
  }

  Future<void> _speakAndThen(
    String text,
    Future<void> Function() onComplete,
  ) async {
    final sanitized = _personality.sanitizeForSpeech(text);
    state = state.copyWith(
      state: VoiceLifecycleState.speaking,
      lastSpokenText: sanitized,
      statusText: sanitized,
    );
    if (sanitized.isNotEmpty) {
      await _tts.speak(sanitized);
    }
    await onComplete();
  }

  @override
  void dispose() {
    _isDisposed = true;
    super.dispose();
  }
}
