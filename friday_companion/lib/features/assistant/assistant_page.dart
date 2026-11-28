import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../app/app_theme.dart';
import '../../app/providers.dart';
import '../../core/voice/voice_session_controller.dart';

class AssistantPage extends ConsumerStatefulWidget {
  const AssistantPage({super.key});

  @override
  ConsumerState<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends ConsumerState<AssistantPage> {
  final _ctrl = TextEditingController();
  bool _sending = false;

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _sending) return;
    _ctrl.clear();
    setState(() => _sending = true);
    try {
      await ref.read(companionControllerProvider).sendMessage(text);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final conn = ref.watch(connectionStateProvider);
    final messages = ref.watch(cachedMessagesProvider);
    final voice = ref.watch(voiceSessionProvider);
    final voiceCtrl = ref.read(voiceSessionProvider.notifier);

    return Scaffold(
      appBar: AppBar(
        title: const Text('FRIDAY Assistant'),
        actions: [
          IconButton(
            tooltip: voice.isSessionActive
                ? 'Stop Voice Session'
                : 'Start Voice Session',
            icon: Icon(
              voice.isSessionActive ? Icons.mic_off : Icons.mic,
              color: voice.state == VoiceLifecycleState.listening
                  ? FridayTheme.danger
                  : FridayTheme.cyanAccent,
            ),
            onPressed: () {
              if (voice.isSessionActive) {
                voiceCtrl.stopSession();
              } else {
                voiceCtrl.startSession();
              }
            },
          ),
        ],
      ),
      body: Column(
        children: [
          if (voice.state != VoiceLifecycleState.standby)
            Container(
              width: double.infinity,
              color: FridayTheme.primary.withValues(alpha: 0.16),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                children: [
                  const Icon(Icons.graphic_eq,
                      size: 18, color: FridayTheme.cyanAccent),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      '${voice.state.name.toUpperCase()}: ${voice.statusText}',
                      style: const TextStyle(
                          color: FridayTheme.cyanAccent, fontSize: 12.5),
                    ),
                  ),
                ],
              ),
            ),
          if (!conn.isConnected)
            Container(
              width: double.infinity,
              color: FridayTheme.warning.withValues(alpha: 0.16),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: const Text(
                'Standalone Mode: Laptop brain is offline. Viewing cached conversation history.',
                style: TextStyle(color: FridayTheme.warning, fontSize: 12.5),
              ),
            ),
          Expanded(
            child: messages.isEmpty
                ? const Center(
                    child: Text(
                      'No messages yet. Ask FRIDAY anything when connected.',
                      style: TextStyle(color: FridayTheme.textMuted),
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.all(14),
                    itemCount: messages.length,
                    itemBuilder: (_, idx) {
                      final m = messages[idx];
                      final isUser = m.role == 'user';
                      return Align(
                        alignment: isUser
                            ? Alignment.centerRight
                            : Alignment.centerLeft,
                        child: Container(
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          padding: const EdgeInsets.all(12),
                          constraints: const BoxConstraints(maxWidth: 310),
                          decoration: BoxDecoration(
                            color: isUser
                                ? FridayTheme.primary
                                : FridayTheme.surfaceElevated,
                            borderRadius: BorderRadius.circular(12),
                            border: isUser
                                ? null
                                : Border.all(color: FridayTheme.border),
                          ),
                          child: Text(m.text),
                        ),
                      );
                    },
                  ),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _ctrl,
                    decoration: InputDecoration(
                      hintText: conn.isConnected
                          ? 'Message FRIDAY…'
                          : 'Offline — messages will be cached locally',
                    ),
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _sending ? null : _send,
                  icon: _sending
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.send),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
