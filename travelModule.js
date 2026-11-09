/*
 * RYDO TRAVEL AI - an independent module. server.js only calls mountTravelAI(...) once.
 *
 * Separate from Rent AI on purpose:
 *   - its OWN OpenRouter API key       (OPENROUTER_TRIP_API_KEY)     - Rent's OPENROUTER_API_KEY is never used here
 *   - its OWN model and fallbacks      (OPENROUTER_TRIP_MODEL, OPENROUTER_TRIP_FALLBACK_MODELS) - Rent's model lists are never used here
 *   - its OWN endpoints                (POST /v1/ai/trip, GET /v1/ai/trip/health)
 *   - its OWN on/off switch            (TRAVEL_AI_ENABLED, off by default: nothing is mounted)
 *   - its OWN persistent usage limit   (TRIP_USAGE_COLLECTION, default travel_ai_usage; "off" = memory limit only)
 * What it shares with Rent is only the login check (getAuthenticatedUser: "who is this person"), which is not configuration.
 *
 * A wrong Travel configuration can never stop the server or Rent: the Travel route just answers 503 and the health route says why.
 */
import { createTripLimiter, splitModels } from './trip.js';
import { cleanKey, createTripHandler, createUsageStore, isTripEnabled } from './tripRoute.js';

/** Reads the Travel settings from the environment. Never throws. `problems` lists what is missing. */
export function readTravelConfig(env = {}) {
  const key = cleanKey(env.OPENROUTER_TRIP_API_KEY);
  const model = String(env.OPENROUTER_TRIP_MODEL || '').trim();
  const usageRaw = String(env.TRIP_USAGE_COLLECTION === undefined ? 'travel_ai_usage' : env.TRIP_USAGE_COLLECTION).trim();
  const problems = [];
  if (!key) problems.push('OPENROUTER_TRIP_API_KEY is missing (Travel AI does not use the Rent AI key)');
  if (!model) problems.push('OPENROUTER_TRIP_MODEL is missing (Travel AI does not use the Rent AI model)');
  return {
    enabled: isTripEnabled(env),
    key,
    model,
    fallbacks: splitModels(env.OPENROUTER_TRIP_FALLBACK_MODELS),
    usageCollection: !usageRaw || usageRaw.toLowerCase() === 'off' ? '' : usageRaw,
    problems,
  };
}

/**
 * Adds the Travel routes to `app`. Does nothing at all when TRAVEL_AI_ENABLED is not true.
 * Returns { mounted, configured, problems } (used by tests and the startup log).
 */
export function mountTravelAI({ app, OpenAI, env = process.env, pbUrl, getAuthenticatedUser, extractContent, logger = console, makeClient }) {
  const config = readTravelConfig(env);
  if (!config.enabled) {
    const raw = env.TRAVEL_AI_ENABLED;
    logger.log(`RYDO Travel AI: OFF. TRAVEL_AI_ENABLED is ${raw === undefined ? 'not set' : `${JSON.stringify(String(raw))} (length ${String(raw).length})`}; it must be true to turn Travel on. Rent AI is not affected.`);
    return { mounted: false, configured: false, problems: [] };
  }

  const configured = config.problems.length === 0 && Boolean(pbUrl);
  const problems = [...config.problems, ...(pbUrl ? [] : ['POCKETBASE_URL is missing'])];

  if (!configured) {
    logger.warn(`RYDO Travel AI is ON but NOT configured: ${problems.join('; ')}. Rent AI is not affected.`);
    app.post('/v1/ai/trip', (_req, res) => res.status(503).json({ error: 'RYDO Travel AI is not configured yet.' }));
  } else {
    const client = (makeClient || ((key) => new OpenAI({ apiKey: key, baseURL: 'https://openrouter.ai/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://rydo-rent.expo.app', 'X-Title': 'RYDO Travel AI' } })))(config.key);
    app.post(
      '/v1/ai/trip',
      createTripHandler({
        openrouter: client,
        openrouterKey: config.key,
        pbUrl,
        getAuthenticatedUser,
        extractContent,
        models: { primary: config.model, extra: config.fallbacks, free: [] },
        limiter: createTripLimiter(),
        usageStore: config.usageCollection ? createUsageStore({ collection: config.usageCollection }) : null,
        logger,
      }),
    );
  }

  logger.log(configured
    ? 'RYDO Travel AI: ON (POST /v1/ai/trip, GET /v1/ai/trip/health; own key and model).'
    : 'RYDO Travel AI: ON but not configured (see GET /v1/ai/trip/health).');
  // Configuration status only. No secrets, no model names, no call to OpenRouter (so it costs nothing).
  app.get('/v1/ai/trip/health', (_req, res) =>
    res.status(configured ? 200 : 503).json({
      ok: configured,
      service: 'rydo-travel-ai',
      configured,
      persistentLimit: Boolean(config.usageCollection),
      fallbackModels: config.fallbacks.length,
      ...(configured ? {} : { problems }),
    }),
  );
  return { mounted: true, configured, problems };
}
