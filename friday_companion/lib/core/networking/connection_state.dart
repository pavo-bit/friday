import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ConnectionStatus {
  connected,
  connecting,
  disconnected,
  reconnecting,
  authRequired,
}

class ConnectionSnapshot {
  final ConnectionStatus status;
  final String serverUrl;
  final String? detail;
  final DateTime? lastCheckedAt;
  final bool isPaired;

  const ConnectionSnapshot({
    required this.status,
    required this.serverUrl,
    this.detail,
    this.lastCheckedAt,
    this.isPaired = false,
  });

  bool get isConnected => status == ConnectionStatus.connected;
  bool get isStandalone =>
      status == ConnectionStatus.disconnected ||
      status == ConnectionStatus.authRequired;

  String get label {
    switch (status) {
      case ConnectionStatus.connected:
        return 'Connected';
      case ConnectionStatus.connecting:
        return 'Connecting';
      case ConnectionStatus.disconnected:
        return 'Disconnected (Standalone)';
      case ConnectionStatus.reconnecting:
        return 'Reconnecting';
      case ConnectionStatus.authRequired:
        return 'Authentication Required';
    }
  }

  ConnectionSnapshot copyWith({
    ConnectionStatus? status,
    String? serverUrl,
    String? detail,
    DateTime? lastCheckedAt,
    bool? isPaired,
  }) {
    return ConnectionSnapshot(
      status: status ?? this.status,
      serverUrl: serverUrl ?? this.serverUrl,
      detail: detail ?? this.detail,
      lastCheckedAt: lastCheckedAt ?? this.lastCheckedAt,
      isPaired: isPaired ?? this.isPaired,
    );
  }
}

class ConnectionStateNotifier extends StateNotifier<ConnectionSnapshot> {
  ConnectionStateNotifier(String initialUrl)
      : super(
          ConnectionSnapshot(
            status: ConnectionStatus.disconnected,
            serverUrl: initialUrl,
          ),
        );

  void setConnecting(String url) {
    state = state.copyWith(
      status: ConnectionStatus.connecting,
      serverUrl: url,
      detail: 'Checking FRIDAY laptop brain…',
      lastCheckedAt: DateTime.now(),
    );
  }

  void setReconnecting() {
    state = state.copyWith(
      status: ConnectionStatus.reconnecting,
      detail: 'Attempting to reconnect…',
      lastCheckedAt: DateTime.now(),
    );
  }

  void setConnected({required bool isPaired, String? detail}) {
    state = state.copyWith(
      status: ConnectionStatus.connected,
      isPaired: isPaired,
      detail: detail ?? 'Connected to FRIDAY intelligence host',
      lastCheckedAt: DateTime.now(),
    );
  }

  void setDisconnected(String reason) {
    state = state.copyWith(
      status: ConnectionStatus.disconnected,
      detail: reason,
      lastCheckedAt: DateTime.now(),
    );
  }

  void setAuthRequired({String? detail}) {
    state = state.copyWith(
      status: ConnectionStatus.authRequired,
      isPaired: false,
      detail: detail ?? 'Pairing or bearer token required',
      lastCheckedAt: DateTime.now(),
    );
  }
}
