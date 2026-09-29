import { useEffect, useState } from "react";

import { formatAbsoluteTime, formatRelativeTime } from "../labels.js";

const REFRESH_INTERVAL_MS = 30_000;

/** Log-style timestamp: absolute time is primary, the relative age is a hover hint. */
export function AbsoluteTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={formatRelativeTime(value)}>
      {formatAbsoluteTime(value)}
    </time>
  );
}

export function RelativeTime({ value }: { value: string | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  if (value === null) return <span>—</span>;
  const absolute = formatAbsoluteTime(value);
  return <time dateTime={value} title={absolute}>{formatRelativeTime(value, now)}</time>;
}
