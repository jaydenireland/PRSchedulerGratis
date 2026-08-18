/**
 * Turns a pull request comment into a scheduler command.
 *
 * Commands live on their own line and start with the trigger word, mirroring
 * the original app's `@prscheduler 26/08/2019T11:05` syntax.
 */

import { ParseError, parseWhen } from './datetime.js';

export const MERGE_METHODS = ['merge', 'squash', 'rebase'];

const CANCEL_WORDS = new Set(['cancel', 'unschedule', 'stop', 'abort', 'clear']);
const STATUS_WORDS = new Set(['status', 'when', 'info']);
const HELP_WORDS = new Set(['help', '?', 'usage']);

/** Strip fenced code blocks and blockquotes so quoted commands don't re-fire. */
function commandLines(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const out = [];
  let fence = null;

  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^\s*>/.test(line)) continue; // quoted reply
    out.push(line);
  }
  return out;
}

/** Split flags (`--squash`) from the positional remainder. */
function extractFlags(argText) {
  const flags = [];
  const rest = argText
    .replace(/(^|\s)(--[a-z0-9-]+(?:=[^\s]+)?)/gi, (_match, lead, flag) => {
      flags.push(flag.toLowerCase());
      return lead;
    })
    .trim()
    .replace(/\s+/g, ' ');
  return { flags, rest };
}

function applyFlags(flags) {
  const options = {};
  const unknown = [];

  for (const flag of flags) {
    const [name, value] = flag.replace(/^--/, '').split('=');
    switch (name) {
      case 'merge-method':
      case 'method':
        if (!MERGE_METHODS.includes(value)) {
          unknown.push(`\`--${name}=${value ?? ''}\` (expected one of ${MERGE_METHODS.map((m) => `\`${m}\``).join(', ')})`);
        } else {
          options.mergeMethod = value;
        }
        break;
      case 'squash':
      case 'rebase':
        options.mergeMethod = name;
        break;
      case 'merge':
        options.mergeMethod = 'merge';
        break;
      case 'delete-branch':
        options.deleteBranch = value === undefined ? true : value === 'true';
        break;
      case 'no-delete-branch':
        options.deleteBranch = false;
        break;
      case 'force':
        options.force = true;
        break;
      default:
        unknown.push(`\`--${name}\``);
    }
  }
  return { options, unknown };
}

/**
 * Parse a comment body.
 *
 * @param {string} body
 * @param {object} [options]
 * @param {string} [options.trigger]         defaults to `@prscheduler`
 * @param {string} [options.defaultTimeZone]
 * @param {Date}   [options.now]
 * @returns {null | {kind: string, ...}} null when the comment holds no command
 */
export function parseCommand(body, { trigger = '@prscheduler', defaultTimeZone = 'UTC', now = new Date() } = {}) {
  const triggerPattern = new RegExp(`^\\s*${escapeRegExp(trigger)}(?![\\w-])\\s*(.*)$`, 'i');

  // Later commands win, so the newest instruction in an edited comment is the
  // one that takes effect.
  let match = null;
  for (const line of commandLines(body)) {
    const found = triggerPattern.exec(line);
    if (found) match = found[1].trim();
  }
  if (match === null) return null;

  const raw = match;
  if (!raw) return { kind: 'help', raw, reason: 'empty' };

  const firstWord = raw.split(/\s+/)[0].toLowerCase().replace(/[.,!]$/, '');
  if (CANCEL_WORDS.has(firstWord)) return { kind: 'cancel', raw };
  if (STATUS_WORDS.has(firstWord)) return { kind: 'status', raw };
  if (HELP_WORDS.has(firstWord)) return { kind: 'help', raw };

  const { flags, rest } = extractFlags(raw);
  const { options, unknown } = applyFlags(flags);
  if (unknown.length > 0) {
    return { kind: 'error', raw, message: `I don't understand the option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}.` };
  }

  if (!rest) {
    return { kind: 'error', raw, message: 'You gave me options but no date or time to schedule.' };
  }

  try {
    const when = parseWhen(rest, { defaultTimeZone, now });
    return {
      kind: 'schedule',
      raw,
      scheduledFor: when.date,
      timeZoneLabel: when.timeZoneLabel,
      whenInput: when.input,
      options,
    };
  } catch (error) {
    if (error instanceof ParseError) return { kind: 'error', raw, message: error.message };
    throw error;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
