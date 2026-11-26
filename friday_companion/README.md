# FRIDAY Android Companion (Flutter)

Local-first Flutter companion application for FRIDAY.

## Features & Screens
1. Splash Screen (`lib/screens/splash_screen.dart`)
2. Secure Pairing / Login Screen (`lib/screens/pairing_screen.dart`)
3. Home Dashboard (`lib/screens/home_dashboard_screen.dart`)
4. Conversation Interface (`lib/screens/conversation_screen.dart`)
5. Voice Assistant Interface (`lib/screens/voice_assistant_screen.dart`)
6. Active Monitoring Screen (`lib/screens/monitoring_screen.dart`)
7. Alerts & Notifications (`lib/screens/alerts_screen.dart`)
8. Reminders & Alarms (`lib/screens/reminders_screen.dart`)
9. Saved Locations & Geofences (`lib/screens/locations_screen.dart`)
10. Device & Connection Settings (`lib/screens/device_settings_screen.dart`)
11. Privacy & Permission Settings (`lib/screens/privacy_settings_screen.dart`)
12. Profile & Logout (`lib/screens/profile_screen.dart`)

## Android Setup Instructions

1. Ensure Flutter SDK (3.3+) and Android SDK are installed.
2. Fetch packages:
   ```powershell
   cd friday_companion
   flutter pub get
   ```
3. Run static analysis and unit tests:
   ```powershell
   flutter analyze
   flutter test
   ```
4. Build APK or run on connected Android device/emulator:
   ```powershell
   flutter build apk --debug
   # or
   flutter run
   ```
5. Pair with your laptop's FRIDAY server:
   - Open FRIDAY Dashboard (`http://127.0.0.1:3141`) -> **Settings & Security** -> **Generate Pairing Code**.
   - In the Android app, enter your laptop's LAN IP (or `http://10.0.2.2:3141` on Android Emulator) and the 6-digit pairing code.
