import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResponses } from '../src/lib/responses';
const now = new Date('2026-10-20T06:00:00Z');
const timezone = 'Asia/Kolkata';
const project = { id: 'p', blocks: [] };
const monitor = { projectId: 'p', active: true, promptCount: 10, models: ['a', 'b'] };
test('actual history survives schedule edits; totals include removed projects', async () => {
  const usage = [
    { projectId: 'p', start: '2026-10-06', end: '2026-11-06', timezone, responses: 700, observedAt: now },
    { projectId: 'p', start: '2026-10-19', end: '2026-10-26', timezone, responses: 30, observedAt: now },
    { projectId: 'p', start: '2026-10-20', end: '2026-10-21', timezone, responses: 10, observedAt: now },
    { projectId: 'removed-project', start: '2026-10-06', end: '2026-11-06', timezone, responses: 50, observedAt: now },
  ];
    const report = { periodFrom: new Date("2026-10-06T00:00:00Z"), periodTo: new Date("2026-11-06T00:00:00Z"), responses: 750, providerLimit: 15000, projects: [{ id: "p", name: "Test", responses: 700, cap: null }, { id: "removed-project", name: "Removed", responses: 50, cap: null }], observedAt: now };
    const before = summarizeResponses([project], [monitor], timezone, true, now, usage, report);
    const after = summarizeResponses([{ ...project, blocks: [{ startDay: 1, startTime: '09:00', endDay: 1, endTime: '17:00', trigger: 'on_off' }] }], [monitor], timezone, true, now, usage, report);
    assert.equal(before.byProject.p.used, 700);
    assert.equal(after.byProject.p.used, 700);
    assert.equal(before.used, 750);
    assert.equal(after.used, 750);
    assert.ok(after.forecast! < before.forecast!);
    assert.equal(before.byProject.p.forecast, 1040); // 700 actual + 140/week ÷ 7 × 17 rounded-up days
    assert.equal(before.forecast, 1090); // includes historical usage of removed project

});
test('missing and stale actuals are not silently presented as fresh zeroes', async () => {

    const result = summarizeResponses([project], [monitor], timezone, true, now, []);
    assert.equal(result.used, null);
    assert.equal(result.remaining, null);
    assert.equal(result.forecast, null);
    assert.equal(result.stale, true);
    assert.equal(result.byProject.p.alert, false);

});
test('official consumption wins over response records and account limit does not override chosen allowance', () => {
  const at = new Date('2026-10-06T08:00:00Z');
  const report = { periodFrom: new Date('2026-10-06T00:00:00Z'), periodTo: new Date('2026-11-06T00:00:00Z'), responses: 363, providerLimit: 15000, projects: [{ id: 'p', name: 'Test', responses: 363, cap: null }], observedAt: at };
  const result = summarizeResponses([project], [monitor], timezone, true, at, [], report);
  assert.equal(result.used, 363);
  assert.equal(result.byProject.p.used, 363);
  assert.equal(result.byProject.p.weeklyUsed, 363);
  assert.equal(result.limit, 10000);
  assert.equal(result.providerLimit, 15000);
  assert.equal(result.remaining, 9637);
  assert.equal(result.resetAt, '2026-11-06T00:00:00.000Z');
});
test('expired official counts cannot leak into the new cycle', () => {
  const report = { periodFrom: new Date('2026-09-06T00:00:00Z'), periodTo: new Date('2026-10-06T00:00:00Z'), responses: 9900, providerLimit: 15000, projects: [], observedAt: new Date('2026-10-05T23:00:00Z') };
  const result = summarizeResponses([project], [monitor], timezone, true, now, [], report);
  assert.equal(result.used, null);
  assert.equal(result.start, '2026-10-06');
  assert.equal(result.stale, true);
});
test('shared weekly estimates always count a full week, including the reset week', () => {
  const at = new Date('2026-10-07T08:00:00Z');
  const result = summarizeResponses([project], [{ ...monitor, id: 'm' }], timezone, true, at, [], null);
  assert.equal(result.byMonitor.m.daily, 20);
  assert.equal(result.byMonitor.m.weekly, 140);
  assert.equal(result.byMonitor.m.monthly, 560);
  assert.equal(result.byProject.p.weeklyPredicted, 140);
});
test('duration-based weekly runs feed monitor and project monthly estimates', () => {
  const windows = [
    { startDay: 0, startTime: '09:00', endDay: 1, endTime: '09:00', trigger: 'on_off' },
    { startDay: 3, startTime: '09:00', endDay: 4, endTime: '09:00', trigger: 'on_off' },
  ];
  const result = summarizeResponses([{ ...project, blocks: windows }], [{ ...monitor, id: 'm', active: false, promptCount: 345, models: ['a'] }], timezone, true, now, []);
  assert.equal(result.byMonitor.m.daily, 0);
  assert.equal(result.byMonitor.m.weekly, 690);
  assert.equal(result.byMonitor.m.monthly, 2760);
  assert.equal(result.byProject.p.weeklyPredicted, 690);
  assert.equal(result.byProject.p.monthlyPredicted, 2760);
});
