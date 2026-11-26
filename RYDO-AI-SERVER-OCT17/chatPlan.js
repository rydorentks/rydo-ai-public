/*
 * RYDO-AI-PLUS: daily question allowance for the RYDO AI chat.
 *  - free: 5 questions a day, counted from midnight Kosovo time (they come back the next day)
 *  - plus: users.aiPlusUntil is in the future -> up to 100 a day (a safety cap, not a price)
 *  - admin: no limit
 * The count lives in the same usage table as the Travel AI (kind "chat"), so the numbers survive restarts.
 * If the table cannot be read or written, the chat still answers (we never block a person because of our own error).
 */

export const CHAT_LIMITS = Object.freeze({ free: 5, plus: 100 });
export const CHAT_DAY_TIME_ZONE = 'Europe/Belgrade'; // same clock as Kosovo

/** Milliseconds of the last local midnight (in `timeZone`) at or before `nowMs`. Handles summer/winter time. */
export function startOfLocalDay(nowMs, timeZone = CHAT_DAY_TIME_ZONE) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const offsetAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    return { asUtc, y: Number(p.year), m: Number(p.month), d: Number(p.day), offset: asUtc - Math.floor(ms / 1000) * 1000 };
  };
  const here = offsetAt(nowMs);
  const midnightUtcGuess = Date.UTC(here.y, here.m - 1, here.d) - here.offset;
  // The offset at midnight can differ from the offset now (the night the clocks change): correct once.
  const atMidnight = offsetAt(midnightUtcGuess);
  return Date.UTC(here.y, here.m - 1, here.d) - atMidnight.offset;
}

/** Next local midnight after `nowMs`. */
export function nextLocalMidnight(nowMs, timeZone = CHAT_DAY_TIME_ZONE) {
  return startOfLocalDay(startOfLocalDay(nowMs, timeZone) + 36 * 3600000, timeZone);
}

const parseDate = (v) => {
  const ms = Date.parse(String(v || '').trim().replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : 0;
};

/** 'admin' | 'plus' | 'free' */
export function chatPlanOf(user, role, nowMs) {
  if (String(role || '').toLowerCase() === 'admin' || String(user?.role || '').toLowerCase() === 'admin') return 'admin';
  return parseDate(user?.aiPlusUntil) > nowMs ? 'plus' : 'free';
}

export function createChatQuota({ collection = 'travel_ai_usage', kind = 'chat', now = () => Date.now(), logger = console } = {}) {
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ');
  const esc = (s) => String(s).replace(/["\\]/g, '');
  return {
    collection,
    /** { ok, plan, usage: { plan, used, limit, resetAt } } */
    async check(pb, user, role) {
      const t = now();
      const plan = chatPlanOf(user, role, t);
      if (plan === 'admin') return { ok: true, plan, usage: { plan, used: null, limit: null, resetAt: null } };
      const limit = CHAT_LIMITS[plan];
      const resetAt = new Date(nextLocalMidnight(t)).toISOString();
      let used = null;
      try {
        const filter = `user = "${esc(user.id)}" && kind = "${esc(kind)}" && created >= "${stamp(startOfLocalDay(t))}"`;
        const page = await pb.collection(collection).getList(1, 1, { filter, fields: 'id' });
        used = Number(page?.totalItems) || 0;
      } catch (e) {
        logger.warn?.(`RYDO AI chat quota could not be read (${String(e?.message || e).slice(0, 80)}); answering anyway.`);
        return { ok: true, plan, usage: { plan, used: null, limit, resetAt } };
      }
      const usage = { plan, used, limit, resetAt };
      if (used >= limit) return { ok: false, plan, usage };
      return { ok: true, plan, usage };
    },
    /** Counts one answered question; returns the usage to send back to the app. Never throws. */
    async record(pb, user, quota) {
      const usage = quota?.usage || null;
      if (!quota || quota.plan === 'admin') return usage;
      try {
        await pb.collection(collection).create({ user: user.id, kind });
      } catch (e) {
        logger.warn?.(`RYDO AI chat quota could not be saved (${String(e?.message || e).slice(0, 80)}).`);
        return usage;
      }
      return usage && usage.used !== null ? { ...usage, used: usage.used + 1 } : usage;
    },
  };
}
