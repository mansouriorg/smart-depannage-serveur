/**
 * Fills "{{name}}" placeholders in a stored template. Missing values become
 * empty; nothing is evaluated and nothing is escaped (the messages are plain text).
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>,
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    // Own properties only: "{{constructor}}" must not print Object's constructor.
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;

    return value === undefined || value === null ? '' : String(value);
  });
}

/** Flat string/number/boolean values of a JSON object, for use as template variables. */
export function flattenVars(
  data: unknown,
  prefix = '',
  out: Record<string, string | number | boolean> = {},
): Record<string, string | number | boolean> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return out;
  }

  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const name = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[name] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && prefix.split('.').length < 2) {
      flattenVars(value, name, out);
    }
  }

  return out;
}
