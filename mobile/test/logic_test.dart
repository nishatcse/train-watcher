import 'package:flutter_test/flutter_test.dart';
import 'package:train_watcher/core/api_client.dart';
import 'package:train_watcher/core/format.dart';
import 'package:train_watcher/core/models.dart';
import 'package:train_watcher/notifications/alert_data.dart';

void main() {
  group('dates', () {
    test('prettyDate and isoOf round-trip', () {
      expect(prettyDate('2026-10-31'), '31 Oct 2026');
      expect(prettyDate('2027-01-05'), '5 Jan 2027');
      expect(isoOf(parseIso('2026-10-31')), '2026-10-31');
    });
    test('durations read naturally', () {
      expect(duration(0), '0m');
      expect(duration(45), '45s');
      expect(duration(600), '10m');
      expect(duration(3 * 3600 + 20 * 60), '3h 20m');
    });
    test('every backend status has a label', () {
      for (final s in [
        'ok',
        'train_not_listed',
        'class_not_offered',
        'not_open_yet',
        'journey_passed',
        'rate_limited',
        'error',
        null,
      ]) {
        expect(statusLabel(s), isNotEmpty);
      }
    });
  });

  group('parsing server responses', () {
    test('watcher with seats', () {
      final w = Watcher.fromJson(
        {
          'id': 'a',
          'fromCity': 'Dhaka',
          'toCity': 'Sylhet',
          'journeyDate': '2026-10-31',
          'trainName': 'UPABAN EXPRESS (739)',
          'seatClass': 'S_CHAIR',
          'enabled': true,
          'lastCheckStatus': 'ok',
          'lastCheckedAt': '2026-10-27T05:20:48.394Z',
          'warnings': ['x'],
          'availableSeats': 15,
          'onlineSeats': 3,
          'counterSeats': 12,
          'totalFare': '185',
        }..['totalFare'] = 185,
      );
      expect(w.availableSeats, 15);
      expect(w.warnings, ['x']);
      expect(w.lastCheckedAt, isNotNull);
    });

    test('catalog keeps only departable cities for the From list', () {
      final c = CatalogData.fromJson({
        'cities': [
          {'name': 'Dhaka', 'canDepart': true, 'top': true},
          {'name': 'Aditmari', 'canDepart': false, 'top': false},
        ],
        'trains': [
          {'model': '709', 'name': 'PARABAT EXPRESS (709)'},
        ],
        'classes': ['S_CHAIR'],
        'searchDayLimit': 10,
        'stale': false,
      });
      expect(c.cities.where((x) => x.canDepart).map((x) => x.name), ['Dhaka']);
      expect(c.isEmpty, isFalse);
      expect(
        CatalogData.fromJson({
          'cities': [],
          'trains': [],
          'classes': [],
        }).isEmpty,
        isTrue,
      );
    });

    test('session status flags a needed login', () {
      expect(
        SessionStatus.fromJson({
          'status': 'expired_awaiting_relogin',
        }).needsLogin,
        isTrue,
      );
      expect(
        SessionStatus.fromJson({
          'status': 'active',
          'secondsLeft': 3600,
        }).needsLogin,
        isFalse,
      );
    });

    test('history groups per-channel delivery', () {
      final a = AlertItem.fromJson({
        'alertId': 'x',
        'kind': 'seat_available',
        'title': 't',
        'body': 'b',
        'createdAt': '2026-10-27T05:20:48Z',
        'payload': {'url': 'https://eticket.railway.gov.bd/x'},
        'channels': [
          {'channel': 'fcm', 'status': 'sent', 'attempts': 1},
          {
            'channel': 'telegram',
            'status': 'failed',
            'attempts': 3,
            'lastError': 'down',
          },
        ],
      });
      expect(a.isSeatAlert, isTrue);
      expect(a.channels.map((c) => c.status), ['sent', 'failed']);
      expect(a.url, startsWith('https://eticket'));
    });
  });

  group('alert payloads (FCM data values are all strings)', () {
    test('parses a push', () {
      final d = AlertData.fromMap({
        'alertId': 'abc',
        'type': 'seat_available',
        'title': 'Railway Seat Available',
        'body': 'x',
        'url': 'https://eticket.railway.gov.bd/s',
        'route': 'Dhaka → Sylhet',
        'trainName': 'UPABAN EXPRESS (739)',
        'seatClass': 'S_CHAIR',
        'journeyDate': '2026-10-31',
        'seats': '15',
      });
      expect(d.seats, 15, reason: 'one total, online + counter');
      expect(d.url, isNotNull);
      expect(d.isTest, isFalse);
    });
    test('a test alert and a missing link are handled', () {
      final d = AlertData.fromMap({'alertId': 'z', 'type': 'test', 'url': ''});
      expect(d.isTest, isTrue);
      expect(d.url, isNull);
      expect(d.seats, 0);
    });
  });

  group('errors', () {
    test('offline and revoked-device are recognisable', () {
      expect(ApiException(0, 'offline', 'x').isOffline, isTrue);
      expect(ApiException(401, 'unauthorized', 'x').isUnauthorized, isTrue);
      expect(
        ApiException(409, 'session_required', 'x').needsRailwayLogin,
        isTrue,
      );
    });
  });
}
