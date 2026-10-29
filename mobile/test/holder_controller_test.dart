import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:train_watcher/features/holder/seat_holder_controller.dart';

String _net(int status, String body) => jsonEncode({
  'type': 'net',
  'payload': {
    'method': 'PATCH',
    'url': 'bookings/reserve-seat',
    'seat': 'KA-1',
    'status': status,
    'ms': 300,
    'body': body,
  },
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'the site\'s "temporarily disabled" reply pauses everything until the time it names',
    () {
      final c = SeatHolderController();
      addTearDown(c.dispose);
      c.handleBridgeMessage(
        _net(
          422,
          '{"error":{"code":422,"messages":{"error":1,"error_msg":"Your seat selection is temporarily disabled due to repeated attempts. Please try again after 29 October 2026 at 01:31 AM"}}}',
        ),
      );
      // 01:31 AM plus a minute of margin
      expect(c.blockedUntil, DateTime(2026, 10, 29, 1, 32));
      expect(c.state.logs.first, contains('SITE BLOCK'));
    },
  );

  test('PM times are read as 24-hour times', () {
    final c = SeatHolderController();
    addTearDown(c.dispose);
    c.handleBridgeMessage(
      _net(
        422,
        'temporarily disabled ... try again after 3 November 2026 at 11:05 PM',
      ),
    );
    expect(c.blockedUntil, DateTime(2026, 11, 3, 23, 6));
  });

  test('an ordinary 422 (seat taken) does not trigger a pause', () {
    final c = SeatHolderController();
    addTearDown(c.dispose);
    c.handleBridgeMessage(
      _net(
        422,
        '{"error":{"code":422,"messages":{"error_msg":"Seat already booked"}}}',
      ),
    );
    expect(c.blockedUntil, isNull);
  });

  test('a 429 pauses for about a minute', () {
    final c = SeatHolderController();
    addTearDown(c.dispose);
    c.handleBridgeMessage(_net(429, ''));
    final wait = c.blockedUntil!.difference(DateTime.now());
    expect(wait.inSeconds, inInclusiveRange(55, 61));
  });
}
