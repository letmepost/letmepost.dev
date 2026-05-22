/**
 * Calendar-month period helpers. Period strings are "YYYY-MM" in UTC.
 * Quotas reset on the first second of the next month.
 */
export function periodFor(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function periodResetAt(date: Date = new Date()): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  // First second of the next UTC month.
  return new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
}
