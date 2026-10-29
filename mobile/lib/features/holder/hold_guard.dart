import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Android side of the seat holder: while a hold is active it keeps the process alive (foreground service),
/// keeps this app on screen (also over the lock screen), and brings it back if it is sent to the background,
/// swiped out of recents or killed. See HoldGuardService.kt.
class HoldGuard {
  static const _channel = MethodChannel('train_watcher/hold_guard');

  /// How the app behaves when the owner leaves it during a hold.
  static const modePip =
      'pip'; // small floating window (picture-in-picture): runs fully, other apps usable
  static const modeFront = 'front'; // pulled back to full screen
  static const modeFree = 'free'; // left alone, like any background app

  /// True while the app is shown as the small floating window.
  static final ValueNotifier<bool> inPip = ValueNotifier(false);

  /// Starts listening for window-mode changes from Android. Call once from the screen.
  static void listen() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'pip') inPip.value = call.arguments == true;
    });
  }

  static Future<void> setMode(String mode) => _call('setMode', {'mode': mode});

  static Future<String> mode() async {
    try {
      return (await _channel.invokeMethod<String>('mode')) ?? modePip;
    } catch (_) {
      return modePip;
    }
  }

  /// A hold is starting. The guard stays up until [stop], or [stopAt] plus a short grace period.
  static Future<void> start({DateTime? stopAt}) =>
      _call('start', {'stopAtMs': stopAt?.millisecondsSinceEpoch ?? 0});

  /// The hold ended (finished, stopped, or failed for good).
  static Future<void> stop() => _call('stop');

  /// Updates the text of the ongoing notification, e.g. "Holding KA-1, KA-2 until 11:30 PM".
  static Future<void> status(String text) => _call('status', {'text': text});

  /// A loud, separate notification for things that need the owner (login expired, no internet for long).
  static Future<void> attention(String title, String body) =>
      _call('attention', {'title': title, 'body': body});

  /// True when a hold was active when the app was (re)started, so the screen should resume it by itself.
  static Future<bool> wasActive() async {
    try {
      return (await _channel.invokeMethod<bool>('wasActive')) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Whether Android lets the app run unrestricted in the background and draw over other apps. Both are
  /// needed for the guard to keep the app in front and to bring it back after it is killed.
  static Future<({bool battery, bool overlay})> permissions() async {
    try {
      final m = await _channel.invokeMapMethod<String, bool>('permissions');
      return (battery: m?['battery'] ?? true, overlay: m?['overlay'] ?? true);
    } catch (_) {
      return (battery: true, overlay: true);
    }
  }

  /// Opens the system prompt that stops Android putting the app to sleep (battery optimisation).
  static Future<void> requestUnrestrictedBattery() => _call('batteryExemption');

  /// Opens the "display over other apps" setting for this app.
  static Future<void> requestOverlay() => _call('overlayPermission');

  static Future<void> _call(String method, [Map<String, Object?>? args]) async {
    try {
      await _channel.invokeMethod<void>(method, args);
    } catch (_) {
      // not on Android, or the plugin is not attached: the holder still works while the app is open
    }
  }
}
