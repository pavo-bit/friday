import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract class SecureStorageService {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
  Future<void> clearAll();
}

class KeystoreSecureStorage implements SecureStorageService {
  static const _androidOptions = AndroidOptions(
    encryptedSharedPreferences: true,
  );

  final FlutterSecureStorage _storage;

  KeystoreSecureStorage([FlutterSecureStorage? storage])
      : _storage =
            storage ?? const FlutterSecureStorage(aOptions: _androidOptions);

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);

  @override
  Future<void> clearAll() => _storage.deleteAll();
}

class InMemorySecureStorage implements SecureStorageService {
  final Map<String, String> _store = {};

  @override
  Future<String?> read(String key) async => _store[key];

  @override
  Future<void> write(String key, String value) async => _store[key] = value;

  @override
  Future<void> delete(String key) async => _store.remove(key);

  @override
  Future<void> clearAll() async => _store.clear();
}

class SecureKeys {
  static const bearerToken = 'friday_bearer_token';
  static const deviceId = 'friday_device_id';
  static const serverUrl = 'friday_server_url';
  static const onboardingDone = 'friday_onboarding_done';
}
