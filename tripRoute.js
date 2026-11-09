/*
 * RYDO AI TRIP BUILDER - the request handler for POST /v1/ai/trip.
 *
 * It is a factory: travelModule.js gives it the Travel OpenRouter client, the login check and the Travel model list. Nothing here touches the Rent AI, chat, translate or health routes.
 * Everything is injected, so the whole flow can be tested without Express, OpenRouter or PocketBase.
 */
import {
  TRIP_LIMITS,
  TripError,
  buildModelSequence,
  buildTripMessages,
  matchCars,
  parseModelJson,
  parseTripRequest,
  validateTripResponse,
} from './trip.js';

/* ------------------------------------------------------------------ switch and client */

/**
 * The Travel trip endpoint exists ONLY when TRAVEL_AI_ENABLED is true/1/yes/on. Anything else (or nothing) = off.
 * Forgiving about how the value was typed in a dashboard: quotes, spaces, invisible characters and a pasted
 * "TRAVEL_AI_ENABLED=true" are all read as true. A wrong word (e.g. "enabled", "tru") is still off.
 */
export function isTripEnabled(env = {}) {
  const cleaned = String(env.TRAVEL_AI_ENABLED ?? '').toLowerCase().replace(/[^a-z0-9=]/g, '');
  const value = cleaned.includes('=') ? cleaned.split('=').pop() : cleaned;
  return ['true', '1', 'yes', 'on'].includes(value);
}

