/**
 * parsePlanSelection — parse a plan number choice from user response text.
 *
 * Matches: "1", "2", "3", "plan 1", "Plan 2", "계획 1", "계획1" etc.
 * Returns the selected plan number (1-3) or null if not a plan selection.
 */
export function parsePlanSelection(text: string): number | null {
  const trimmed = text.trim();
  // Exact number: "1", "2", "3"
  if (/^[1-3]$/.test(trimmed)) return parseInt(trimmed, 10);
  // "plan N" or "Plan N"
  const planMatch = trimmed.match(/^plan\s*([1-3])$/i);
  if (planMatch) return parseInt(planMatch[1], 10);
  // "계획 N" or "계획N"
  const koreanMatch = trimmed.match(/^계획\s*([1-3])$/);
  if (koreanMatch) return parseInt(koreanMatch[1], 10);
  return null;
}
