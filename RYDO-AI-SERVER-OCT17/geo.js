/*
 * RYDO TRAVEL - tiny geography helpers shared by companion.js and sponsor.js (no imports, nothing else lives here).
 */

/** A coordinate inside [min, max], rounded to ~11 m, or null. We never need more precision and we do not keep exact positions around. */
export function cleanCoord(v, min, max) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 10000) / 10000;
}

const toRad = (d) => (d * Math.PI) / 180;

/** Straight-line distance in metres between two { lat, lng } points. */
export function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Google Maps directions link, built by US from the coordinates. The AI never writes links. */
export const mapLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
