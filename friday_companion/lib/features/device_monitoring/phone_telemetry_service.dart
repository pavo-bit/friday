import 'dart:io';
import 'package:battery_plus/battery_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';

class PhoneTelemetrySnapshot {
  final int? batteryLevel;
  final String batteryState;
  final String deviceModel;
  final String osVersion;
  final String platform;

  const PhoneTelemetrySnapshot({
    required this.batteryLevel,
    required this.batteryState,
    required this.deviceModel,
    required this.osVersion,
    required this.platform,
  });
}

class PhoneTelemetryService {
  final Battery _battery;
  final DeviceInfoPlugin _deviceInfo;

  PhoneTelemetryService({
    Battery? battery,
    DeviceInfoPlugin? deviceInfo,
  })  : _battery = battery ?? Battery(),
        _deviceInfo = deviceInfo ?? DeviceInfoPlugin();

  Future<PhoneTelemetrySnapshot> collect() async {
    int? level;
    String batteryState = 'unknown';
    try {
      level = await _battery.batteryLevel;
      final state = await _battery.batteryState;
      batteryState = state.name;
    } catch (_) {
      // Some desktop/test hosts do not expose battery hardware
    }

    String model = 'Android Companion';
    String osVersion = Platform.operatingSystemVersion;

    try {
      if (Platform.isAndroid) {
        final info = await _deviceInfo.androidInfo;
        model = '${info.manufacturer} ${info.model}';
        osVersion =
            'Android ${info.version.release} (SDK ${info.version.sdkInt})';
      } else if (Platform.isWindows) {
        final info = await _deviceInfo.windowsInfo;
        model = info.computerName;
      }
    } catch (_) {
      // Fallback safely
    }

    return PhoneTelemetrySnapshot(
      batteryLevel: level,
      batteryState: batteryState,
      deviceModel: model,
      osVersion: osVersion,
      platform: Platform.operatingSystem,
    );
  }
}
