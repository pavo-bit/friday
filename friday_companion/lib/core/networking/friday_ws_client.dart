import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

typedef WsEventHandler = void Function(Map<String, dynamic> message);

/// Authenticated WebSocket client for /friday/ws.
/// Sends Bearer token in Authorization header (never in URL query string).
class FridayWsClient {
  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  Timer? _reconnectTimer;
  bool _disposed = false;
  int _attempt = 0;

  String? _baseUrl;
  String? _bearerToken;
  final Set<String> _seenEventKeys = {};
  final List<WsEventHandler> _listeners = [];

  bool get isConnected => _channel != null;

  void addListener(WsEventHandler handler) {
    _listeners.add(handler);
  }

  void removeListener(WsEventHandler handler) {
    _listeners.remove(handler);
  }

  Uri buildWsUri(String baseUrl) {
    final parsed = Uri.parse(baseUrl.trim());
    final scheme = parsed.scheme == 'https' ? 'wss' : 'ws';
    return Uri(
      scheme: scheme,
      host: parsed.host,
      port: parsed.hasPort ? parsed.port : null,
      path: '/friday/ws',
    );
  }

  void connect({required String baseUrl, required String bearerToken}) {
    _disposed = false;
    _baseUrl = baseUrl;
    _bearerToken = bearerToken;
    _openChannel();
  }

  void _openChannel() {
    if (_disposed || _baseUrl == null || _bearerToken == null || _bearerToken!.isEmpty) {
      return;
    }
    _sub?.cancel();
    _channel?.sink.close();

    final uri = buildWsUri(_baseUrl!);
    _channel = IOWebSocketChannel.connect(
      uri,
      headers: {'Authorization': 'Bearer $_bearerToken'},
    );

    _sub = _channel!.stream.listen(
      (raw) {
        _attempt = 0;
        try {
          final decoded = jsonDecode(raw.toString()) as Map<String, dynamic>;
          final key =
              '${decoded['type']}:${decoded['timestamp']}:${decoded['payload'] is Map ? (decoded['payload'] as Map)['taskId'] ?? '' : ''}';
          if (_seenEventKeys.contains(key)) return;
          _seenEventKeys.add(key);
          for (final l in List<WsEventHandler>.from(_listeners)) {
            l(decoded);
          }
        } catch (_) {
          // Ignore malformed frame
        }
      },
      onDone: _scheduleReconnect,
      onError: (_) => _scheduleReconnect(),
    );
  }

  void _scheduleReconnect() {
    _channel = null;
    if (_disposed) return;
    _reconnectTimer?.cancel();
    final delaySec = (_attempt < 4) ? (1 << _attempt) : 16;
    _attempt++;
    _reconnectTimer = Timer(Duration(seconds: delaySec), _openChannel);
  }

  void disconnect() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _sub?.cancel();
    _channel?.sink.close();
    _channel = null;
  }
}
