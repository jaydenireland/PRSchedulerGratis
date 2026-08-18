import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, applyInputOverrides, parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('returns the defaults for an empty file', () => {
    assert.deepEqual(parseConfig('').config, DEFAULT_CONFIG);
    assert.deepEqual(parseConfig('# just a comment').config, DEFAULT_CONFIG);
  });

  it('reads every supported setting', () => {
    const { config, warnings } = parseConfig([
      'trigger: "@merge-at"',
      'timezone: Europe/London',
      'merge-method: squash',
      'delete-branch: true',
      'require-checks: false',
      'require-approval: true',
      'minimum-permission: maintain',
      'label: queued',
      'label-color: "#0E8A16"',
      'grace-period-minutes: 30',
      'max-schedule-days: 90',
      'reactions: false',
    ].join('\n'));
    assert.deepEqual(warnings, []);
    assert.equal(config.trigger, '@merge-at');
    assert.equal(config.timezone, 'Europe/London');
    assert.equal(config.mergeMethod, 'squash');
    assert.equal(config.deleteBranch, true);
    assert.equal(config.requireChecks, false);
    assert.equal(config.requireApproval, true);
    assert.equal(config.minimumPermission, 'maintain');
    assert.equal(config.label, 'queued');
    assert.equal(config.labelColor, '0e8a16');
    assert.equal(config.gracePeriodMinutes, 30);
    assert.equal(config.maxScheduleDays, 90);
    assert.equal(config.reactions, false);
  });

  it('accepts kebab-case, snake_case and camelCase keys', () => {
    assert.equal(parseConfig('merge-method: squash').config.mergeMethod, 'squash');
    assert.equal(parseConfig('merge_method: rebase').config.mergeMethod, 'rebase');
    assert.equal(parseConfig('mergeMethod: squash').config.mergeMethod, 'squash');
  });

  it('accepts yes/no and on/off for booleans', () => {
    assert.equal(parseConfig('delete-branch: "yes"').config.deleteBranch, true);
    assert.equal(parseConfig('require-checks: "off"').config.requireChecks, false);
  });

  it('warns and keeps the default for an invalid value', () => {
    const { config, warnings } = parseConfig([
      'merge-method: fastforward',
      'timezone: Mars/Olympus',
      'grace-period-minutes: -5',
      'minimum-permission: sudo',
      'label-color: nothex',
    ].join('\n'));
    assert.equal(config.mergeMethod, DEFAULT_CONFIG.mergeMethod);
    assert.equal(config.timezone, DEFAULT_CONFIG.timezone);
    assert.equal(config.gracePeriodMinutes, DEFAULT_CONFIG.gracePeriodMinutes);
    assert.equal(config.minimumPermission, DEFAULT_CONFIG.minimumPermission);
    assert.equal(config.labelColor, DEFAULT_CONFIG.labelColor);
    assert.equal(warnings.length, 5);
  });

  it('warns about settings it does not know', () => {
    const { warnings } = parseConfig('mystery-setting: 1');
    assert.match(warnings[0], /Unknown setting `mystery-setting`/);
  });

  it('falls back to the defaults when the YAML is broken', () => {
    const { config, warnings } = parseConfig('trigger: [unclosed');
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.match(warnings[0], /not valid YAML/);
  });

  it('rejects a file that is not a mapping', () => {
    assert.match(parseConfig('- one\n- two').warnings[0], /mapping of settings/);
  });

  it('refuses a trigger containing whitespace', () => {
    const { config, warnings } = parseConfig('trigger: "merge at"');
    assert.equal(config.trigger, DEFAULT_CONFIG.trigger);
    assert.match(warnings[0], /single word/);
  });

  it('accepts a bare UTC offset as the default timezone', () => {
    assert.equal(parseConfig('timezone: "GMT+5"').config.timezone, 'GMT+5');
  });
});

describe('applyInputOverrides', () => {
  it('lets action inputs win over the file', () => {
    const base = parseConfig('merge-method: merge').config;
    const { config } = applyInputOverrides(base, { mergeMethod: 'rebase' });
    assert.equal(config.mergeMethod, 'rebase');
  });

  it('ignores blank inputs so unset ones do not clobber the file', () => {
    const base = parseConfig('merge-method: squash\nlabel: queued').config;
    const { config } = applyInputOverrides(base, { mergeMethod: '', label: undefined, trigger: null });
    assert.equal(config.mergeMethod, 'squash');
    assert.equal(config.label, 'queued');
  });

  it('coerces string inputs, since every action input arrives as a string', () => {
    const { config } = applyInputOverrides(DEFAULT_CONFIG, { requireChecks: 'false', gracePeriodMinutes: '15' });
    assert.equal(config.requireChecks, false);
    assert.equal(config.gracePeriodMinutes, 15);
  });
});
