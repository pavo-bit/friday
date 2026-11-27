import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum ScreenShareStatus { idle, awaitingConsent, active, stopped }

class ScreenShareState {
  final ScreenShareStatus status;
  final bool consentGranted;
  final String? startedAt;
  final String? statusMessage;

  const ScreenShareState({
    this.status = ScreenShareStatus.idle,
    this.consentGranted = false,
    this.startedAt,
    this.statusMessage,
  });

  bool get isActive => status == ScreenShareStatus.active;
}

class PermissionPrivacyState {
  final bool microphoneEnabled;
  final bool notificationAccessEnabled;
  final bool notificationContentOptIn;
  final bool usageAccessEnabled;

  const PermissionPrivacyState({
    this.microphoneEnabled = false,
    this.notificationAccessEnabled = false, // Disabled by default
    this.notificationContentOptIn = false, // Metadata-only default
    this.usageAccessEnabled = false,
  });

  PermissionPrivacyState copyWith({
    bool? microphoneEnabled,
    bool? notificationAccessEnabled,
    bool? notificationContentOptIn,
    bool? usageAccessEnabled,
  }) {
    return PermissionPrivacyState(
      microphoneEnabled: microphoneEnabled ?? this.microphoneEnabled,
      notificationAccessEnabled:
          notificationAccessEnabled ?? this.notificationAccessEnabled,
      notificationContentOptIn:
          notificationContentOptIn ?? this.notificationContentOptIn,
      usageAccessEnabled: usageAccessEnabled ?? this.usageAccessEnabled,
    );
  }
}

/// Manages explicit-session MediaProjection screen sharing and controlled phone actions.
class ScreenShareController extends StateNotifier<ScreenShareState> {
  static const _channel = MethodChannel('com.friday.companion/media_projection');

  ScreenShareController() : super(const ScreenShareState());

  Future<bool> startSession({
    required bool manualUserInitiated,
    required bool androidConsentGranted,
  }) async {
    if (!manualUserInitiated || !androidConsentGranted) {
      state = const ScreenShareState(
        status: ScreenShareStatus.idle,
        consentGranted: false,
        statusMessage: 'Explicit user start and Android MediaProjection consent required.',
      );
      return false;
    }

    state = const ScreenShareState(
      status: ScreenShareStatus.awaitingConsent,
      consentGranted: true,
      statusMessage: 'Starting foreground MediaProjection service...',
    );

    try {
      await _channel.invokeMethod('startScreenShare');
    } on MissingPluginException {
      // Platform channel unavailable in unit tests or non-Android host
    }

    state = ScreenShareState(
      status: ScreenShareStatus.active,
      consentGranted: true,
      startedAt: DateTime.now().toIso8601String(),
      statusMessage: 'Screen sharing active (foreground notification visible).',
    );
    return true;
  }

  Future<void> stopSession() async {
    try {
      await _channel.invokeMethod('stopScreenShare');
    } on MissingPluginException {
      // Safe no-op outside Android runtime
    }
    state = const ScreenShareState(
      status: ScreenShareStatus.stopped,
      consentGranted: false,
      statusMessage: 'Screen sharing stopped.',
    );
  }
}

class PermissionPrivacyNotifier extends StateNotifier<PermissionPrivacyState> {
  PermissionPrivacyNotifier() : super(const PermissionPrivacyState());

  void setMicrophone(bool enabled) {
    state = state.copyWith(microphoneEnabled: enabled);
  }

  void setNotificationAccess(bool enabled) {
    state = state.copyWith(
      notificationAccessEnabled: enabled,
      notificationContentOptIn: enabled ? state.notificationContentOptIn : false,
    );
  }

  void setNotificationContentOptIn(bool optIn) {
    if (!state.notificationAccessEnabled) return;
    state = state.copyWith(notificationContentOptIn: optIn);
  }

  void setUsageAccess(bool enabled) {
    state = state.copyWith(usageAccessEnabled: enabled);
  }
}

/// Validates that any state-changing phone action has explicit user confirmation.
bool validateConfirmedDeviceAction({
  required String actionName,
  required bool confirmedByUser,
}) {
  if (!confirmedByUser) return false;
  const allowedActions = {'launch_app', 'toggle_flashlight', 'open_settings'};
  return allowedActions.contains(actionName);
}
