export const log = {
  trace: (..._values: unknown[]) => undefined,
  debug: (..._values: unknown[]) => undefined,
  warn: (...values: unknown[]) => console.warn("[omezarr]", ...values),
  error: (...values: unknown[]) => console.error("[omezarr]", ...values)
};

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
