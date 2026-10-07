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
  const result = summarizeResponses([{ ...project, blocks: windows }], [{ ...monitor, id: 'm', active: true, promptCount: 345, models: ['a'] }], timezone, true, now, []);
  assert.equal(result.byMonitor.m.daily, 345);
  assert.equal(result.byMonitor.m.weekly, 690);
  assert.equal(result.byMonitor.m.monthly, 2760);
  assert.equal(result.byProject.p.weeklyPredicted, 690);
  assert.equal(result.byProject.p.monthlyPredicted, 2760);
});
test('every project uses its own ON monitors and saved factors without changing actuals', () => {
  const projects = [{ id: 'a', blocks: [] }, { id: 'b', blocks: [] }];
  const monitors = [
    { ...monitor, id: 'a-on', projectId: 'a' },
    { ...monitor, id: 'a-off', projectId: 'a', active: false, promptCount: 100 },
    { ...monitor, id: 'b-on', projectId: 'b', promptCount: 3 },
  ];
  const report = { periodFrom: new Date('2026-10-06'), periodTo: new Date('2026-11-06'), responses: 23, providerLimit: 15000, projects: [{ id: 'a', name: 'A', responses: 23, cap: null }], observedAt: now };
  const result = summarizeResponses(projects, monitors, timezone, true, now, [], report, [{ projectId: 'a', baseResponses: null, runsPerWeek: 3, weeksPerMonth: 4 }]);
  assert.equal(result.byProject.a.monthlyPredicted, 20 * 3 * 4);
  assert.equal(result.byProject.b.monthlyPredicted, 6 * 7 * 4);
  assert.equal(result.byMonitor['a-off'].monthly, 0);
  assert.equal(result.byProject.a.used, 23);
  assert.equal(result.used, 23);
  const overridden = summarizeResponses(projects, monitors, timezone, true, now, [], report, [{ projectId: 'a', baseResponses: 100, runsPerWeek: 2, weeksPerMonth: 5 }]);
  assert.equal(overridden.byProject.a.monthlyPredicted, 1000);
  assert.equal(overridden.byProject.b.monthlyPredicted, 168);
  assert.equal(overridden.used, 23);
});
test('scheduled OFF monitors retain weekly and monthly plans while daily stays zero', () => {
  const blocks = [{ startDay: 1, startTime: '00:00', endDay: 1, endTime: '17:00', trigger: 'on_off' }];
  const scheduled = { ...project, blocks };
  const off = { ...monitor, id: 'monsoon', active: false, promptCount: 25, models: ['a', 'b', 'c'] };
  const result = summarizeResponses([scheduled], [off], timezone, true, now, []);
  assert.equal(result.byMonitor.monsoon.daily, 0);
  assert.equal(result.byMonitor.monsoon.weekly, 75);
  assert.equal(result.byMonitor.monsoon.monthly, 300);
  assert.equal(result.byProject.p.dailyEstimate, 0);
  assert.equal(result.byProject.p.weeklyPredicted, 75);
  assert.equal(result.byProject.p.monthlyPredicted, 300);
  const on = summarizeResponses([scheduled], [{ ...off, active: true }], timezone, true, now, []);
  assert.equal(on.byProject.p.dailyEstimate, 75);
  assert.equal(on.byProject.p.monthlyPredicted, 300);
  const paused = summarizeResponses([scheduled], [off], timezone, false, now, []);
  assert.equal(paused.byProject.p.weeklyPredicted, 0);
});
test('one partial OFF day gives six runs across project and monitor estimates', () => {
  const blocks = [{ startDay: 0, startTime: '09:00', endDay: 0, endTime: '17:00', trigger: 'off_on' }];
  const result = summarizeResponses([{ ...project, blocks }], [{ ...monitor, id: 'nip', promptCount: 61, models: ['a', 'b', 'c'] }], timezone, true, now, []);
  assert.equal(result.byProject.p.calculation.runsPerWeek, 6);
  assert.equal(result.byProject.p.weeklyPredicted, 1098);
  assert.equal(result.byProject.p.monthlyPredicted, 4392);
  assert.equal(result.byMonitor.nip.weekly, 1098);
  assert.equal(result.byMonitor.nip.monthly, 4392);
});
