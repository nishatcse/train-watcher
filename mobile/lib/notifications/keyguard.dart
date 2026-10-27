import 'package:flutter/services.dart';

/// Small bridge to Android's KeyguardManager (see MainActivity.kt). An alert may
/// appear over the lock screen, but nothing sensitive is reachable until the owner
/// unlocks the phone.
class Keyguard {
  static const _ch = MethodChannel('train_watcher/keyguard');

  static Future<bool> isLocked() async {
    try {
      return (await _ch.invokeMethod<bool>('isLocked')) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Asks the system to prompt for the PIN/biometric. True once unlocked.
  static Future<bool> dismiss() async {
    try {
      return (await _ch.invokeMethod<bool>('dismissKeyguard')) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Closes the app task so the phone goes back to the lock screen.
  static Future<void> finish() async {
    try {
      await _ch.invokeMethod('finish');
    } catch (_) {}
  }
}
