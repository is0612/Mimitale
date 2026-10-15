'use strict';

// Settings and the right rail edit this single global source. Legacy conversation
// sampling is retained in saved conversations, but no longer overrides it.
export const GENERATION_DEFAULTS = Object.freeze({ temperature: 0.7, topP: 0.95, maxTokens: 8192, thinking: true });
export const GENERATION_FIELDS = [
  { key: 'temperature', min: 0, max: 2, digits: 2 },
  { key: 'topP', min: 0, max: 1, digits: 2 },
  { key: 'maxTokens', min: 64, max: 32000, digits: 0 }
];

export function globalGeneration(settings = {}) {
  const result = { ...GENERATION_DEFAULTS };
  for (const field of GENERATION_FIELDS) {
    const raw = settings[field.key];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(n)) {
      const value = Math.min(field.max, Math.max(field.min, n));
      result[field.key] = field.digits ? value : Math.round(value);
    }
  }
  if (typeof settings.thinking === 'boolean') result.thinking = settings.thinking;
  return result;
}
