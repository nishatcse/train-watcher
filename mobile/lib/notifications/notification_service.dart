import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../core/storage.dart';

/// A notification the owner tapped (or an action button they pressed).
class AlertTap {
  AlertTap(this.data, this.actionId);
  final Map<String, dynamic> data;
  final String? actionId;
}

/// Set by notification taps (including the tap that cold-started the app).
final ValueNotifier<AlertTap?> pendingTap = ValueNotifier<AlertTap?>(null);

/// Set when a seat alert arrives while the app is open, so it can open the alert screen.
final ValueNotifier<Map<String, dynamic>?> foregroundAlert = ValueNotifier<Map<String, dynamic>?>(null);

Map<String, dynamic> _decode(String? payload) {
  if (payload == null || payload.isEmpty) return {};
  try {
    return (jsonDecode(payload) as Map).cast<String, dynamic>();
  } catch (_) {
    return {};
  }
}

void _onTap(NotificationResponse r) {
  pendingTap.value = AlertTap(_decode(r.payload), r.actionId);
}

/// Runs in a background isolate for buttons that don't open the app ("Dismiss").
@pragma('vm:entry-point')
Future<void> notificationTapBackground(NotificationResponse r) async {
  final data = _decode(r.payload);
  final alertId = (data['alertId'] ?? '').toString();
  if (alertId.isEmpty) return;
  if (r.actionId == 'dismiss') {
    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.cancel(id: NotificationService.ringId(alertId));
    await plugin.cancel(id: NotificationService.quietId(alertId));
    try {
      final s = Storage();
      final token = await s.readToken();
      if (token != null) {
        await ApiClient(baseUrl: (await s.readBaseUrl()) ?? kDefaultBackendUrl, token: token).ack(alertId);
      }
    } catch (_) {}
  }
}

class NotificationService {
  static final FlutterLocalNotificationsPlugin plugin = FlutterLocalNotificationsPlugin();

  // Channel settings are frozen by Android the first time a channel is created, so a
  // behaviour change needs a new id (hence the version suffix).
  static const _alertChannel = 'seat_alerts_v2';
  static const _quietChannel = 'seat_alerts_quiet_v2';
  static const _sessionChannel = 'session_alerts_v2';
  static bool _ready = false;

  static int ringId(String alertId) => alertId.hashCode & 0x3fffffff;
  static int quietId(String alertId) => (alertId.hashCode & 0x3fffffff) | 0x40000000;

  static AndroidFlutterLocalNotificationsPlugin? get _android =>
      plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();

  static Future<void> init() async {
    if (_ready) return;
    await plugin.initialize(
      settings: const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
      onDidReceiveNotificationResponse: _onTap,
      onDidReceiveBackgroundNotificationResponse: notificationTapBackground,
    );

    final a = _android;
    await a?.createNotificationChannel(AndroidNotificationChannel(
      _alertChannel,
      'Seat alerts',
      description: 'Rings like a phone call when a watched train has seats.',
      importance: Importance.max,
      playSound: true,
      // The phone's own ringtone, played on the alarm stream so it is audible even
      // when the ringer is on vibrate.
      sound: const UriAndroidNotificationSound('content://settings/system/ringtone'),
      audioAttributesUsage: AudioAttributesUsage.alarm,
      enableVibration: true,
      vibrationPattern: Int64List.fromList([0, 900, 500, 900, 500, 900, 500, 900]),
      enableLights: true,
    ));
    await a?.createNotificationChannel(const AndroidNotificationChannel(
      _quietChannel,
      'Seat alerts (kept)',
      description: 'A silent copy of the last seat alert so it stays in the shade after the ringing stops.',
      importance: Importance.low,
      playSound: false,
      enableVibration: false,
    ));
    await a?.createNotificationChannel(const AndroidNotificationChannel(
      _sessionChannel,
      'Railway login reminders',
      description: 'Tells you when the Railway login is about to expire or has expired.',
      importance: Importance.high,
    ));
    _ready = true;
  }

  /// If tapping a notification is what started the app, surface that tap.
  static Future<void> captureLaunchTap() async {
    final d = await plugin.getNotificationAppLaunchDetails();
    final r = d?.notificationResponse;
    if ((d?.didNotificationLaunchApp ?? false) && r != null) _onTap(r);
  }

  // ---- permissions ----
  static Future<bool> notificationsEnabled() async => (await _android?.areNotificationsEnabled()) ?? true;
  static Future<bool> requestNotificationPermission() async => (await _android?.requestNotificationsPermission()) ?? true;
  static Future<void> requestFullScreenPermission() async => _android?.requestFullScreenIntentPermission();

