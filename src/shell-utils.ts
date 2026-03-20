/**
 * Shell escaping utility — wraps a value in single quotes,
 * escaping any embedded single quotes.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
