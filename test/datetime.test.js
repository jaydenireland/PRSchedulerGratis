import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ParseError, formatInZone, humanizeDelta, isValidTimeZone, parseWhen, resolveTimeZone,
} from '../src/datetime.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const iso = (input, options) => parseWhen(input, { now: NOW, ...options }).date.toISOString();

describe('parseWhen', () => {
  it('reads the original DD/MM/YYYYTHH:MM format as UTC', () => {
    assert.equal(iso('26/08/2019T11:05'), '2019-08-26T11:05:00.000Z');
    assert.equal(iso('05/04/2022T14:00'), '2022-04-05T14:00:00.000Z');
  });

  it('treats the day as first, not the month', () => {
    // 05/04 is 5 April, not 4 May — the difference the US format would get wrong.
    assert.equal(iso('05/04/2027T00:00'), '2027-04-05T00:00:00.000Z');
  });

  it('accepts a space or a T between date and time', () => {
    assert.equal(iso('26/08/2026 11:05'), iso('26/08/2026T11:05'));
  });

  it('accepts seconds and alternative separators', () => {
    assert.equal(iso('26-08-2026T11:05:30'), '2026-08-26T11:05:30.000Z');
    assert.equal(iso('26.08.2026T11:05'), '2026-08-26T11:05:00.000Z');
  });

  it('applies a named timezone abbreviation', () => {
    assert.equal(iso('17/05/2020T19:06 BST'), '2020-05-17T18:06:00.000Z');
    assert.equal(iso('17/05/2020T19:06 JST'), '2020-05-17T10:06:00.000Z');
  });

  it('applies a GMT offset', () => {
    assert.equal(iso('17/05/2020T19:06 GMT+5'), '2020-05-17T14:06:00.000Z');
    assert.equal(iso('17/05/2020T19:06 GMT-2'), '2020-05-17T21:06:00.000Z');
    assert.equal(iso('17/05/2020T19:06 UTC+05:30'), '2020-05-17T13:36:00.000Z');
  });

  it('applies an IANA zone, honouring daylight saving on that date', () => {
    assert.equal(iso('26/08/2026 11:05 Europe/London'), '2026-08-26T10:05:00.000Z');
    assert.equal(iso('26/12/2026 11:05 Europe/London'), '2026-12-26T11:05:00.000Z');
    assert.equal(iso('26/12/2026 11:05 America/New_York'), '2026-12-26T16:05:00.000Z');
  });

  it('uses the configured default zone when the comment names none', () => {
    assert.equal(iso('26/12/2026 11:05', { defaultTimeZone: 'America/New_York' }), '2026-12-26T16:05:00.000Z');
  });

  it('reads ISO-8601 timestamps, with or without an offset', () => {
    assert.equal(iso('2026-08-26T11:05Z'), '2026-08-26T11:05:00.000Z');
    assert.equal(iso('2026-08-26T11:05+05:30'), '2026-08-26T05:35:00.000Z');
    assert.equal(iso('2026-08-26 11:05'), '2026-08-26T11:05:00.000Z');
  });

  it('reads relative delays, rounded to the minute', () => {
    assert.equal(iso('in 2 hours'), '2026-08-18T14:00:00.000Z');
    assert.equal(iso('in 30m'), '2026-08-18T12:30:00.000Z');
    assert.equal(iso('in 1 week'), '2026-08-25T12:00:00.000Z');
    assert.equal(iso('+45 minutes'), '2026-08-18T12:45:00.000Z');
  });

  it('reports the timezone it used', () => {
    assert.equal(parseWhen('26/08/2026T11:05 BST', { now: NOW }).timeZoneLabel, 'BST');
    assert.equal(parseWhen('26/08/2026T11:05 GMT+5', { now: NOW }).timeZoneLabel, 'UTC+05:00');
    assert.equal(parseWhen('26/08/2026T11:05', { now: NOW }).timeZoneLabel, 'UTC');
  });

  it('rejects dates that do not exist', () => {
    assert.throws(() => parseWhen('31/02/2026T10:00'), ParseError);
    assert.throws(() => parseWhen('00/01/2026T10:00'), ParseError);
    assert.throws(() => parseWhen('26/13/2026T10:00'), ParseError);
  });

  it('accepts 29 February in a leap year and rejects it otherwise', () => {
    assert.equal(iso('29/02/2028T10:00'), '2028-02-29T10:00:00.000Z');
    assert.throws(() => parseWhen('29/02/2027T10:00'), ParseError);
  });

  it('rejects impossible clock times', () => {
    assert.throws(() => parseWhen('26/08/2026T25:00'), ParseError);
    assert.throws(() => parseWhen('26/08/2026T10:75'), ParseError);
  });

  it('rejects text it cannot read, and unknown zones', () => {
    assert.throws(() => parseWhen('tomorrow'), ParseError);
    assert.throws(() => parseWhen(''), ParseError);
    assert.throws(() => parseWhen('26/08/2026T11:05 Mars/Olympus'), ParseError);
    assert.throws(() => parseWhen('in 3 fortnights'), ParseError);
  });
});

describe('resolveTimeZone', () => {
  it('defaults to UTC when given nothing', () => {
    assert.equal(resolveTimeZone('').timeZone, 'UTC');
  });

  it('rejects offsets beyond the real range', () => {
    assert.throws(() => resolveTimeZone('GMT+25'), ParseError);
  });

  it('recognises IANA names', () => {
    assert.equal(resolveTimeZone('Pacific/Auckland').timeZone, 'Pacific/Auckland');
    assert.ok(isValidTimeZone('Europe/London'));
    assert.ok(!isValidTimeZone('Mars/Olympus'));
  });
});

describe('formatting', () => {
  it('renders an instant in a named zone', () => {
    assert.match(formatInZone(new Date('2026-08-26T11:05:00Z'), 'Europe/London'), /26 Aug 2026, 12:05/);
    assert.match(formatInZone(new Date('2026-08-26T11:05:00Z'), 'UTC'), /26 Aug 2026, 11:05/);
  });

  it('renders an instant at a fixed offset that has no IANA name', () => {
    const { timeZone } = resolveTimeZone('UTC+05:30');
    assert.match(formatInZone(new Date('2026-08-26T11:05:00Z'), timeZone), /26 Aug 2026, 16:35/);
  });

  it('describes a delta in words', () => {
    const from = new Date('2026-08-18T12:00:00Z');
    assert.equal(humanizeDelta(from, new Date('2026-08-20T15:30:00Z')), 'in 2 days and 3 hours');
    assert.equal(humanizeDelta(from, new Date('2026-08-18T12:01:00Z')), 'in 1 minute');
    assert.equal(humanizeDelta(from, new Date('2026-08-18T11:30:00Z')), '30 minutes ago');
    assert.equal(humanizeDelta(from, new Date('2026-08-18T12:00:10Z')), 'in under a minute');
  });
});
