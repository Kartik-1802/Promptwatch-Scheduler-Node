import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, midnight, weeklyResponses, expectedWeeklyRuns, predictionAlert, responsePeriods, remainingPlan } from '../src/lib/response-plan';
const tz = 'Asia/Kolkata';
const monitor = { active: true, promptCount: 10, models: ['a', 'b'] };
const blocks = [1, 3, 4].map(day => ({ startDay: day, endDay: day, startTime: '09:00', endTime: '17:00', trigger: 'on_off' }));
test('Tue/Thu/Fri count three separate blocks; multiple models multiply responses', () => {
  assert.equal(weeklyResponses([monitor], blocks), 60);
});
test('manual ON counts seven runs and OFF contributes nothing', () => {
  assert.equal(weeklyResponses([monitor], []), 140);
  assert.equal(weeklyResponses([{ ...monitor, active: false }], []), 0);
  assert.equal(weeklyResponses([{ ...monitor, active: false }], blocks), 60);
});
test('reset uses local midnight on the 6th, handles year rollover and leap February', () => {
  assert.equal(responsePeriods(new Date('2026-10-05T18:29:59Z'), tz).start, '2026-09-06');
  assert.equal(responsePeriods(new Date('2026-10-05T18:30:00Z'), tz).end, '2026-11-06');
  assert.equal(responsePeriods(new Date('2027-01-01T00:00:00Z'), tz).start, '2026-12-06');
});
test('multiple monitors are added and unknown counts do not invent responses', () => {
  assert.equal(weeklyResponses([monitor, { ...monitor, promptCount: 5 }], blocks), 90);
  assert.equal(weeklyResponses([{ ...monitor, promptCount: null }], blocks), 0);
});
test('overnight and Sunday wrap count duration; separate same-day blocks round individually', () => {
  const overnight = [{ startDay: 6, endDay: 0, startTime: '23:00', endTime: '01:00', trigger: 'on_off' }];
  assert.equal(weeklyResponses([monitor], overnight), 20);
  assert.equal(weeklyResponses([monitor], [{ ...overnight[0], endTime: '00:00' }]), 20);
  assert.equal(weeklyResponses([monitor], [blocks[0], { ...blocks[0], startTime: '19:00', endTime: '21:00' }]), 40);
});
test('inverted blocks are ON outside their OFF window', () => {
  const offWeekend = [{ startDay: 5, endDay: 0, startTime: '00:00', endTime: '00:00', trigger: 'off_on' }];
  assert.equal(weeklyResponses([monitor], offWeekend), 100);
});
test('paused scheduler forecasts current manual state', () => {
  assert.equal(weeklyResponses([monitor], blocks, false), 140);
});
test('warning appears only above 70% of a positive monthly prediction', () => {
  assert.equal(predictionAlert(699, 1000), false);
  assert.equal(predictionAlert(700, 1000), false);
  assert.equal(predictionAlert(701, 1000), true);
  assert.equal(predictionAlert(1100, 1000), true);
  assert.equal(predictionAlert(null, 1000), false);
  assert.equal(predictionAlert(0, 0), false);
  assert.equal(predictionAlert(1, 0), false);
});
test('timezone date boundaries handle DST and calendar arithmetic', () => {
  assert.equal(midnight('2026-10-06', tz).toISOString(), '2026-10-05T18:30:00.000Z');
  assert.equal(midnight('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
test('known provider reset time is respected instead of local midnight', () => {
  const billing = { periodFrom: new Date('2026-10-06T00:00:00Z'), periodTo: new Date('2026-11-06T00:00:00Z') };
  assert.equal(responsePeriods(new Date('2026-11-05T20:00:00Z'), tz, billing).start, '2026-10-06');
  assert.equal(responsePeriods(new Date('2026-11-06T00:00:00Z'), tz, billing).start, '2026-11-06');
  assert.equal(responsePeriods(new Date('2026-11-06T00:00:00Z'), tz, billing).resetAt, '2026-12-06T00:00:00.000Z');
});

test('remaining forecast rounds partial days up, including 2.5 days to 3', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  assert.deepEqual(remainingPlan(140, now, '2026-11-06T00:00:00Z'), { days: 3, responses: 60 });
  assert.deepEqual(remainingPlan(60, now, '2026-11-06T00:00:00Z'), { days: 3, responses: 26 });
  assert.deepEqual(remainingPlan(140, new Date('2026-11-06T00:00:00Z'), '2026-11-06T00:00:00Z'), { days: 0, responses: 0 });
  assert.deepEqual(remainingPlan(140, new Date('2026-11-04T00:00:00Z'), '2026-11-06T00:00:00Z'), { days: 2, responses: 40 });
});

test('two 24-hour blocks count two runs, regardless of crossing midnight', () => {
  const twoDays = [
    { startDay: 0, startTime: '09:00', endDay: 1, endTime: '09:00', trigger: 'on_off' },
    { startDay: 3, startTime: '09:00', endDay: 4, endTime: '09:00', trigger: 'on_off' },
  ];
  assert.equal(expectedWeeklyRuns(twoDays), 2);
  assert.equal(weeklyResponses([{ ...monitor, promptCount: 345, models: ['a'] }], twoDays), 690);
});
test('1 day + 1 day + 2 days 8 hours rounds each block to 1 + 1 + 3', () => {
  const windows = [
    { startDay: 0, startTime: '09:00', endDay: 1, endTime: '09:00', trigger: 'on_off' },
    { startDay: 2, startTime: '14:00', endDay: 3, endTime: '14:00', trigger: 'on_off' },
    { startDay: 4, startTime: '09:00', endDay: 6, endTime: '17:00', trigger: 'on_off' },
  ];
  assert.equal(expectedWeeklyRuns(windows), 5);
  assert.equal(weeklyResponses([monitor], windows), 100);
});
test('rounding applies at 24-hour boundaries and across the end of the week', () => {
  const block = { startDay: 0, startTime: '09:00', endDay: 1, endTime: '09:00', trigger: 'on_off' };
  assert.equal(expectedWeeklyRuns([{ ...block, endTime: '08:59' }]), 1);
  assert.equal(expectedWeeklyRuns([block]), 1);
  assert.equal(expectedWeeklyRuns([{ ...block, endTime: '09:01' }]), 2);
  assert.equal(expectedWeeklyRuns([{ ...block, startDay: 6, endDay: 0 }]), 1);
});
test('inverted schedules subtract each rounded OFF block from seven days', () => {
  assert.equal(expectedWeeklyRuns([
    { startDay: 1, startTime: '09:00', endDay: 2, endTime: '09:00', trigger: 'off_on' },
    { startDay: 4, startTime: '09:00', endDay: 5, endTime: '09:00', trigger: 'off_on' },
  ]), 5);
  const off = { startDay: 0, startTime: '09:00', endDay: 0, endTime: '17:00', trigger: 'off_on' };
  assert.equal(expectedWeeklyRuns([off]), 6);
  assert.equal(expectedWeeklyRuns([off, { ...off, startDay: 3, endDay: 3 }]), 5);
  assert.equal(expectedWeeklyRuns([{ ...off, endDay: 2 }]), 4);
  assert.equal(expectedWeeklyRuns([{ ...off, startDay: 6, endDay: 0 }]), 5);
  assert.equal(expectedWeeklyRuns([{ ...off, endTime: '09:00' }]), 0);
});
test('mixed-trigger schedules count only ON blocks, matching scheduler behavior', () => {
  assert.equal(expectedWeeklyRuns([
    { startDay: 0, startTime: '09:00', endDay: 1, endTime: '09:00', trigger: 'on_off' },
    { startDay: 4, startTime: '09:00', endDay: 5, endTime: '09:00', trigger: 'off_on' },
  ]), 1);
});
