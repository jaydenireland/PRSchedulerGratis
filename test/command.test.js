import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCommand } from '../src/command.js';

const NOW = new Date('2026-08-18T12:00:00Z');
const parse = (body, options) => parseCommand(body, { now: NOW, ...options });

describe('parseCommand', () => {
  it('reads a bare schedule command', () => {
    const command = parse('@prscheduler 26/08/2026T11:05');
    assert.equal(command.kind, 'schedule');
    assert.equal(command.scheduledFor.toISOString(), '2026-08-26T11:05:00.000Z');
  });

  it('finds a command among other prose', () => {
    const command = parse('Nice work!\n\n@prscheduler 26/08/2026T11:05 BST\n\nShipping Tuesday.');
    assert.equal(command.kind, 'schedule');
    assert.equal(command.timeZoneLabel, 'BST');
  });

  it('ignores comments with no command', () => {
    assert.equal(parse('Looks good to me'), null);
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
  });

  it('does not fire on a word that merely starts with the trigger', () => {
    assert.equal(parse('@prschedulerbot please merge'), null);
    assert.equal(parse('mail me at hi@prscheduler.com'), null);
  });

  it('ignores commands inside quoted replies', () => {
    assert.equal(parse('> @prscheduler 26/08/2026T11:05\n\nI would not do that.'), null);
  });

  it('ignores commands inside fenced code blocks', () => {
    assert.equal(parse(['```', '@prscheduler 26/08/2026T11:05', '```'].join('\n')), null);
    assert.equal(parse(['~~~', '@prscheduler 26/08/2026T11:05', '~~~'].join('\n')), null);
  });

  it('honours a real command that follows a fenced example', () => {
    const command = parse(['```', '@prscheduler 01/01/2027T00:00', '```', '@prscheduler 02/02/2027T00:00'].join('\n'));
    assert.equal(command.scheduledFor.toISOString(), '2027-02-02T00:00:00.000Z');
  });

  it('lets the last command in a comment win', () => {
    const command = parse('@prscheduler 26/08/2026T11:05\n@prscheduler 27/08/2026T09:00');
    assert.equal(command.scheduledFor.toISOString(), '2026-08-27T09:00:00.000Z');
  });

  it('matches the trigger regardless of case', () => {
    assert.equal(parse('@PRScheduler status').kind, 'status');
  });

  it('recognises cancel, status and help, including their aliases', () => {
    for (const word of ['cancel', 'unschedule', 'stop', 'abort', 'clear']) {
      assert.equal(parse(`@prscheduler ${word}`).kind, 'cancel', word);
    }
    for (const word of ['status', 'when', 'info']) {
      assert.equal(parse(`@prscheduler ${word}`).kind, 'status', word);
    }
    for (const word of ['help', 'usage', '?']) {
      assert.equal(parse(`@prscheduler ${word}`).kind, 'help', word);
    }
  });

  it('treats a bare trigger as a request for help', () => {
    assert.equal(parse('@prscheduler').kind, 'help');
  });

  it('reads merge-method options', () => {
    assert.equal(parse('@prscheduler 26/08/2026T11:05 --squash').options.mergeMethod, 'squash');
    assert.equal(parse('@prscheduler 26/08/2026T11:05 --rebase').options.mergeMethod, 'rebase');
    assert.equal(parse('@prscheduler --merge-method=squash 26/08/2026T11:05').options.mergeMethod, 'squash');
  });

  it('reads branch and force options', () => {
    const command = parse('@prscheduler in 3 days --delete-branch --force');
    assert.equal(command.options.deleteBranch, true);
    assert.equal(command.options.force, true);
    assert.equal(parse('@prscheduler in 3 days --no-delete-branch').options.deleteBranch, false);
  });

  it('rejects unknown options and bad option values', () => {
    assert.equal(parse('@prscheduler 26/08/2026T11:05 --bogus').kind, 'error');
    assert.match(parse('@prscheduler 26/08/2026T11:05 --merge-method=fastforward').message, /expected one of/);
  });

  it('rejects options with no time to go with them', () => {
    const command = parse('@prscheduler --squash');
    assert.equal(command.kind, 'error');
    assert.match(command.message, /no date or time/);
  });

  it('reports an unreadable time as an error rather than throwing', () => {
    const command = parse('@prscheduler sometime next week');
    assert.equal(command.kind, 'error');
    assert.match(command.message, /couldn't read/);
  });

  it('honours a custom trigger word', () => {
    assert.equal(parse('@prscheduler 26/08/2026T11:05', { trigger: '/merge-at' }), null);
    assert.equal(parse('/merge-at 26/08/2026T11:05', { trigger: '/merge-at' }).kind, 'schedule');
  });

  it('honours the configured default timezone', () => {
    const command = parse('@prscheduler 26/12/2026T11:05', { defaultTimeZone: 'America/New_York' });
    assert.equal(command.scheduledFor.toISOString(), '2026-12-26T16:05:00.000Z');
  });
});
