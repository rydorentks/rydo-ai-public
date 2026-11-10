/*
 * RYDO TRAVEL COMPANION - request handlers for POST /v1/ai/companion and POST /v1/ai/suggest.
 * Same shape as tripRoute.js: a factory, everything injected (OpenRouter client, login check, live-data fetcher, usage store),
 * so the whole flow is tested without Express, OpenRouter, PocketBase or the internet.
 * Nothing here touches Rent AI, chat or translate.
 */
import { TripError, buildModelSequence, createTripLimiter, parseModelJson } from './trip.js';
import {
  COMPANION_LIMITS,
  buildCompanionMessages,
  buildSuggestMessages,
  fallbackSuggestions,
  gatherLiveFacts,
  parseCompanionRequest,
  parseSuggestRequest,
  prepareExperiences,
  validateCompanionResponse,
  validateSuggestResponse,
} from './companion.js';
import { preparePartners, statsMap } from './sponsor.js';

export const companionLimiter = () => createTripLimiter({ perMinute: COMPANION_LIMITS.perMinute, perDay: COMPANION_LIMITS.perDay });
export const suggestLimiter = () => createTripLimiter({ perMinute: COMPANION_LIMITS.suggestPerMinute, perDay: COMPANION_LIMITS.suggestPerDay });

