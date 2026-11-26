import 'package:flutter/material.dart';
import '../models/friday_models.dart';
import '../services/friday_api_client.dart';

class ConversationScreen extends StatefulWidget {
  final FridayApiClient client;
  const ConversationScreen({super.key, required this.client});

  @override
  State<ConversationScreen> createState() => _ConversationScreenState();
}

class _ConversationScreenState extends State<ConversationScreen> {
  final _ctrl = TextEditingController();
  final List<ChatMessage> _messages = [
    ChatMessage(role: 'assistant', text: "Systems ready. What would you like me to handle?", timestamp: ''),
  ];
  bool _sending = false;

  Future<void> _send() async {
    final text = _ctrl.text.trim();
    if (text.isEmpty || _sending) return;
    _ctrl.clear();
    setState(() {
      _messages.add(ChatMessage(role: 'user', text: text, timestamp: 'Now'));
      _sending = true;
    });
    try {
      final reply = await widget.client.sendMessage(text);
      setState(() => _messages.add(ChatMessage(role: 'assistant', text: reply, timestamp: 'Now')));
    } catch (e) {
      setState(() => _messages.add(ChatMessage(role: 'assistant', text: e.toString(), timestamp: 'Offline')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(12),
            itemCount: _messages.length,
            itemBuilder: (_, idx) {
              final m = _messages[idx];
              final isUser = m.role == 'user';
              return Align(
                alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
                child: Container(
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: isUser ? const Color(0xFF1D4ED8) : const Color(0xFF162033),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(m.text),
                ),
              );
            },
          ),
        ),
        Padding(
          padding: const EdgeInsets.all(10),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  decoration: const InputDecoration(hintText: 'Message FRIDAY…', border: OutlineInputBorder()),
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: const Icon(Icons.send),
                onPressed: _sending ? null : _send,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
