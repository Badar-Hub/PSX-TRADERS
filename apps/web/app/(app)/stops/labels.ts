/** Wording shared by the page and the cards, so the two never disagree. */

export function labelFor(type: string): string {
  if (type === 'STOP_LOSS') return 'stop-loss';
  if (type === 'TRAILING_STOP') return 'trailing stop';
  if (type === 'TAKE_PROFIT') return 'target';
  return type.toLowerCase().replace('_', ' ');
}

export function triggerLabel(triggerOn: string): string {
  if (triggerOn === 'CLOSE') return 'on the close';
  if (triggerOn === 'INTRADAY_LOW') return "on the day's low";
  return "on the day's high";
}
