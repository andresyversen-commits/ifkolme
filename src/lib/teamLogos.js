/**
 * Klubblogoer: lägg filer i `public/logos/{slug}.svg` (eller .png).
 * Slug beräknas från lagnamn — se `teamSlug`. Du kan också sätta
 * `homeLogo` / `awayLogo` på ett fixture-objekt i data.json (full sökväg från webbroten, t.ex. "/logos/min-klubb.png").
 */

/** Ta bort parentes-suffix m.m. så samma klubb får samma slug. */
export function normalizeClubName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/\s*\(syd\)\s*/gi, " ")
    .replace(/\s*\(vit\)\s*/gi, " ")
    .replace(/\s*\(p11\)\s*/gi, " ")
    .replace(/\s+vit\s*$/i, "")
    .trim();
}

export function teamSlug(name) {
  const n = normalizeClubName(name);
  if (!n) return "";
  return n
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Två bokstäver för placeholder (första bokstäverna i två första orden). */
export function teamInitials(name) {
  const n = normalizeClubName(name);
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0][0] || "";
    const b = parts[1][0] || "";
    return (a + b).toUpperCase();
  }
  return (n.slice(0, 2) || "?").toUpperCase();
}

/**
 * @param {string} name
 * @param {string | null | undefined} explicitUrl från fixture.homeLogo / awayLogo
 * @returns {string | null} URL att prova, eller null → visa bara initialer
 */
export function resolveTeamLogoUrl(name, explicitUrl) {
  if (explicitUrl && typeof explicitUrl === "string" && explicitUrl.trim()) return explicitUrl.trim();
  const slug = teamSlug(name);
  if (!slug) return null;
  if (slug === "ifk-olme") return `/logos/${slug}.png`;
  return `/logos/${slug}.svg`;
}
