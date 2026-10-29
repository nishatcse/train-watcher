import 'package:flutter_test/flutter_test.dart';
import 'package:train_watcher/features/holder/holder_remote.dart';

void main() {
  Map<String, dynamic> hold({
    String status = 'running',
    String? phase = 'holding',
  }) => {
    'id': 'h1',
    'status': status,
    'phase': phase,
    'trainName': 'TURNA EXPRESS (741)',
    'fromCity': 'Chattogram',
    'toCity': 'Dhaka',
    'journeyDate': '2026-11-07',
    'seatNumbers': 'KA-1,KA-2',
    'seatCount': 2,
    'holdSeconds': 375,
    'cycleCount': 3,
    'heldSeats': ['KA-1', 'KA-2'],
    'active': true,
    'stopAt': '2026-11-07T17:00:00.000Z',
    'blockedUntil': null,
    'lastError': null,
    'updatedAt': '2026-11-07T10:00:00.000Z',
  };

  test('a server hold view parses the status, seats, route and events', () {
    final v = RemoteHoldView.fromJson({
      'hold': hold(),
      'events': [
        {
          'at': '2026-11-07T10:00:00.000Z',
          'message': 'Held 2/2 seat(s): KA-1, KA-2',
        },
      ],
    });
    expect(v.hold!.route, 'Chattogram → Dhaka');
    expect(v.hold!.heldSeats, ['KA-1', 'KA-2']);
    expect(v.hold!.cycleCount, 3);
    expect(
      v.hold!.stopAt!.isUtc,
      isFalse,
      reason: 'shown in the phone\'s local time',
    );
    expect(v.events.single.message, startsWith('Held 2/2'));
  });

  test('no hold yet is a valid empty view', () {
    final v = RemoteHoldView.fromJson({'hold': null, 'events': []});
    expect(v.hold, isNull);
    expect(v.events, isEmpty);
  });

  test('phases are explained in plain words', () {
    String label(String? phase, {String status = 'running'}) =>
        RemoteHold.fromJson(hold(status: status, phase: phase)).phaseLabel;
    expect(label('holding'), 'Holding');
    expect(label('blocked'), contains('blocked'));
    expect(label('waiting_login'), contains('login'));
    expect(label('refreshing'), contains('Refreshing'));
    expect(label(null, status: 'queued'), contains('worker'));
  });
}
