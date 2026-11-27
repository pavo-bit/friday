# FRIDAY — Android Companion Installation & Pairing Guide

## 1. APK Build (Verified)
```powershell
cd friday_companion
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```
Output APK: `friday_companion/build/app/outputs/flutter-apk/app-debug.apk`.

## 2. Samsung Galaxy M35 Installation & Pairing (Gate G5 — UNVERIFIED)
1. Enable USB Debugging on the Samsung Galaxy M35 or transfer `app-debug.apk` to the phone and install.
2. Ensure the phone and Windows host are on the same local Wi-Fi network, and set the server URL in **Connection Settings** (`http://<windows-lan-ip>:3141`).
3. On the Windows Dashboard (**Settings & Security**), click **Generate Pairing Code** (6-digit, 5-minute expiry).
4. Enter the pairing code in the Android app's Pairing screen.
5. Verify:
   - Identity & Personality screen syncs `preferredAddress` (`Boss`) and `ADAPTIVE` defaults.
   - Projects screen lists and switches active project context.
   - Revoking the device from Windows Dashboard immediately returns `401` on the phone (`sessionExpired = true`).
