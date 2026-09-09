/**
 * Date formatting utilities for Indian date presentation (DD-MM-YYYY).
 */

/**
 * Format a date string (YYYY-MM-DD), Date object, or timestamp to Indian format DD-MM-YYYY.
 * Preserves empty/null values gracefully.
 * @param {string|Date|number} value
 * @returns {string}
 */
export function formatDisplayDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const day = String(value.getDate()).padStart(2, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const year = value.getFullYear();
    return `${day}-${month}-${year}`;
  }

  const str = String(value).trim();
  // Already in DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    return str;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [year, month, day] = str.split('-');
    return `${day}-${month}-${year}`;
  }
  // ISO string with T or space (e.g. 2024-05-15T12:00:00)
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(str)) {
    const datePart = str.slice(0, 10);
    const [year, month, day] = datePart.split('-');
    return `${day}-${month}-${year}`;
  }

  // Attempt Date parse as fallback
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const day = String(parsed.getDate()).padStart(2, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const year = parsed.getFullYear();
    return `${day}-${month}-${year}`;
  }

  return str;
}

/**
 * Format timestamp to DD-MM-YYYY HH:mm:ss or DD-MM-YYYY HH:mm
 * @param {string|Date|number} value
 * @param {boolean} [includeSeconds=true]
 * @returns {string}
 */
export function formatDisplayDateTime(value, includeSeconds = true) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const mins = String(date.getMinutes()).padStart(2, '0');
  const time = includeSeconds
    ? `${hours}:${mins}:${String(date.getSeconds()).padStart(2, '0')}`
    : `${hours}:${mins}`;

  return `${day}-${month}-${year} ${time}`;
}

/**
 * Format a start and end date as 'DD-MM-YYYY to DD-MM-YYYY'
 * @param {string|Date} start
 * @param {string|Date} end
 * @returns {string}
 */
export function formatDateRange(start, end) {
  if (!start && !end) return '';
  if (start && !end) return formatDisplayDate(start);
  if (!start && end) return formatDisplayDate(end);
  return `${formatDisplayDate(start)} to ${formatDisplayDate(end)}`;
}

/**
 * Convert a DD-MM-YYYY date back to YYYY-MM-DD for native HTML date pickers / API params.
 * @param {string} value
 * @returns {string}
 */
export function toIsoDate(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (/^\d{2}-\d{2}-\d{4}$/.test(str)) {
    const [day, month, year] = str.split('-');
    return `${year}-${month}-${day}`;
  }
  return str;
}

export default {
  formatDisplayDate,
  formatDisplayDateTime,
  formatDateRange,
  toIsoDate,
};
