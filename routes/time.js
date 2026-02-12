import express from "express";

export const router = express.Router();

function safeTimeZone(tz) {
  try {
    // Validate IANA TZ string
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return null;
  }
}

function formatNow(d, timeZone) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(d);
}

function formatYmd(d, timeZone) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

router.post("/now", (req, res) => {
  const callId = req.body?.callId; 
  const requestedTz = req.body?.timeZone;
  
  // FIX: Removed activeCalls lookup. 
  // If you need call-specific timezone later, you'll need to implement a store in pbxware.js
  const callTz = null; 

  const tz =
    safeTimeZone(requestedTz) ||
    safeTimeZone(callTz) ||
    safeTimeZone(process.env.DEFAULT_TIME_ZONE) ||
    "UTC";

  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const t = new Date(now);
  t.setDate(now.getDate() + 1);

  res.json({
    timeZone: tz,
    nowIso: now.toISOString(),
    nowText: formatNow(now, tz),
    today: formatYmd(now, tz),
    yesterday: formatYmd(y, tz),
    tomorrow: formatYmd(t, tz),
  });
});
