import { useEffect, useState } from "react";

import { formatAbsoluteTime, formatRelativeTime } from "../labels.js";

const REFRESH_INTERVAL_MS = 30_000;

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
