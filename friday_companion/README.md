# FRIDAY Android Companion (Flutter)

Local-first Flutter Android companion application for the FRIDAY personal AI assistant (`pavo-bit/friday`).

## Architecture Overview

- **State Management:** Riverpod (`flutter_riverpod`)
- **Navigation:** GoRouter (`go_router`)
- **Networking:** Dio (`dio`) + WebSocket (`web_socket_channel`)
- **Secure Storage:** `flutter_secure_storage` (Android Keystore-backed `encryptedSharedPreferences`)
- **Local Cache:** SQLite (`sqflite`) for cached conversations & standalone activity records
- **Phone Telemetry:** `battery_plus`, `device_info_plus`

### Operating Modes
1. **Connected Mode:** Connects over LAN or private Tailscale/WireGuard to the laptop FRIDAY engine (`Ollama qwen3:4b` + `Claw`).
2. **Standalone Mode:** When the laptop is offline, exposes phone battery/device telemetry, cached conversation history, and local activity logs without faking laptop AI availability.

## Validation Commands

```powershell
cd friday_companion
flutter doctor -v
flutter pub get
dart format --output=none --set-exit-if-changed .
flutter analyze
flutter test
```

## Missing Backend Requirements (Documented for Future Phases)
- Two-device interactive pairing confirmation prompt on the laptop before issuing device tokens.
- WebSocket bearer-token authentication for non-localhost companion connections.
- Gateway endpoints for installed apps inventory (`/friday/devices/:id/apps`), usage summaries (`/friday/devices/:id/usage`), single-use action approvals, and MediaProjection screen-sharing sessions.
