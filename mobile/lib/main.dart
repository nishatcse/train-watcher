import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';
import 'notifications/notification_service.dart';
import 'notifications/push_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await NotificationService.init();
  await PushService.init();
  await NotificationService.captureLaunchTap();
  runApp(const ProviderScope(child: TrainWatcherApp()));
}
