'use strict';

import { convoPanel, convoPanelFields, panelFieldName, panelFieldOwner } from './panel.js';

// Only use explicit state fields, never infer story facts from prose or machine time.
// Prefer global scene fields, then player fields; character-only fields may refer to another location.
const TYPES = [
  { label: '地点', names: ['当前地点', '所在地', '位置', '地点', '场景', '当前场景', 'location', 'place', 'scene'] },
  { label: '时间', names: ['当前时间', '时间', '时刻', '日期', 'time', 'date'] },
  { label: '天气', names: ['当前天气', '天气', 'weather'] }
];
export function currentScene(convo) {
  if (!convo) return [];
  const values = convoPanel(convo);
  const keys = convoPanelFields(convo);
  const result = [];
  for (const type of TYPES) {
    const candidates = keys.filter(key => type.names.includes(panelFieldName(key).trim().toLowerCase()))
      .filter(key => ['', 'scene', 'player'].includes(panelFieldOwner(convo, key)))
      .sort((a, b) => Number(panelFieldOwner(convo, a) === 'player') - Number(panelFieldOwner(convo, b) === 'player'));
    const key = candidates.find(key => {
      const value = values[key];
      return (typeof value === 'string' || typeof value === 'number') && String(value).trim();
    });
    if (key) result.push({ label: type.label, value: String(values[key]).trim(), key });
  }
  return result;
}
