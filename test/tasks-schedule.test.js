import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, nextOccurrence, previewSchedule } from '../server/tasks/schedule.js';
const ms = value => Date.parse(value), iso = value => new Date(value).toISOString();

test('one-off and interval slots use exact instants, preserve anchors and never return the previous slot', () => {
  const now = ms('2024-01-01T00:00:00Z');
  const once = normalizeSchedule({kind:'once',at:'2024-01-01T01:00:00+01:00'}, {now:now-1000});
  assert.equal(once.at,'2024-01-01T00:00:00Z');assert.equal(nextOccurrence(once,now),null);
  const interval = normalizeSchedule({kind:'interval',everyMinutes:5,firstAt:'2024-01-01T00:05:00Z'}, {now});
  assert.deepEqual(previewSchedule(interval,now,3).map(iso),['2024-01-01T00:05:00.000Z','2024-01-01T00:10:00.000Z','2024-01-01T00:15:00.000Z']);
  assert.equal(iso(nextOccurrence(interval,ms('2024-01-02T12:11:25Z'))),'2024-01-02T12:15:00.000Z');
  assert.equal(nextOccurrence(interval,ms('2024-01-01T00:05:00Z')),ms('2024-01-01T00:10:00Z'));
});

test('daily wall times follow DST calendar days and a missing time moves forward by the gap', () => {
  const spec = {kind:'daily',time:'02:30',timeZone:'America/Los_Angeles'};
  assert.deepEqual(previewSchedule(spec,ms('2024-03-09T00:00:00Z'),3).map(iso),[
    '2024-03-09T10:30:00.000Z','2024-03-10T10:30:00.000Z','2024-03-11T09:30:00.000Z']);
  assert.deepEqual(previewSchedule({kind:'daily',time:'09:00',timeZone:'America/Los_Angeles'},ms('2024-03-09T18:00:00Z'),2).map(iso),[
    '2024-03-10T16:00:00.000Z','2024-03-11T16:00:00.000Z']);
});

test('a repeated daily or weekly wall time runs at its first occurrence only', () => {
  const daily={kind:'daily',time:'01:30',timeZone:'America/Los_Angeles'};
  assert.equal(iso(nextOccurrence(daily,ms('2024-11-03T07:00:00Z'))),'2024-11-03T08:30:00.000Z');
  assert.equal(iso(nextOccurrence(daily,ms('2024-11-03T08:30:00Z'))),'2024-11-04T09:30:00.000Z');
  assert.equal(iso(nextOccurrence(daily,ms('2024-11-03T09:00:00Z'))),'2024-11-04T09:30:00.000Z');
  const weekly={...daily,kind:'weekly',weekdays:[7]};
  assert.equal(iso(nextOccurrence(weekly,ms('2024-11-03T08:30:00Z'))),'2024-11-10T09:30:00.000Z');
});

test('weekly calendars preserve ISO weekdays, leap days and non-hour zone offsets', () => {
  const spec=normalizeSchedule({kind:'weekly',time:'09:15',timeZone:'Asia/Kathmandu',weekdays:[5,1,1]}, {now:ms('2024-02-28T00:00:00Z')});
  assert.deepEqual(spec.weekdays,[1,5]);assert.equal(Object.isFrozen(spec.weekdays),true);
  assert.deepEqual(previewSchedule(spec,ms('2024-02-28T00:00:00Z'),2).map(iso),['2024-03-01T03:30:00.000Z','2024-03-04T03:30:00.000Z']);
  assert.equal(iso(nextOccurrence({kind:'daily',time:'12:00',timeZone:'UTC'},ms('2024-02-28T12:00:00Z'))),'2024-02-29T12:00:00.000Z');
});

test('invalid/ambiguous input shapes, offsets, overflow, horizons and clock values fail explicitly', () => {
  const now=ms('2024-01-01T00:00:00Z');
  for(const input of [null,[],{kind:'cron',expression:'* * * * *'},
    {kind:'once',at:'2024-01-02T09:00'}, {kind:'once',at:'2024-02-30T09:00Z'},
    {kind:'once',at:'2024-01-01T00:00:00Z'}, {kind:'once',at:'2030-01-01T00:00:00Z'},
    {kind:'once',at:'2024-01-02T00:00:00.0001Z'},
    {kind:'interval',everyMinutes:'5',firstAt:'2024-01-02T00:00Z'},
    {kind:'daily',time:'24:00',timeZone:'UTC'}, {kind:'daily',time:'09:00',timeZone:'+01:00'},
    {kind:'daily',time:'09:00',timeZone:'No/Such_Zone'}, {kind:'daily',time:'09:00',timeZone:'UTC',at:'2024-01-02T00:00Z'},
    {kind:'weekly',time:'09:00',timeZone:'UTC',weekdays:[]}, {kind:'weekly',time:'09:00',timeZone:'UTC',weekdays:[0]}]) {
    assert.throws(()=>normalizeSchedule(input,{now}),{code:'invalid_schedule'});
  }
  assert.throws(()=>nextOccurrence({kind:'daily',time:'00:00',timeZone:'UTC'},NaN),{code:'invalid_schedule'});
  assert.throws(()=>previewSchedule({kind:'daily',time:'00:00',timeZone:'UTC'},now,100),{code:'invalid_schedule'});
});
