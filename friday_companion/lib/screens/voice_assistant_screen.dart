import 'package:flutter/material.dart';
import 'package:speech_to_text/speech_to_text.dart';
import 'package:flutter_tts/flutter_tts.dart';
import '../services/friday_api_client.dart';

class VoiceAssistantScreen extends StatefulWidget {
  final FridayApiClient client;
  const VoiceAssistantScreen({super.key, required this.client});

  @override
  State<VoiceAssistantScreen> createState() => _VoiceAssistantScreenState();
}

class _VoiceAssistantScreenState extends State<VoiceAssistantScreen> {
  final SpeechToText _stt = SpeechToText();
  final FlutterTts _tts = FlutterTts();
  bool _listening = false;
  String _transcript = 'Tap the microphone to speak to FRIDAY.';
  String _reply = '';

  Future<void> _toggleListen() async {
    if (_listening) {
      await _stt.stop();
      setState(() => _listening = false);
      return;
    }

    final ok = await _stt.initialize();
    if (!ok) {
      setState(() => _transcript = 'Microphone permission or speech recognition is unavailable.');
      return;
    }

    setState(() => _listening = true);
    await _stt.listen(onResult: (result) async {
      setState(() => _transcript = result.recognizedWords);
      if (result.finalResult && result.recognizedWords.trim().isNotEmpty) {
        setState(() => _listening = false);
        try {
          final reply = await widget.client.sendMessage(result.recognizedWords);
          setState(() => _reply = reply);
          await _tts.speak(reply);
        } catch (e) {
          setState(() => _reply = e.toString());
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Voice Assistant')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(_transcript, textAlign: TextAlign.center, style: const TextStyle(fontSize: 16)),
            const SizedBox(height: 20),
            if (_reply.isNotEmpty) Text(_reply, textAlign: TextAlign.center, style: const TextStyle(color: Colors.lightBlueAccent)),
            const SizedBox(height: 32),
            FloatingActionButton.large(
              onPressed: _toggleListen,
              backgroundColor: _listening ? Colors.redAccent : Colors.blueAccent,
              child: Icon(_listening ? Icons.stop : Icons.mic),
            ),
            const SizedBox(height: 16),
            TextButton(onPressed: () => _tts.stop(), child: const Text('Stop Speaking')),
          ],
        ),
      ),
    );
  }
}
