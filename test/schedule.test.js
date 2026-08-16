'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTime, parseWeekdays, nextWeeklyDate, nextDailyDate } = require('../server/schedule');

test('schedule time normalization preserves 24-hour values and clamps ranges', () => {
  assert.equal(normalizeTime('1:05', '02:30'), '01:05');
  assert.equal(normalizeTime('29:99', '02:30'), '23:59');
  assert.equal(normalizeTime('invalid', '02:30'), '02:30');
});

test('weekday parsing deduplicates, sorts, and rejects invalid values', () => {
  assert.deepEqual(parseWeekdays(['5', 1, 5, -1, 7, 'x']), [1, 5]);
  assert.deepEqual(parseWeekdays('6,0,3,3'), [0, 3, 6]);
});

test('weekly schedule uses today only when its configured time is still ahead', () => {
  const sundayMorning = new Date(2026, 7, 16, 1, 0, 15);
  const today = nextWeeklyDate('01:45', [0], sundayMorning);
  assert.equal(today.getDay(), 0);
  assert.equal(today.getDate(), 16);
  assert.equal(today.getHours(), 1);
  assert.equal(today.getMinutes(), 45);

  const sundayEvening = new Date(2026, 7, 16, 2, 0, 0);
  const nextSunday = nextWeeklyDate('01:45', [0], sundayEvening);
  assert.equal(nextSunday.getDay(), 0);
  assert.equal(nextSunday.getDate(), 23);
});

test('daily schedule rolls an elapsed time to tomorrow', () => {
  const from = new Date(2026, 7, 16, 3, 0, 0);
  const next = nextDailyDate('02:30', from);
  assert.equal(next.getDate(), 17);
  assert.equal(next.getHours(), 2);
  assert.equal(next.getMinutes(), 30);
});
