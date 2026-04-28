/** Single app clock: IANA zone + region label; wall datetime ↔ UTC without relying on browser local TZ. */

import type { ResolvedAppTime, UserAppTime } from "../config/user-settings.js";

/** OS / runtime default IANA zone. */
export function getSystemIanaTimeZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof z === "string" && z.length ? z : "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidIanaTimeZone(id: string): boolean {
  const s = id.trim();
  if (!s) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

/**
 * Region / generic zone name for UI (not necessarily a city), plus IANA in parentheses.
 */
export function buildAutoRegionLabel(iana: string): string {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: iana,
      timeZoneName: "longGeneric",
    }).formatToParts(now);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value;
    if (tzName && tzName.length) {
      return `${tzName} · ${iana}`;
    }
  } catch {
    /* fall through */
  }
  return iana;
}

/** Effective app clock: one IANA zone + label; optional user override for label only. */
export function mergeResolvedAppTime(user: UserAppTime | undefined): ResolvedAppTime {
  const deviceTimeZone = getSystemIanaTimeZone();
  const raw = user?.timeZone?.trim() ?? "";
  let timeZone = deviceTimeZone;
  if (raw.length > 0 && raw !== "__system__") {
    timeZone = isValidIanaTimeZone(raw) ? raw.trim() : deviceTimeZone;
  }
  const labelOverride = user?.regionLabel?.trim() ?? "";
  const regionLabel = labelOverride.length > 0 ? labelOverride : buildAutoRegionLabel(timeZone);
  return {
    timeZone,
    regionLabel,
    deviceTimeZone,
  };
}

/**
 * Parse `YYYY-MM-DDTHH:mm` as wall clock in `timeZone` (IANA), return epoch ms.
 * Duplicate wall times during DST fallback return the earlier UTC instant.
 */
export function wallDateTimeInZoneToUtcMs(wall: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall.trim());
  if (!m) {
    throw new Error("expected YYYY-MM-DDTHH:mm");
  }
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (![y, mon, d, hh, mm].every((n) => Number.isFinite(n))) {
    throw new Error("invalid numeric components");
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const lo = Date.UTC(y, mon - 1, d - 1, 0, 0, 0, 0);
  const hi = Date.UTC(y, mon - 1, d + 2, 0, 0, 0, 0);
  const matches: number[] = [];
  for (let t = lo; t <= hi; t += 60 * 1000) {
    const parts = formatter.formatToParts(new Date(t));
    const o: Record<string, string> = {};
    for (const p of parts) {
      if (p.type !== "literal") {
        o[p.type] = p.value;
      }
    }
    const py = Number(o.year);
    const pm = Number(o.month);
    const pd = Number(o.day);
    const ph = Number(o.hour);
    const pmi = Number(o.minute);
    if (py === y && pm === mon && pd === d && ph === hh && pmi === mm) {
      matches.push(t);
    }
  }
  if (matches.length === 0) {
    throw new Error("that local time does not exist in this zone (DST gap)");
  }
  return matches[0];
}

/** `datetime-local` value string for instant `ms` shown as wall time in `timeZone`. */
export function utcMsToWallDatetimeLocalValue(ms: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(ms));
  const o: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      o[p.type] = p.value;
    }
  }
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
}

export function formatInstantInAppZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(ms));
}