export const cleanKey = (v) => String(v || '').replace(/^\s*OPENROUTER_TRIP_API_KEY\s*=\s*/i, '').replace(/["'\s]/g, '');

/* ------------------------------------------------------------------ persistent usage (optional)
 * One row per AI request in the PocketBase collection `travel_ai_usage` (created by pb-travel-trips.mjs).
 * Rows can be created but never changed or deleted by the person (only an admin can), so the count survives Render
 * restarts and cannot be reset by the user. If PocketBase cannot be reached the handler falls back to the in-memory limiter.
 */
export function createUsageStore({ collection = 'travel_ai_usage', kind = 'trip', now = () => Date.now() } = {}) {
  const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ');
  const esc = (s) => String(s).replace(/["\\]/g, '');
  const count = async (pb, userId, sinceMs) => {
    const filter = `user = "${esc(userId)}" && kind = "${esc(kind)}" && created >= "${stamp(sinceMs)}"`;
    const page = await pb.collection(collection).getList(1, 1, { filter, fields: 'id' });
    return Number(page?.totalItems) || 0;
  };
  return {
    collection,
    /** Returns {ok:true} or {ok:false, reason:'minute'|'day', retryAfter}. Throws if the store cannot be read. */
    async check(pb, userId, limits = TRIP_LIMITS) {
      const t = now();
      if ((await count(pb, userId, t - 60000)) >= limits.perMinute) return { ok: false, reason: 'minute', retryAfter: 60 };
      if ((await count(pb, userId, t - 86400000)) >= limits.perDay) return { ok: false, reason: 'day', retryAfter: 3600 };
      return { ok: true };
    },
    async record(pb, userId) {
      await pb.collection(collection).create({ user: userId, kind });
    },
  };
}

/* ------------------------------------------------------------------ real Rent cars */

/**
 * Loads cars (read-only), newest first, up to 3 pages of 200. It first asks PocketBase for active cars only; if a field used
 * in the query does not exist on this instance it retries with a simpler query. The eligibility check in trip.js removes
 * inactive cars anyway, so the simpler query is still safe.
 */
export async function loadRentCars(pb) {
  const attempts = [{ filter: 'active != false', sort: '-created' }, { sort: '-created' }, {}];
  const out = [];
  let chosen = null;
  for (let page = 1; page <= 3; page++) {
    let list = null;
    if (chosen) {
      list = await pb.collection('cars').getList(page, 200, chosen);
    } else {
      let lastError;
      for (const options of attempts) {
        try {
          list = await pb.collection('cars').getList(page, 200, options);
          chosen = options;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!chosen) throw lastError;
    }
    out.push(...(list.items || []));
    if (!list.items || list.items.length < 200 || page >= (Number(list.totalPages) || 1)) break;
  }
  return out;
}

const endDate = (start, days) => {
  const d = new Date(`${start}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) || Number.isNaN(d.getTime()) || !(days >= 1)) return '';
  d.setUTCDate(d.getUTCDate() + days - 1);
  return d.toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ the handler */

export function createTripHandler({
  openrouter,
  openrouterKey,
  pbUrl,
  getAuthenticatedUser,
  extractContent,
  models, // { primary, extra: [], free: [] }
  limiter, // in-memory limiter from createTripLimiter()
  usageStore = null, // optional persistent store from createUsageStore()
  maxAttempts = 3,
  attemptTimeoutMs = 40000,
  totalTimeoutMs = 80000,
  now = () => Date.now(),
  logger = console,
}) {
  return async function tripHandler(req, res) {
    try {
      if (!openrouterKey) return res.status(503).json({ error: 'RYDO AI server has no OPENROUTER_API_KEY configured.' });
      if (!pbUrl) return res.status(503).json({ error: 'RYDO AI server has no POCKETBASE_URL configured.' });

      let pb;
      let user;
      try {
        ({ pb, user } = await getAuthenticatedUser(req));
      } catch {
        return res.status(401).json({ error: 'Your RYDO session has expired. Please log in again.' });
      }
      const userId = String(user?.id || '');
      if (!userId) return res.status(401).json({ error: 'Your RYDO session has expired. Please log in again.' });

      // Invalid requests are rejected first and do not use up the person's daily plans.
      let input;
      try {
        input = parseTripRequest(req.body);
      } catch (e) {
        if (e instanceof TripError) return res.status(e.status).json({ error: e.message });
        throw e;
      }

      const deny = (reason, retryAfter) => {
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: reason === 'day' ? 'You reached the daily limit for trip plans. Please try again tomorrow.' : 'Too many requests. Please wait a minute and try again.',
          retryAfter,
        });
      };
      const quick = limiter.check(userId);
      if (!quick.ok) return deny(quick.reason, quick.retryAfter);
      if (usageStore) {
        try {
          const saved = await usageStore.check(pb, userId);
          if (!saved.ok) return deny(saved.reason, saved.retryAfter);
          await usageStore.record(pb, userId);
        } catch (e) {
          logger.warn('RYDO AI trip: persistent usage limit unavailable, using the in-memory limit only:', e?.message || e);
        }
      }

      const today = new Date(now()).toISOString().slice(0, 10);
      const messages = buildTripMessages({ ...input, today });
      const sequence = buildModelSequence({ ...models, max: maxAttempts });

      const started = now();
      let result = null;
      const issues = [];
      for (const candidate of sequence) {
        if (result) break;
        if (issues.length && now() - started > totalTimeoutMs - 10000) {
          issues.push('stopped: time budget used');
          break;
        }
        try {
          const completion = await openrouter.chat.completions.create(
            { model: candidate, messages, temperature: 0.4, max_tokens: 3800 },
            { timeout: attemptTimeoutMs, maxRetries: 0 },
          );
          const content = extractContent(completion);
          if (!String(content || '').trim()) throw new TripError('The AI answer was empty.', 502, 'empty');
          const parsed = parseModelJson(content);
          result = validateTripResponse(parsed, { today, userBudget: input.prefs.budget, userCurrency: input.prefs.currency });
          result.model = candidate;
        } catch (e) {
          issues.push(`${candidate}: ${e?.status || ''} ${String(e?.message || e).slice(0, 160)}`);
        }
      }

      if (!result) {
        logger.error('RYDO AI trip failed:', issues.join(' | '));
        return res.status(502).json({ error: 'The AI could not build a valid plan right now. Please try again.' });
      }

      if (result.type === 'plan') {
        let cars = [];
        if (result.plan.needsCar) {
          try {
            const dayCount = result.plan.days.length;
            const from = result.plan.startDate || '';
            const records = await loadRentCars(pb);
            cars = matchCars(records, result.plan.carPickupCity || input.prefs.departureCity, 3, { from, to: endDate(from, dayCount), today });
          } catch (e) {
            logger.warn('RYDO AI trip: could not load Rent cars:', e?.message || e);
          }
        }
        result.cars = cars;
      }

      logger.log(`RYDO AI trip: user=${userId} mode=${input.mode} type=${result.type} model=${result.model}`);
      return res.json(result);
    } catch (error) {
      logger.error('RYDO AI trip error:', error?.message || error);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}
