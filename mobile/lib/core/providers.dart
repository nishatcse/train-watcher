import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api_client.dart';
import 'config.dart';
import 'models.dart';
import '../notifications/notification_service.dart';
import 'storage.dart';

final storageProvider = Provider<Storage>((ref) => Storage());

class AuthState {
  const AuthState(this.baseUrl, this.token, {this.notice});
  final String baseUrl;
  final String? token;

  /// Why the phone is back on the pairing screen (e.g. it was unpaired on the server).
  final String? notice;
  bool get paired => token != null;
}

class AuthNotifier extends AsyncNotifier<AuthState> {
  @override
  Future<AuthState> build() async {
    final s = ref.read(storageProvider);
    return AuthState((await s.readBaseUrl()) ?? kDefaultBackendUrl, await s.readToken());
  }

  Future<void> pair({required String baseUrl, required String code}) async {
    final token = await ApiClient(baseUrl: baseUrl).pair(code.trim().toUpperCase(), 'Android phone');
    await ref.read(storageProvider).saveAuth(token: token, baseUrl: baseUrl);
    state = AsyncData(AuthState(baseUrl, token));
  }

  /// [remote] also tells the server to forget this phone.
  Future<void> signOut({bool remote = false, String? notice}) async {
    if (remote) {
      try {
        await ref.read(apiProvider).unpair();
      } catch (_) {}
    }
    await ref.read(storageProvider).clearToken();
    state = AsyncData(AuthState(state.valueOrNull?.baseUrl ?? kDefaultBackendUrl, null, notice: notice));
  }
}

final authProvider = AsyncNotifierProvider<AuthNotifier, AuthState>(AuthNotifier.new);

final apiProvider = Provider<ApiClient>((ref) {
  final a = ref.watch(authProvider).valueOrNull;
  return ApiClient(baseUrl: a?.baseUrl ?? kDefaultBackendUrl, token: a?.token);
});

/// Re-fetches itself on a timer while something is watching it.
AutoDisposeFutureProvider<T> _polling<T>(Future<T> Function(ApiClient api) fetch, Duration every) {
  return FutureProvider.autoDispose<T>((ref) async {
    final timer = Timer(every, ref.invalidateSelf);
    ref.onDispose(timer.cancel);
    return fetch(ref.watch(apiProvider));
  });
}

final statusProvider = _polling<AppStatus>((api) => api.status(), const Duration(seconds: 10));
final watchersProvider = _polling<List<Watcher>>((api) => api.watchers(), const Duration(seconds: 15));
final historyProvider = _polling<List<AlertItem>>((api) => api.notifications(), const Duration(seconds: 20));
/// Whether Android lets this app post notifications. Re-checked when the app resumes,
/// so granting it in the system dialog or Settings clears the warning straight away.
final notificationsEnabledProvider = FutureProvider.autoDispose<bool>((ref) => NotificationService.notificationsEnabled());
final settingsProvider = FutureProvider.autoDispose<AppSettings>((ref) => ref.watch(apiProvider).settings());
final catalogProvider = FutureProvider.autoDispose<CatalogData>((ref) => ref.watch(apiProvider).catalog());
