/**
 * Repository configuration, read from `.github/pr-scheduler.yml`.
 *
 * The file is always read from the base branch, never from the pull request
 * head — otherwise a pull request could relax its own permission checks.
 */

import yaml from 'js-yaml';
import { MERGE_METHODS } from './command.js';
import { isValidTimeZone } from './datetime.js';

export const CONFIG_PATHS = [
  '.github/pr-scheduler.yml',
  '.github/pr-scheduler.yaml',
  '.pr-scheduler.yml',
];

export const DEFAULT_CONFIG = {
  trigger: '@prscheduler',
  timezone: 'UTC',
  mergeMethod: 'merge',
  deleteBranch: false,
  requireChecks: true,
  requireApproval: false,
  minimumPermission: 'write',
  label: 'scheduled-merge',
  labelColor: '0e8a16',
  labelDescription: 'This pull request is queued for a scheduled merge',
  gracePeriodMinutes: 120,
  maxScheduleDays: 365,
  comment: true,
  reactions: true,
};

const PERMISSION_LEVELS = ['read', 'triage', 'write', 'maintain', 'admin'];

/** Accept `merge-method`, `merge_method` and `mergeMethod` alike. */
const camelize = (key) => {
  const trimmed = String(key).trim();
  if (/[-_\s]/.test(trimmed)) {
    return trimmed.toLowerCase().replace(/[-_\s]+(.)/g, (_m, c) => c.toUpperCase());
  }
  // A single word is already camelCase, or shouting; only the first letter needs work.
  const word = /^[A-Z]+$/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  return word.charAt(0).toLowerCase() + word.slice(1);
};

class ConfigWarnings {
  constructor() { this.warnings = []; }

  add(message) { this.warnings.push(message); }
}

function coerceBoolean(value, key, warnings, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', 'yes', 'on'].includes(lowered)) return true;
    if (['false', 'no', 'off'].includes(lowered)) return false;
  }
  warnings.add(`\`${key}\` should be true or false — ignoring \`${value}\`.`);
  return fallback;
}

function coerceNumber(value, key, warnings, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    warnings.add(`\`${key}\` should be a number between ${min} and ${max} — ignoring \`${value}\`.`);
    return fallback;
  }
  return parsed;
}

/**
 * Merge raw YAML over the defaults.
 *
 * @returns {{config: object, warnings: string[]}}
 */
export function normalizeConfig(raw, base = DEFAULT_CONFIG) {
  const warnings = new ConfigWarnings();
  const config = { ...base };

  if (raw === null || raw === undefined || raw === '') return { config, warnings: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, warnings: ['The configuration file should contain a mapping of settings — using defaults.'] };
  }

  for (const [rawKey, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    const key = camelize(rawKey);

    switch (key) {
      case 'trigger': {
        const trigger = String(value).trim();
        if (!trigger || /\s/.test(trigger)) warnings.add('`trigger` must be a single word — ignoring it.');
        else config.trigger = trigger;
        break;
      }
      case 'timezone':
      case 'defaultTimezone': {
        const zone = String(value).trim();
        if (isValidTimeZone(zone) || /^(UTC|GMT)?[+-]\d{1,2}(:?\d{2})?$/i.test(zone)) config.timezone = zone;
        else warnings.add(`\`timezone\` value \`${zone}\` is not a recognised timezone — falling back to \`${config.timezone}\`.`);
        break;
      }
      case 'mergeMethod': {
        const method = String(value).trim().toLowerCase();
        if (MERGE_METHODS.includes(method)) config.mergeMethod = method;
        else warnings.add(`\`merge-method\` must be one of ${MERGE_METHODS.join(', ')} — ignoring \`${value}\`.`);
        break;
      }
      case 'deleteBranch':
        config.deleteBranch = coerceBoolean(value, 'delete-branch', warnings, config.deleteBranch);
        break;
      case 'requireChecks':
        config.requireChecks = coerceBoolean(value, 'require-checks', warnings, config.requireChecks);
        break;
      case 'requireApproval':
        config.requireApproval = coerceBoolean(value, 'require-approval', warnings, config.requireApproval);
        break;
      case 'comment':
      case 'comments':
        config.comment = coerceBoolean(value, 'comment', warnings, config.comment);
        break;
      case 'reactions':
        config.reactions = coerceBoolean(value, 'reactions', warnings, config.reactions);
        break;
      case 'minimumPermission': {
        const level = String(value).trim().toLowerCase();
        if (PERMISSION_LEVELS.includes(level)) config.minimumPermission = level;
        else warnings.add(`\`minimum-permission\` must be one of ${PERMISSION_LEVELS.join(', ')} — ignoring \`${value}\`.`);
        break;
      }
      case 'label': {
        const label = String(value).trim();
        // The issue search takes a comma-separated list, so a comma here would
        // silently become two labels and the queue would never be found.
        if (!label) warnings.add('`label` cannot be empty — ignoring it.');
        else if (label.includes(',')) warnings.add('`label` cannot contain a comma — ignoring it.');
        else config.label = label;
        break;
      }
      case 'labelColor': {
        const color = String(value).trim().replace(/^#/, '');
        if (/^[0-9a-f]{6}$/i.test(color)) config.labelColor = color.toLowerCase();
        else warnings.add(`\`label-color\` should be a six digit hex colour — ignoring \`${value}\`.`);
        break;
      }
      case 'labelDescription':
        config.labelDescription = String(value).trim().slice(0, 100);
        break;
      case 'gracePeriodMinutes':
        config.gracePeriodMinutes = coerceNumber(value, 'grace-period-minutes', warnings, config.gracePeriodMinutes, { min: 0, max: 60 * 24 * 30 });
        break;
      case 'maxScheduleDays':
        config.maxScheduleDays = coerceNumber(value, 'max-schedule-days', warnings, config.maxScheduleDays, { min: 1, max: 3650 });
        break;
      default:
        warnings.add(`Unknown setting \`${rawKey}\` — ignoring it.`);
    }
  }

  return { config, warnings: warnings.warnings };
}

/** Parse YAML text into a config, reporting syntax errors as warnings. */
export function parseConfig(text, base = DEFAULT_CONFIG) {
  try {
    return normalizeConfig(yaml.load(text), base);
  } catch (error) {
    return { config: { ...base }, warnings: [`The configuration file is not valid YAML (${error.message.split('\n')[0]}) — using defaults.`] };
  }
}

/**
 * Fetch and parse the repository configuration.
 *
 * @param {object} octokit
 * @param {{owner: string, repo: string}} repo
 * @param {string} [ref] the base branch; omit for the repository default branch
 */
export async function loadConfig(octokit, { owner, repo }, ref) {
  for (const path of CONFIG_PATHS) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ...(ref ? { ref } : {}) });
      if (Array.isArray(data) || typeof data.content !== 'string') continue;
      const text = Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
      const result = parseConfig(text);
      return { ...result, path };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return { config: { ...DEFAULT_CONFIG }, warnings: [], path: null };
}

/** Action inputs win over the configuration file. */
export function applyInputOverrides(config, inputs) {
  const merged = { ...config };
  const warnings = [];
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === '') continue;
    const { config: applied, warnings: issues } = normalizeConfig({ [key]: value }, merged);
    Object.assign(merged, applied);
    warnings.push(...issues);
  }
  return { config: merged, warnings };
}
