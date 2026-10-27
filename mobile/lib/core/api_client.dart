import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, {this.details});
  final int status; // 0 = never reached the server
  final String code;
  final String message;
  final Map<String, dynamic>? details;

  bool get isUnauthorized => status == 401;
  bool get isOffline => status == 0;
  bool get needsRailwayLogin => code == 'session_required';

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient({required String baseUrl, this.token, http.Client? client})
      : baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), ''),
        _http = client ?? http.Client();

  final String baseUrl;
  final String? token;
  final http.Client _http;

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
    Map<String, String>? headers,
    Duration timeout = const Duration(seconds: 25),
  }) async {
    final uri = Uri.parse('$baseUrl$path').replace(queryParameters: query);
    final req = http.Request(method, uri)
      ..headers['content-type'] = 'application/json'
      ..headers['accept'] = 'application/json';
    if (token != null) req.headers['authorization'] = 'Bearer $token';
    if (headers != null) req.headers.addAll(headers);
    if (body != null) req.body = jsonEncode(body);

    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(timeout));
    } on TimeoutException {
      throw ApiException(0, 'timeout', 'The server took too long to answer. Check your connection and try again.');
    } on SocketException {
      throw ApiException(0, 'offline', "Can't reach the server. Check your internet connection.");
    } on http.ClientException {
      throw ApiException(0, 'offline', "Can't reach the server. Check your internet connection.");
    }

    Map<String, dynamic> json = {};
    try {
      final decoded = jsonDecode(utf8.decode(res.bodyBytes));
      if (decoded is Map<String, dynamic>) json = decoded;
    } catch (_) {}

    if (res.statusCode >= 200 && res.statusCode < 300) return json;

    final err = (json['error'] as Map?)?.cast<String, dynamic>();
    throw ApiException(
      res.statusCode,
      (err?['code'] as String?) ?? 'http_${res.statusCode}',
      (err?['message'] as String?) ?? 'Request failed (HTTP ${res.statusCode})',
      details: (err?['details'] as Map?)?.cast<String, dynamic>(),
    );
  }

  // ---- pairing / device ----
  Future<String> pair(String code, String deviceName) async {
    final r = await _send('POST', '/v1/pair', body: {'code': code, 'deviceName': deviceName});
    return r['deviceToken'] as String;
  }

  Future<void> putFcmToken(String fcmToken) => _send('PUT', '/v1/device/fcm-token', body: {'fcmToken': fcmToken});
  Future<void> unpair() => _send('DELETE', '/v1/device');

  // ---- status / session ----
  Future<AppStatus> status() async => AppStatus.fromJson(await _send('GET', '/v1/status'));
  Future<SessionStatus> sessionStatus() async => SessionStatus.fromJson(await _send('GET', '/v1/session/status'));
  Future<SessionStatus> postSession(Map<String, dynamic> blob) async =>
      SessionStatus.fromJson(await _send('POST', '/v1/session', body: blob, timeout: const Duration(seconds: 40)));

  // ---- catalog ----
  Future<CatalogData> catalog() async => CatalogData.fromJson(await _send('GET', '/v1/catalog'));
  Future<StationsInfo> stations(String train, String isoDate) async =>
      StationsInfo.fromJson(await _send('GET', '/v1/trains/stations', query: {'train': train, 'date': isoDate}));

  // ---- watchers ----
  Future<List<Watcher>> watchers() async {
    final r = await _send('GET', '/v1/watchers');
    return (r['watchers'] as List).map((e) => Watcher.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<SaveResult> createWatcher(Map<String, dynamic> body, {required String idempotencyKey}) async =>
      SaveResult.fromJson(await _send('POST', '/v1/watchers', body: body, headers: {'idempotency-key': idempotencyKey}));

  Future<SaveResult> updateWatcher(String id, Map<String, dynamic> body) async =>
      SaveResult.fromJson(await _send('PATCH', '/v1/watchers/$id', body: body));

  Future<void> deleteWatcher(String id) => _send('DELETE', '/v1/watchers/$id');

  Future<VerifyResult> verify(Map<String, dynamic> body) async =>
      VerifyResult.fromJson(await _send('POST', '/v1/watchers/verify', body: body, timeout: const Duration(seconds: 40)));

  // ---- alerts ----
  Future<List<AlertItem>> notifications() async {
    final r = await _send('GET', '/v1/notifications', query: {'limit': '60'});
    return (r['notifications'] as List).map((e) => AlertItem.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<void> ack(String alertId) => _send('POST', '/v1/notifications/$alertId/ack');

  // ---- settings ----
  Future<AppSettings> settings() async => AppSettings.fromJson(await _send('GET', '/v1/settings'));
  Future<AppSettings> patchSettings(Map<String, dynamic> body) async =>
      AppSettings.fromJson(await _send('PATCH', '/v1/settings', body: body));

  Future<List<ChannelResult>> testAlert(String channel) async {
    final r = await _send('POST', '/v1/settings/test-alert', body: {'channel': channel}, timeout: const Duration(seconds: 45));
    return (r['channels'] as List).map((e) => ChannelResult.fromJson(e as Map<String, dynamic>)).toList();
  }
}
