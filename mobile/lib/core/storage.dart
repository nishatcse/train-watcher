import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The device token is the only credential the app holds, so it lives in the
/// Android Keystore-backed secure storage rather than plain preferences.
class Storage {
  Storage() : _s = const FlutterSecureStorage();
  final FlutterSecureStorage _s;

  static const _tokenKey = 'device_token';
  static const _urlKey = 'backend_url';

  Future<String?> readToken() => _s.read(key: _tokenKey);
  Future<String?> readBaseUrl() => _s.read(key: _urlKey);

  Future<void> saveAuth({required String token, required String baseUrl}) async {
    await _s.write(key: _tokenKey, value: token);
    await _s.write(key: _urlKey, value: baseUrl);
  }

  Future<void> clearToken() => _s.delete(key: _tokenKey);
}
