// ============================================================
// FRIDAY Companion — Time-Aware Personality & Intent Engine
// Shared rules with desktop GreetingService & conversationIntent
// ============================================================

enum TimeOfDayPeriod { morning, afternoon, evening, night }

enum ConversationIntentType {
  greeting,
  wake,
  normalCommand,
  followUp,
  goodbye,
  goodNight,
  cancel,
  sleep,
  resume,
}

class ConversationIntentResult {
  final ConversationIntentType intent;
  final double confidence;
  final String? extractedCommand;
  final bool hasGreetingPrefix;
  final bool explicitGoodNight;
  final bool shouldEndConversation;

  const ConversationIntentResult({
    required this.intent,
    required this.confidence,
    this.extractedCommand,
    this.hasGreetingPrefix = false,
    this.explicitGoodNight = false,
    this.shouldEndConversation = false,
  });
}

class FridayPersonalityEngine {
  String _lastWakeGreeting = '';
  String _lastFarewell = '';

  static final List<RegExp> _goodNightExactPatterns = [
    RegExp(
      r"^(?:ok(?:ay)?|alright|thanks|thank\s+you)?[,\s]*(?:good\s*night|goodnight)(?:\s*,?\s*(?:friday|boss))?[.!?\s]*$",
      caseSensitive: false,
    ),
    RegExp(
      r"^(?:friday)[,\s]+(?:good\s*night|goodnight)[.!?\s]*$",
      caseSensitive: false,
    ),
  ];

  static final List<RegExp> _goodbyePatterns = [
    RegExp(
      r"^(?:ok(?:ay)?|alright|well)?[,\s]*(?:goodbye|good\s*bye|bye(?:\s+bye)?|see\s+you(?:\s+later|\s+soon)?|later|ciao)(?:\s*,?\s*(?:friday|boss))?[.!?\s]*$",
      caseSensitive: false,
    ),
    RegExp(
      r"^(?:friday)[,\s]+(?:goodbye|good\s*bye|bye)[.!?\s]*$",
      caseSensitive: false,
    ),
    RegExp(
      r"^(?:thank\s+you|thanks)[,\s]+(?:that'?s\s+(?:all|everything)|you\s+can\s+go\s+to\s+standby)(?:\s+(?:for\s+now|today))?(?:\s*,?\s*friday)?[.!?\s]*$",
      caseSensitive: false,
    ),
    RegExp(
      r"^(?:that'?s\s+all(?:\s+for\s+now)?|that'?s\s+everything(?:\s+for\s+now)?|i'?m\s+done(?:\s+for\s+now)?|end\s+(?:this\s+)?conversation|close\s+(?:this\s+)?conversation|you\s+(?:can|may)\s+go\s+to\s+standby|go\s+to\s+standby|stand\s*by(?:\s+now)?|nothing\s+else(?:\s+for\s+now)?)(?:\s*,?\s*friday)?[.!?\s]*$",
      caseSensitive: false,
    ),
  ];

  static final List<RegExp> _cancelPatterns = [
    RegExp(
      r"^(?:cancel(?:\s+(?:that|this|the)\s+(?:command|request|action|task|operation))?|abort(?:\s+(?:that|this|the)\s+(?:command|request|action))?|never\s*mind|forget\s+it|stop\s+that)(?:\s*,?\s*friday)?[.!?\s]*$",
      caseSensitive: false,
    ),
  ];

  static final List<RegExp> _sleepPatterns = [
    RegExp(
      r"^(?:go\s+to\s+sleep|sleep\s+mode|enter\s+sleep(?:\s+mode)?|friday[,\s]+(?:go\s+to\s+sleep|sleep))(?:\s*,?\s*friday)?[.!?\s]*$",
      caseSensitive: false,
    ),
  ];

  static final List<RegExp> _resumePatterns = [
    RegExp(
      r"^(?:resume|continue|keep\s+going|go\s+ahead|carry\s+on)(?:\s*,?\s*friday)?[.!?\s]*$",
      caseSensitive: false,
    ),
  ];

  static final RegExp _wakePrefixRegex = RegExp(
    r"^(?:(?:hey|hello|hi|ok(?:ay)?|wake\s+up)\s*,?\s*friday|friday\s+(?:wake\s+up|listen))[!.,\s]*(.*)$",
    caseSensitive: false,
  );