/** Tries the models in order until one answer passes `build` (parse + validate). Returns { result, issues }. */
async function askModels({ openrouter, sequence, messages, extractContent, build, attemptTimeoutMs, totalTimeoutMs, now, maxTokens = 1400 }) {
  const started = now();
  const issues = [];
  for (const candidate of sequence) {
    if (issues.length && now() - started > totalTimeoutMs - 10000) {
      issues.push('stopped: time budget used');
      break;
    }
    try {
      const completion = await openrouter.chat.completions.create(
        { model: candidate, messages, temperature: 0.4, max_tokens: maxTokens },
        { timeout: attemptTimeoutMs, maxRetries: 0 },
      );
      const content = extractContent(completion);
      if (!String(content || '').trim()) throw new TripError('The AI answer was empty.', 502, 'empty');
      const result = build(parseModelJson(content));
      result.model = candidate;
      return { result, issues };
    } catch (e) {
      issues.push(`${candidate}: ${e?.status || ''} ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  return { result: null, issues };
}

/** Approved businesses + the admin's stats, read with the traveller's own session (PocketBase rules decide what is visible). Never throws. */
async function readSponsorData(pb, { geoOnly = false, logger }) {
  let records = [];
  let ok = true;
  try {
    const page = await pb.collection('travel_experiences').getList(1, 200, { filter: geoOnly ? 'status = "approved" && lat != 0' : 'status = "approved"', sort: '-created' });
    records = page?.items || [];
  } catch (e) {
    ok = false;
    logger.warn('RYDO AI: could not read experiences:', e?.message || e);
  }
  let stats = new Map();
  try {
    const page = await pb.collection('travel_experience_stats').getList(1, 500);
    stats = statsMap(page?.items || []);
  } catch (e) {
    // Stats are optional: without them nobody is "sponsored" and nobody has stars. The list still works.
    logger.warn('RYDO AI: stats not available (no sponsors, no stars shown):', e?.message || e);
  }
  return { records, stats, ok };
}

/** Shared start of both handlers: login, request parsing, limits. Returns { pb, userId, input } or sends the error and returns null. */
async function begin({ req, res, parse, limiter, usageStore, usageLimits, getAuthenticatedUser, logger, openrouterKey, pbUrl, what }) {
  if (!openrouterKey) { res.status(503).json({ error: 'RYDO AI server has no Travel AI key configured.' }); return null; }
  if (!pbUrl) { res.status(503).json({ error: 'RYDO AI server has no POCKETBASE_URL configured.' }); return null; }
  let pb;
  let user;
  try {
    ({ pb, user } = await getAuthenticatedUser(req));
  } catch {
    res.status(401).json({ error: 'Your RYDO session has expired. Please log in again.' });
    return null;
  }
  const userId = String(user?.id || '');
  if (!userId) { res.status(401).json({ error: 'Your RYDO session has expired. Please log in again.' }); return null; }

  let input;
  try {
    input = parse(req.body);
  } catch (e) {
    if (e instanceof TripError) { res.status(e.status).json({ error: e.message }); return null; }
    throw e;
  }

  const deny = (reason, retryAfter) => {
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({
      error: reason === 'day' ? `You reached the daily limit for ${what}. Please try again tomorrow.` : 'Too many requests. Please wait a minute and try again.',
      retryAfter,
    });
    return null;
  };
  const quick = limiter.check(userId);
  if (!quick.ok) return deny(quick.reason, quick.retryAfter);
  if (usageStore) {
    try {
      const saved = await usageStore.check(pb, userId, usageLimits);
      if (!saved.ok) return deny(saved.reason, saved.retryAfter);
      await usageStore.record(pb, userId);
    } catch (e) {
      logger.warn(`RYDO AI ${what}: persistent usage limit unavailable, using the in-memory limit only:`, e?.message || e);
    }
  }
  return { pb, userId, input };
}

/* ------------------------------------------------------------------ Travel Companion */

export function createCompanionHandler({
  openrouter, openrouterKey, pbUrl, getAuthenticatedUser, extractContent, models, limiter, usageStore = null, fetchJson,
  maxAttempts = 3, attemptTimeoutMs = 30000, totalTimeoutMs = 60000, now = () => Date.now(), logger = console,
}) {
  return async function companionHandler(req, res) {
    try {
      const start = await begin({ req, res, parse: parseCompanionRequest, limiter, usageStore, usageLimits: { perMinute: COMPANION_LIMITS.perMinute, perDay: COMPANION_LIMITS.perDay }, getAuthenticatedUser, logger, openrouterKey, pbUrl, what: 'Travel Companion questions' });
      if (!start) return undefined;
      const { pb, userId, input } = start;

      // Live data first. It never throws: a missing source becomes a limitation that the server adds to the answer.
      const facts = await gatherLiveFacts({ location: input.location, trip: input.trip }, fetchJson);
      const today = new Date(now()).toISOString().slice(0, 10);
      const messages = buildCompanionMessages({ message: input.message, history: input.history, language: input.language, trip: input.trip, facts, today });
      const sequence = buildModelSequence({ ...models, max: maxAttempts });

      // Partner businesses near the same reference point, read while the AI thinks. Listed by the server, never chosen or described by the AI.
      const partnersJob = facts.center ? readSponsorData(pb, { geoOnly: true, logger }) : Promise.resolve(null);

      const { result, issues } = await askModels({
        openrouter, sequence, messages, extractContent, attemptTimeoutMs, totalTimeoutMs, now,
        build: (parsed) => validateCompanionResponse(parsed, { facts, trip: input.trip }),
      });
      if (!result) {
        logger.error('RYDO AI companion failed:', issues.join(' | '));
        return res.status(502).json({ error: 'Your Travel Companion could not answer right now. Please try again.' });
      }
      const sponsorData = await partnersJob;
      result.partners = sponsorData ? preparePartners(sponsorData.records, sponsorData.stats, facts.center, { today, pbUrl }) : [];
      result.partnersNote = result.partners.some((p) => p.sponsored)
        ? 'Businesses marked "Sponsored" paid RYDO to be shown first. Stars come from travellers who opened the business through RYDO.'
        : '';
      if (sponsorData && !sponsorData.ok) result.limitations = [...result.limitations, 'Partner businesses are not available right now.'].slice(0, 6);
      // Not logged: the question text, the position. Only who, what kind and which model.
      logger.log(`RYDO AI companion: user=${userId} location=${facts.centerSource} places=${facts.places.length} partners=${result.partners.length} model=${result.model}`);
      return res.json(result);
    } catch (error) {
      logger.error('RYDO AI companion error:', error?.message || error);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

/* ------------------------------------------------------------------ AI experience suggestions */

export function createSuggestHandler({
  openrouter, openrouterKey, pbUrl, getAuthenticatedUser, extractContent, models, limiter, usageStore = null,
  maxAttempts = 3, attemptTimeoutMs = 30000, totalTimeoutMs = 60000, now = () => Date.now(), logger = console,
}) {
  return async function suggestHandler(req, res) {
    try {
      const start = await begin({ req, res, parse: parseSuggestRequest, limiter, usageStore, usageLimits: { perMinute: COMPANION_LIMITS.suggestPerMinute, perDay: COMPANION_LIMITS.suggestPerDay }, getAuthenticatedUser, logger, openrouterKey, pbUrl, what: 'AI suggestions' });
      if (!start) return undefined;
      const { pb, userId, input } = start;

      // Real approved offers only. Read with the traveller's own session, so PocketBase's rules decide what is visible.
      const { records, stats, ok } = await readSponsorData(pb, { logger });
      if (!ok) return res.status(503).json({ error: 'Local experiences are not available right now. Please try again later.' });
      const today = new Date(now()).toISOString().slice(0, 10);
      const experiences = prepareExperiences(records, input.city, { stats, today, pbUrl });
      // Nothing to choose from: answer at once, no AI call, no cost.
      if (!experiences.length) return res.json({ type: 'suggestions', picks: [], note: 'There are no approved local experiences yet.', source: 'none' });

      const messages = buildSuggestMessages({ ...input, experiences });
      const sequence = buildModelSequence({ ...models, max: maxAttempts });
      const { result, issues } = await askModels({
        openrouter, sequence, messages, extractContent, attemptTimeoutMs, totalTimeoutMs, now, maxTokens: 900,
        build: (parsed) => validateSuggestResponse(parsed, experiences),
      });
      if (!result) {
        logger.warn('RYDO AI suggest: AI failed, sending the plain list:', issues.join(' | '));
        return res.json(fallbackSuggestions(experiences, input));
      }
      // The AI picked nothing valid although there are offers in the city: still show the city list (clearly marked) instead of an empty screen.
      if (!result.picks.length && experiences.some((e) => e.cityMatch)) {
        return res.json({ ...fallbackSuggestions(experiences, input), note: result.note || 'No offer matched your interests closely, so here are the offers in this city.' });
      }
      logger.log(`RYDO AI suggest: user=${userId} offers=${experiences.length} picks=${result.picks.length} model=${result.model}`);
      return res.json(result);
    } catch (error) {
      logger.error('RYDO AI suggest error:', error?.message || error);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}