  // ---- duplicate protection ----
  // FCM can deliver the same push twice; the same alertId must only ring once.
  static Future<bool> _firstSighting(String alertId) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload(); // another isolate may have written since we last looked
    final now = DateTime.now().millisecondsSinceEpoch;
    final seen = (prefs.getStringList('seen_alerts') ?? const <String>[]).where((e) {
      final ms = int.tryParse(e.split('|').last) ?? 0;
      return now - ms < 6 * 3600 * 1000;
    }).toList();
    if (seen.any((e) => e.startsWith('$alertId|'))) return false;
    seen.add('$alertId|$now');
    await prefs.setStringList('seen_alerts', seen);
    return true;
  }

  /// Entry point for every push (foreground or background). Returns true if it was shown.
  static Future<bool> showFromPush(Map<String, dynamic> raw) async {
    await init();
    final data = raw.map((k, v) => MapEntry(k, v?.toString() ?? ''));
    final type = data['type'] ?? '';
    final alertId = (data['alertId'] ?? '').isNotEmpty ? data['alertId']! : (data['notificationId'] ?? '');
    if (alertId.isEmpty) return false;
    data['alertId'] = alertId;
    if (!await _firstSighting(alertId)) return false;

    if (type == 'seat_available' || type == 'test') {
      await _showSeatAlert(alertId, data);
    } else {
      await _showSessionAlert(alertId, data);
    }
    return true;
  }

  static Future<void> showLocalTest() async {
    await showFromPush({
      'type': 'test',
      'alertId': 'local-${DateTime.now().millisecondsSinceEpoch}',
      'title': 'Test alert',
      'body': 'Route: Test → Test\nTrain: TEST EXPRESS\nAvailable seats: 3\n\nIf this rang, alerts work on this phone.',
      'url': 'https://eticket.railway.gov.bd',
      'route': 'Test → Test',
      'trainName': 'TEST EXPRESS',
      'seatClass': 'TEST',
      'journeyDate': 'today',
      'seats': '3',
    });
  }

  static Future<void> _showSeatAlert(String alertId, Map<String, String> data) async {
    final title = data['title'] ?? 'Railway Seat Available';
    final body = data['body'] ?? '';
    final payload = jsonEncode(data);

    // The ringing notification: insistent (flag 4) so the sound repeats like a call,
    // removed by the system after two minutes.
    await plugin.show(
      id: ringId(alertId),
      title: title,
      body: body,
      payload: payload,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _alertChannel,
          'Seat alerts',
          channelDescription: 'Rings when a watched train has seats.',
          importance: Importance.max,
          priority: Priority.max,
          category: AndroidNotificationCategory.alarm,
          fullScreenIntent: true,
          autoCancel: true,
          timeoutAfter: 120000,
          additionalFlags: Int32List.fromList(<int>[4]),
          audioAttributesUsage: AudioAttributesUsage.alarm,
          visibility: NotificationVisibility.public,
          ticker: title,
          styleInformation: BigTextStyleInformation(body),
          actions: const [
            AndroidNotificationAction('book', 'Book now', showsUserInterface: true, cancelNotification: true),
            AndroidNotificationAction('dismiss', 'Dismiss', cancelNotification: true),
          ],
        ),
      ),
    );

    // The quiet copy that is still there once the ringing has stopped.
    await plugin.show(
      id: quietId(alertId),
      title: title,
      body: body,
      payload: payload,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _quietChannel,
          'Seat alerts (kept)',
          importance: Importance.low,
          priority: Priority.low,
          autoCancel: false,
          playSound: false,
          enableVibration: false,
          styleInformation: BigTextStyleInformation(body),
          actions: const [
            AndroidNotificationAction('book', 'Book now', showsUserInterface: true),
            AndroidNotificationAction('dismiss', 'Dismiss', cancelNotification: true),
          ],
        ),
      ),
    );
  }

  static Future<void> _showSessionAlert(String alertId, Map<String, String> data) async {
    final title = data['title'] ?? 'Railway login';
    final body = data['body'] ?? '';
    await plugin.show(
      id: ringId(alertId),
      title: title,
      body: body,
      payload: jsonEncode({...data, 'action': 'open_login'}),
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _sessionChannel,
          'Railway login reminders',
          importance: Importance.high,
          priority: Priority.high,
          styleInformation: BigTextStyleInformation(body),
        ),
      ),
    );
  }

  /// Stops the ringing (the notification is what rings) but keeps the quiet copy.
  static Future<void> stopRinging(String alertId) => plugin.cancel(id: ringId(alertId));

  static Future<void> clearAlert(String alertId) async {
    await plugin.cancel(id: ringId(alertId));
    await plugin.cancel(id: quietId(alertId));
  }
}
