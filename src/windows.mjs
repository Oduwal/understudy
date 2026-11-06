// Time windows are fixed 15-minute UTC blocks, identified by their start in ms.
export const WINDOW_MS = 15 * 60_000;
export const WINDOWS_PER_DAY = 96;
export const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const windowStart = (ms) => Math.floor(ms / WINDOW_MS) * WINDOW_MS;
export const slotOfDay = (start) => Math.floor((start % DAY_MS) / WINDOW_MS);
export const dayOfWeek = (start) => new Date(start).getUTCDay();
export const weekdayName = (start) => WEEKDAYS[dayOfWeek(start)];
export const clockTime = (ms) => new Date(ms).toISOString().slice(11, 16);
export const describeWindow = (start) =>
  `${weekdayName(start)} ${new Date(start).toISOString().slice(0, 10)} ${clockTime(start)}-${clockTime(start + WINDOW_MS)} UTC`;
