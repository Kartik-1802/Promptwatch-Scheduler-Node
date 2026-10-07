import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, midnight, planResponses, predictionAlert, responsePeriods, remainingPlan, runOnDate } from '../src/lib/response-plan';
const tz = 'Asia/Kolkata';
const monitor = { active: true, promptCount: 10, models: ['a', 'b'] };
const blocks = [1, 3, 4].map(day => ({ startDay: day, endDay: day, startTime: '09:00', endTime: '17:00', trigger: 'on_off' }));
test('Tue/Thu/Fri count three dates; multiple models multiply responses', () => {
  assert.equal(planResponses([monitor], blocks, '2026-10-12', '2026-10-19', tz), 60);
});
test('manual ON counts seven dates and OFF contributes nothing', () => {
  assert.equal(planResponses([monitor], [], '2026-10-12', '2026-10-19', tz), 140);
  assert.equal(planResponses([{ ...monitor, active: false }], [], '2026-10-12', '2026-10-19', tz), 0);
});
test('reset uses local midnight on the 6th, handles year rollover and leap February', () => {
  assert.equal(responsePeriods(new Date('2026-10-05T18:29:59Z'), tz).start, '2026-09-06');
  assert.equal(responsePeriods(new Date('2026-10-05T18:30:00Z'), tz).end, '2026-11-06');
  assert.equal(responsePeriods(new Date('2027-01-01T00:00:00Z'), tz).start, '2026-12-06');
  assert.equal(planResponses([monitor], [], '2028-02-06', '2028-03-06', tz), 29 * 20);
});
test('monthly dates are counted exactly and reset day is excluded', () => {
  assert.equal(planResponses([monitor], blocks, '2026-10-06', '2026-11-06', tz), 14 * 20);
});
test('multiple monitors are added and unknown counts do not invent responses', () => {
  assert.equal(planResponses([monitor, { ...monitor, promptCount: 5 }], blocks, '2026-10-12', '2026-10-19', tz), 90);
  assert.equal(planResponses([{ ...monitor, promptCount: null }], blocks, '2026-10-12', '2026-10-19', tz), 0);
});
test('overnight, Sunday wrap, midnight-exclusive endings and duplicate day windows', () => {
  const overnight = [{ startDay: 6, endDay: 0, startTime: '23:00', endTime: '01:00', trigger: 'on_off' }];
  assert.equal(planResponses([monitor], overnight, '2026-10-12', '2026-10-19', tz), 40);
  assert.equal(planResponses([monitor], [{ ...overnight[0], endTime: '00:00' }], '2026-10-12', '2026-10-19', tz), 20);
  assert.equal(planResponses([monitor], [blocks[0], { ...blocks[0], startTime: '19:00', endTime: '21:00' }], '2026-10-12', '2026-10-19', tz), 20);
});
test('inverted blocks are ON outside their OFF window', () => {
  const offWeekend = [{ startDay: 5, endDay: 0, startTime: '00:00', endTime: '00:00', trigger: 'off_on' }];
  assert.equal(planResponses([monitor], offWeekend, '2026-10-12', '2026-10-19', tz), 100);
});
test('manual holds affect future prediction only until expiry', () => {
  const held = { ...monitor, active: false, overrideUntil: '2026-10-13T12:00:00Z' };
  assert.equal(runOnDate(held, blocks, '2026-10-13', tz), false);
  assert.equal(runOnDate(held, blocks, '2026-10-15', tz), true);
});
test('paused scheduler forecasts current manual state', () => {
  assert.equal(planResponses([monitor], blocks, '2026-10-12', '2026-10-19', tz, false), 140);
});
test('warning begins at exactly 70%, continues above it, handles zero prediction', () => {
  assert.equal(predictionAlert(699, 1000), false);
  assert.equal(predictionAlert(700, 1000), true);
  assert.equal(predictionAlert(1100, 1000), true);
  assert.equal(predictionAlert(null, 1000), false);
  assert.equal(predictionAlert(0, 0), false);
  assert.equal(predictionAlert(1, 0), true);
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