  static final RegExp _greetingPrefixRegex = RegExp(
    r"^(?:(?:good\s*(?:morning|afternoon|evening)|hi|hello|hey|greetings|howdy)(?:\s*,?\s*friday)?)[!.,\s]*(.*)$",
    caseSensitive: false,
  );

  /// Classify local hour (0-23):
  /// 05:00-11:59 -> morning
  /// 12:00-16:59 -> afternoon
  /// 17:00-20:59 -> evening
  /// 21:00-04:59 -> night (Good evening when greeting; Good night when saying farewell)
  TimeOfDayPeriod classifyTimeOfDay(int hour) {
    if (hour >= 5 && hour < 12) return TimeOfDayPeriod.morning;
    if (hour >= 12 && hour < 17) return TimeOfDayPeriod.afternoon;
    if (hour >= 17 && hour < 21) return TimeOfDayPeriod.evening;
    return TimeOfDayPeriod.night;
  }

  /// Salutation for greetings. Never returns "Good night".
  String greetingSalutation({DateTime? now}) {
    final local = (now ?? DateTime.now()).toLocal();
    return switch (classifyTimeOfDay(local.hour)) {
      TimeOfDayPeriod.morning => 'Good morning',
      TimeOfDayPeriod.afternoon => 'Good afternoon',
      TimeOfDayPeriod.evening || TimeOfDayPeriod.night => 'Good evening',
    };
  }

  String generateDashboardGreeting({DateTime? now, String userName = 'Boss'}) {
    final name = userName.trim().isEmpty ? 'Boss' : userName.trim();
    return '${greetingSalutation(now: now)}, $name.';
  }

  String generateWakeGreeting({DateTime? now, String userName = 'Boss'}) {
    final local = (now ?? DateTime.now()).toLocal();
    final period = classifyTimeOfDay(local.hour);
    final name = userName.trim().isEmpty ? 'Boss' : userName.trim();

    final variations = switch (period) {
      TimeOfDayPeriod.morning => [
          "Good morning, $name. FRIDAY is online. I'm ready for your instructions.",
          'Good morning, $name. All systems are operational. How may I assist you?',
          "Good morning, $name. I'm ready when you are.",
        ],
      TimeOfDayPeriod.afternoon => [
          'Good afternoon, $name. FRIDAY is online and ready to assist.',
          'Good afternoon, $name. What would you like me to take care of?',
          "Good afternoon, $name. I'm listening.",
        ],
      TimeOfDayPeriod.evening => [
          'Good evening, $name. Welcome back. How may I assist you?',
          "Good evening, $name. I'm online and ready for your instructions.",
          'Good evening, $name. What can I take care of for you?',
        ],
      TimeOfDayPeriod.night => [
          "Good evening, $name. I'm online. What do you need?",
          'Welcome back, $name. FRIDAY is ready to assist.',
        ],
    };

    final nonRepeating =
        variations.where((v) => v != _lastWakeGreeting).toList();
    final pool = nonRepeating.isNotEmpty ? nonRepeating : variations;
    final idx = (local.day + local.hour + local.minute) % pool.length;
    final chosen = pool[idx];
    _lastWakeGreeting = chosen;
    return chosen;
  }

  String generateFarewell({
    DateTime? now,
    bool explicitGoodNight = false,
    String userName = 'Boss',
  }) {
    final local = (now ?? DateTime.now()).toLocal();
    final period = classifyTimeOfDay(local.hour);
    final name = userName.trim().isEmpty ? 'Boss' : userName.trim();
    final isNightFarewell = explicitGoodNight || period == TimeOfDayPeriod.night;

    final daytimeFarewells = [
      'Certainly, $name. That will be all for now. Have a productive day.',
      "Understood, $name. I'll be standing by. Have a pleasant day.",
      "Very well, $name. Have a good day. I'll be here when you need me.",
    ];

    final eveningFarewells = [
      "Of course, $name. Have a pleasant evening. I'll be standing by.",
      "Understood, $name. Enjoy your evening. I'll be ready whenever you need me.",
    ];

    final nightFarewells = [
      "Good night, $name. Have a restful night. I'll be standing by.",
      'Good night, $name. Rest well. FRIDAY will be ready when you return.',
    ];

    final candidates = isNightFarewell
        ? nightFarewells
        : period == TimeOfDayPeriod.evening
            ? eveningFarewells
            : daytimeFarewells;

    final nonRepeating =
        candidates.where((c) => c != _lastFarewell).toList();
    final pool = nonRepeating.isNotEmpty ? nonRepeating : candidates;
    final idx = (local.day + local.hour + local.minute) % pool.length;
    final chosen = pool[idx];
    _lastFarewell = chosen;
    return chosen;
  }

