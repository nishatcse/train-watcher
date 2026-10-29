import 'package:flutter_test/flutter_test.dart';
import 'package:train_watcher/features/holder/seat_holder_config.dart';

void main() {
  group('seat holder config', () {
    test('seat numbers are split, trimmed and upper-cased', () {
      const c = SeatHolderConfig(
        fromCity: 'Chattogram',
        toCity: 'Dhaka',
        journeyDate: '07-Nov-2026',
        trainName: 'TURNA EXPRESS (741)',
        seatNumbers: ' ka-1, KA-2 ,, ',
      );
      expect(c.targetSeatList, ['KA-1', 'KA-2']);
    });

    test('no seat numbers means auto-pick', () {
      const c = SeatHolderConfig(
        fromCity: 'a',
        toCity: 'b',
        journeyDate: '',
        trainName: 't',
      );
      expect(c.targetSeatList, isEmpty);
    });

    test('survives a save and load, including the end time', () {
      final stop = DateTime.now().add(const Duration(hours: 5));
      final c = SeatHolderConfig(
        fromCity: 'Chattogram',
        toCity: 'Dhaka',
        journeyDate: '07-Nov-2026',
        trainName: 'TURNA EXPRESS (741)',
        bogieName: 'KA',
        seatNumbers: 'KA-1,KA-2',
        holdDurationSeconds: 375,
        stopAt: stop,
      );
      final back = SeatHolderConfig.fromJson(c.toJson());
      expect(back.trainName, c.trainName);
      expect(back.bogieName, 'KA');
      expect(back.seatNumbers, 'KA-1,KA-2');
      expect(back.holdDurationSeconds, 375);
      expect(back.stopAt!.difference(stop).inSeconds, 0);
    });

    test('an end time that has already passed is not restored', () {
      final c = SeatHolderConfig(
        fromCity: 'a',
        toCity: 'b',
        journeyDate: '',
        trainName: 't',
        stopAt: DateTime.now().subtract(const Duration(minutes: 1)),
      );
      expect(SeatHolderConfig.fromJson(c.toJson()).stopAt, isNull);
    });

    test(
      'seat count is kept within 1..4 and the hold defaults to 6 min 15 s',
      () {
        final c = SeatHolderConfig.fromJson({'seatCount': 9});
        expect(c.seatCount, 4);
        expect(c.holdDurationSeconds, 375);
      },
    );

    test('route, date and class come from a booking-site search url', () {
      final c = SeatHolderConfig.fromSearchUrl(
        'https://eticket.railway.gov.bd/booking/train/search?fromcity=Chattogram&tocity=Dhaka&doj=07-Nov-2026&class=SNIGDHA',
        trainName: 'TURNA EXPRESS (741)',
      );
      expect(c.fromCity, 'Chattogram');
      expect(c.toCity, 'Dhaka');
      expect(c.journeyDate, '07-Nov-2026');
      expect(c.seatClass, 'SNIGDHA');
      expect(c.trainName, 'TURNA EXPRESS (741)');
    });

    test('the search url round-trips the route', () {
      const c = SeatHolderConfig(
        fromCity: 'Chattogram',
        toCity: 'Dhaka',
        journeyDate: '07-Nov-2026',
        trainName: 't',
      );
      final u = Uri.parse(c.buildSearchUrl());
      expect(u.queryParameters['fromcity'], 'Chattogram');
      expect(u.queryParameters['doj'], '07-Nov-2026');
    });
  });
}
