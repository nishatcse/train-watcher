import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import '../core/api_client.dart';
import 'notification_service.dart';

@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {}
  await NotificationService.showFromPush(message.data);
}

/// Push is optional at build time: without Firebase's google-services.json the app
/// still runs and says so, and Telegram keeps working as the other channel.
class PushService {
  static bool configured = false;
  static String? initError;
  static StreamSubscription<String>? _refreshSub;

  static Future<void> init() async {
    try {
      await Firebase.initializeApp();
      configured = true;
    } catch (e) {
      configured = false;
      initError = e.toString();
      return;
    }
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    FirebaseMessaging.onMessage.listen((m) async {
      final shown = await NotificationService.showFromPush(m.data);
      final type = m.data['type'];
      if (shown && (type == 'seat_available' || type == 'test')) {
        foregroundAlert.value = Map<String, dynamic>.from(m.data);
      }
    });
  }

  /// Tell the backend where to send pushes, and keep it current when FCM rotates the token.
  static Future<String?> register(ApiClient api) async {
    if (!configured) return null;
    try {
      // register()/onRegistered hand out a Firebase Installation ID, not the classic FCM
      // registration token our HTTP v1 sender addresses. getToken() is deprecated but is
      // the one proven to work with it, so keep it until the backend moves to FIDs.
      // ignore: deprecated_member_use
      final token = await FirebaseMessaging.instance.getToken();
      if (token != null) await api.putFcmToken(token);
      await _refreshSub?.cancel();
      // ignore: deprecated_member_use
      _refreshSub = FirebaseMessaging.instance.onTokenRefresh.listen((t) {
        api.putFcmToken(t).catchError((_) {});
      });
      return token;
    } catch (e) {
      initError = e.toString();
      return null;
    }
  }
}