  ConversationIntentResult classifyConversationIntent(
    String rawText, {
    bool inActiveSession = false,
  }) {
    final normalized = rawText.trim().replaceAll(RegExp(r'\s+'), ' ');
    if (normalized.isEmpty) {
      return ConversationIntentResult(
        intent: inActiveSession
            ? ConversationIntentType.followUp
            : ConversationIntentType.normalCommand,
        confidence: 0,
      );
    }

    for (final p in _cancelPatterns) {
      if (p.hasMatch(normalized)) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.cancel,
          confidence: 0.96,
        );
      }
    }

    for (final p in _sleepPatterns) {
      if (p.hasMatch(normalized)) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.sleep,
          confidence: 0.96,
        );
      }
    }

    for (final p in _goodNightExactPatterns) {
      if (p.hasMatch(normalized)) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.goodNight,
          confidence: 0.98,
          explicitGoodNight: true,
          shouldEndConversation: true,
        );
      }
    }

    for (final p in _goodbyePatterns) {
      if (p.hasMatch(normalized)) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.goodbye,
          confidence: 0.97,
          shouldEndConversation: true,
        );
      }
    }

    for (final p in _resumePatterns) {
      if (p.hasMatch(normalized)) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.resume,
          confidence: 0.92,
        );
      }
    }

    final wakeMatch = _wakePrefixRegex.firstMatch(normalized);
    if (wakeMatch != null) {
      final remainder = (wakeMatch.group(1) ?? '').trim();
      if (remainder.isEmpty) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.wake,
          confidence: 0.96,
        );
      }
      final inner =
          classifyConversationIntent(remainder, inActiveSession: inActiveSession);
      if (inner.shouldEndConversation ||
          inner.intent == ConversationIntentType.cancel ||
          inner.intent == ConversationIntentType.sleep) {
        return inner;
      }
      return ConversationIntentResult(
        intent: ConversationIntentType.wake,
        confidence: 0.94,
        extractedCommand: remainder,
      );
    }

    final greetMatch = _greetingPrefixRegex.firstMatch(normalized);
    if (greetMatch != null) {
      final remainder = (greetMatch.group(1) ?? '').trim();
      if (remainder.isEmpty) {
        return const ConversationIntentResult(
          intent: ConversationIntentType.greeting,
          confidence: 0.95,
          hasGreetingPrefix: true,
        );
      }
      final inner =
          classifyConversationIntent(remainder, inActiveSession: inActiveSession);
      if (inner.shouldEndConversation ||
          inner.intent == ConversationIntentType.cancel ||
          inner.intent == ConversationIntentType.sleep) {
        return inner;
      }
      return ConversationIntentResult(
        intent: inActiveSession
            ? ConversationIntentType.followUp
            : ConversationIntentType.normalCommand,
        confidence: 0.92,
        extractedCommand: remainder,
        hasGreetingPrefix: true,
      );
    }

    return ConversationIntentResult(
      intent: inActiveSession
          ? ConversationIntentType.followUp
          : ConversationIntentType.normalCommand,
      confidence: 0.85,
      extractedCommand: normalized,
    );
  }

  String sanitizeForSpeech(String text) {
    if (text.isEmpty) return '';
    return text
        .replaceAll(RegExp(r'```[\s\S]*?```'), ' code block omitted ')
        .replaceAllMapped(RegExp(r'`([^`]+)`'), (m) => m.group(1) ?? '')
        .replaceAll(RegExp(r'https?://\S+'), 'link')
        .replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]+\)'), (m) => m.group(1) ?? '')
        .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
        .replaceAll(RegExp(r'^[\*\-+]\s+', multiLine: true), '')
        .replaceAll(RegExp(r'^\d+\.\s+', multiLine: true), '')
        .replaceAllMapped(RegExp(r'[\*_]{1,3}([^*_]+)[\*_]{1,3}'), (m) => m.group(1) ?? '')
        .replaceAll(RegExp(r'<[^>]+>'), '')
        .replaceAll(RegExp(r'[~^_|\\{}\[\]]'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }
}
