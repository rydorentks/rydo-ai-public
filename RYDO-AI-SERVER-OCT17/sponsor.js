/*
 * RYDO TRAVEL - sponsored local businesses: who is sponsored today, how businesses are ranked, and the "partners near you" list.
 * Pure logic. No Express, no AI, no PocketBase here (the route reads the rows and passes them in), so it is all testable offline.
 *
 * Honest by design:
 *   - "Sponsored" comes ONLY from a row the admin wrote (travel_experience_stats.sponsoredUntil, after the business paid outside the app).
 *     The AI never decides who is sponsored and never writes a word about it.
 *   - Stars and "people who opened it" come only from stats rows computed from real ratings (given by people who opened the business
 *     through RYDO) and real taps on the business link. A tap is not a booking and is never described as one.
 *   - Everything shown about a business (title, price, address, photo, link) comes from its database record, never from the AI.
 */
import { cleanNumber, cleanText } from './trip.js';
import { cleanCoord, distanceMeters, mapLink } from './geo.js';

export const SPONSOR_LIMITS = Object.freeze({
  nearbyMeters: 8000,
  maxPartners: 3,
  // A business with few ratings should not beat a well-rated one: this is the weight of an "average" opinion (3.5 stars, 3 votes).
  priorStars: 3.5,
  priorVotes: 3,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v) => {
  const s = String(v || '').slice(0, 10);
  return DAY.test(s) ? s : '';
};

/** PocketBase stats rows -> Map(experienceId -> clean stats). A row with a bad or missing experience id is ignored. */
export function statsMap(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!isObj(r)) continue;
    const id = cleanText(r.experience, 40);
    if (!id) continue;
    map.set(id, {
      sponsoredFrom: day(r.sponsoredFrom),
      sponsoredUntil: day(r.sponsoredUntil),
      referrals: Math.round(cleanNumber(r.referrals, 0, 10000000, 0)),
      ratingCount: Math.round(cleanNumber(r.ratingCount, 0, 10000000, 0)),
      ratingAvg: Math.round(cleanNumber(r.ratingAvg, 0, 5, 0) * 10) / 10,
    });
  }
  return map;
}

/** Sponsored today = the admin set an end date that has not passed, and a start date (if any) that has arrived. `today` is YYYY-MM-DD. */
export function isSponsorActive(stat, today) {
  if (!stat || !day(stat.sponsoredUntil) || !day(today)) return false;
  if (stat.sponsoredUntil < today) return false;
  return !stat.sponsoredFrom || stat.sponsoredFrom <= today;
}

/** A fair score: stars pulled towards an average opinion when there are few votes. 0 votes = neutral, never a fake "5.0". */
export function ratingScore(avg, count) {
  const a = cleanNumber(avg, 0, 5, 0);
  const c = Math.max(0, Math.round(cleanNumber(count, 0, 10000000, 0)));
  return (a * c + SPONSOR_LIMITS.priorStars * SPONSOR_LIMITS.priorVotes) / (c + SPONSOR_LIMITS.priorVotes);
}

/** Order: sponsored first, then better rating, then more people who opened it, then nearer, then A-Z. Works on {sponsored, score, referrals, distanceM?, title}. */
export function compareRanked(a, b) {
  return (
    Number(!!b.sponsored) - Number(!!a.sponsored)
    || (b.score || 0) - (a.score || 0)
    || (b.referrals || 0) - (a.referrals || 0)
    || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)
    || String(a.title || '').localeCompare(String(b.title || ''))
  );
}

const FILE = /^[\w.\- ]{1,150}$/;
const RECORD_ID = /^[A-Za-z0-9]{1,40}$/;
const filesOf = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((f) => FILE.test(f));

/** Public address of the first photo of a business (a normal PocketBase file link), or ''. Files of this field are public by design. */
export function photoUrl(record, pbUrl) {
  const base = String(pbUrl || '').replace(/\/+$/, '');
  const id = String(record?.id || '');
  const file = filesOf(record?.photos)[0];
  if (!base || !RECORD_ID.test(id) || !file) return '';
  return `${base}/api/files/travel_experiences/${id}/${encodeURIComponent(file)}`;
}

/** The sponsor/rating facts of one business, from its record and its stats row. */
export function experienceInfo(record, stat, { today, pbUrl } = {}) {
  const s = stat || { referrals: 0, ratingCount: 0, ratingAvg: 0 };
  return {
    sponsored: isSponsorActive(stat, today),
    ratingAvg: s.ratingCount > 0 ? s.ratingAvg : 0,
    ratingCount: s.ratingCount,
    referrals: s.referrals,
    score: ratingScore(s.ratingCount > 0 ? s.ratingAvg : 0, s.ratingCount),
    photoUrl: photoUrl(record, pbUrl),
    hasVideo: filesOf(record?.videos).length > 0,
  };
}

const httpsOnly = (v) => (/^https:\/\/[^\s<>"']+$/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 300) : '');

/**
 * Approved businesses that have a position, near a point, ranked: sponsored first, then stars, then people who opened it, then distance.
 * `center` = { lat, lng } or null (no point = no list). Returns at most `max`, each with a map link built here.
 */
export function preparePartners(records, stats, center, { today, pbUrl, maxMeters = SPONSOR_LIMITS.nearbyMeters, max = SPONSOR_LIMITS.maxPartners } = {}) {
  if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return [];
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObj(r) || String(r.status) !== 'approved') continue;
    const title = cleanText(r.title, 100);
    const lat = cleanCoord(r.lat, -90, 90);
    const lng = cleanCoord(r.lng, -180, 180);
    // 0,0 is "not set" (an empty number field reads as 0), not a business in the Atlantic Ocean.
    if (!title || lat === null || lng === null || (lat === 0 && lng === 0)) continue;
    const distanceM = distanceMeters(center, { lat, lng });
    if (distanceM > maxMeters) continue;
    const id = cleanText(r.id, 40);
    const info = experienceInfo(r, stats instanceof Map ? stats.get(id) : undefined, { today, pbUrl });
    out.push({
      id,
      title,
      category: cleanText(r.category, 20),
      city: cleanText(r.city, 60),
      partnerName: cleanText(r.partnerName, 80),
      address: cleanText(r.address, 160),
      hours: cleanText(r.hours, 160),
      priceFrom: cleanNumber(r.priceFrom, 0, 1000000, 0),
      currency: cleanText(r.currency, 3).toUpperCase() || 'EUR',
      bookingUrl: httpsOnly(r.bookingUrl),
      contact: cleanText(r.contact, 120),
      distanceM,
      mapUrl: mapLink(lat, lng),
      ...info,
    });
  }
  out.sort(compareRanked);
  return out.slice(0, Math.max(0, max));
}
