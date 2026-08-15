import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import {
  appendP11Bench2014Players,
  birthYearNum,
  isAllowedP11SquadPlayer,
  isEligibleForMatchSquad,
  repairGroups2015IfNeeded,
  repairGroups2016IfNeeded,
  validateGroups2015,
  validateGroups2016,
  buildGroups2015FromPlayers,
  buildGroups2016FromPlayers,
  backfillIntendedGroups2015,
  selectTeamForMatch,
  simulateFullSeason,
  buildRotationView,
  inferIntendedGroup2015,
  inferIntendedGroup2016,
  isPlayerAvailable,
  matchUnavailablePlayerIdSet,
  matchSquadMode,
  matchBranchKey,
  p11Assist2016Count,
  stripLegacyP10SquadsIfNeeded,
  repairP11Squad2014IfNeeded,
  compareMatchesChronologically,
  pruneMatchLineupToSelectedSquad,
  pruneMatchUnavailableToSquad,
  validateMatchSquadForComplete,
  buildSquadWith2015Replacements,
  match2015PlayersNeedingReplacement,
  clearMatchUnavailableFlags,
  repairClearUnavailableOnPlayedMatches,
  clearPlayerAbsenceOnUpcomingMatches,
  applyPlayerMakeAvailable,
  normalizePlayerAvailabilityFlags,
} from "./selection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data.json");
const SEED_PATH = path.join(__dirname, "data.seed.json");
const MATCH_COUNT = 13;
const COACH_NAMES = ["Jonas", "Per", "Anders", "Kim"];
const DATABASE_URL = process.env.DATABASE_URL || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const FILE_FALLBACK_ENABLED = NODE_ENV !== "production";
const DEFAULT_MINFOTBOLL_ICS_URL =
  process.env.MINFOTBOLL_ICS_URL ||
  "https://minfotboll-api.azurewebsites.net/api/ExternalCalendarAPI/GetMemberCalendar/dmJFMkpKuMBlDjjZjRJNMKsxWnquLwbT.ics";

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const BUILD_COMMIT = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '';

function normalizeIcsUrl(rawUrl) {
  const u = String(rawUrl || "").trim();
  if (!u) return DEFAULT_MINFOTBOLL_ICS_URL;
  if (u.startsWith("webcal://")) return `https://${u.slice("webcal://".length)}`;
  return u;
}

function unfoldIcsLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeIcsText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsDateTime(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  if (/^\d{8}$/.test(value)) {
    const y = value.slice(0, 4);
    const m = value.slice(4, 6);
    const d = value.slice(6, 8);
    return { date: `${y}-${m}-${d}`, time: "00:00", sortTs: Number(`${y}${m}${d}0000`) };
  }
  // UTC (…Z): konvertera till Europe/Stockholm så tid stämmer med lokal matchtid.
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const y = value.slice(0, 4);
    const mo = value.slice(4, 6);
    const d = value.slice(6, 8);
    const hh = value.slice(9, 11);
    const mm = value.slice(11, 13);
    const ss = value.slice(13, 15);
    const utc = new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`);
    if (Number.isNaN(utc.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Stockholm",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(utc);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    let hour = get("hour");
    if (hour === "24") hour = "00";
    const time = `${hour}:${get("minute")}`;
    return {
      date,
      time,
      sortTs: Number(`${date.replace(/-/g, "")}${time.replace(":", "")}`),
    };
  }
  const compact = value.endsWith("Z") ? value.slice(0, -1) : value;
  if (!/^\d{8}T\d{6}$/.test(compact)) return null;
  const y = compact.slice(0, 4);
  const m = compact.slice(4, 6);
  const d = compact.slice(6, 8);
  const hh = compact.slice(9, 11);
  const mm = compact.slice(11, 13);
  return {
    date: `${y}-${m}-${d}`,
    time: `${hh}:${mm}`,
    sortTs: Number(`${y}${m}${d}${hh}${mm}`),
  };
}

function inferBranchFromText(text) {
  const t = String(text || "").toLowerCase();
  if (/\bp[\s-]?11\b/.test(t)) return "p11";
  if (/\bp[\s-]?10\b/.test(t)) return "p10";
  return null;
}

function isOlmeTeamName(name) {
  return /ifk\s*ölme|ifk\s*olme/i.test(String(name || ""));
}

function parseTeamsFromSummary(summary) {
  const cleaned = decodeIcsText(summary)
    .replace(/\b(p[\s-]?10|p[\s-]?11)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const separators = [" - ", " – ", " — ", " vs ", " VS ", " v ", " : "];
  for (const sep of separators) {
    if (!cleaned.includes(sep)) continue;
    const [a, b] = cleaned.split(sep).map((s) => s.trim()).filter(Boolean);
    if (a && b) return { home: a, away: b };
  }
  return { home: "", away: "" };
}

/** Jämför lagnamn mjukt (ignorera vit/syd m.m.). Högre = bättre träff. */
function teamNameMatchScore(a, b) {
  const strip = (s) =>
    normalizeTeamKey(s)
      .replace(/-(vit|syd|bla|blaa|gron|groen|svart|rod|roed)(-|$)/g, "$2")
      .replace(/-+$/g, "");
  const na = strip(a);
  const nb = strip(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return 80;
  const ta = new Set(na.split("-").filter((t) => t.length > 2));
  const tb = new Set(nb.split("-").filter((t) => t.length > 2));
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  const ratio = overlap / Math.max(ta.size, tb.size);
  return ratio >= 0.5 ? Math.round(50 + ratio * 40) : 0;
}

function fixtureOpponentName(home, away) {
  if (isOlmeTeamName(home)) return away || "";
  if (isOlmeTeamName(away)) return home || "";
  return "";
}

function parseIcsFixtures(icsText) {
  const lines = unfoldIcsLines(icsText);
  const events = [];
  let current = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.dtstart) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const keyPart = line.slice(0, idx);
    const valuePart = line.slice(idx + 1);
    const key = keyPart.split(";")[0].toUpperCase();
    if (key === "DTSTART") current.dtstart = valuePart;
    else if (key === "SUMMARY") current.summary = decodeIcsText(valuePart);
    else if (key === "LOCATION") current.location = decodeIcsText(valuePart);
    else if (key === "DESCRIPTION") current.description = decodeIcsText(valuePart);
    else if (key === "CATEGORIES") current.categories = decodeIcsText(valuePart);
  }

  const parsed = [];
  for (const ev of events) {
    const dt = parseIcsDateTime(ev.dtstart);
    if (!dt) continue;
    const hintText = [ev.summary, ev.description, ev.categories].filter(Boolean).join(" ");
    const branch = inferBranchFromText(hintText); // kan vara null — MinFotboll utelämnar ofta P10/P11
    const teams = parseTeamsFromSummary(ev.summary || "");
    // Kalendern kan innehålla andra följda lag — behåll bara IFK Ölme-matcher.
    if (!isOlmeTeamName(teams.home) && !isOlmeTeamName(teams.away)) continue;
    parsed.push({
      branch,
      date: dt.date,
      time: dt.time,
      venue: ev.location || "",
      home: teams.home,
      away: teams.away,
      summary: ev.summary || "",
      opponent: fixtureOpponentName(teams.home, teams.away),
      sortTs: dt.sortTs,
    });
  }
  return parsed.sort((a, b) => a.sortTs - b.sortTs);
}

/**
 * Synka ICS → befintliga matcher.
 * Parar på motståndare + datum (inte längre A/B-index per gren), eftersom
 * MinFotboll-ICS ofta saknar P10/P11-etikett och blandar åldersgrupper.
 * Manuella matcher och redan genomförda matcher lämnas orörda.
 */
function syncFixturesFromIcs(state, fixtures) {
  const targets = (state.matches || [])
    .filter((m) => !m.manualSource && m.status !== "played")
    .slice();
  const usedTargetIds = new Set();
  const touched = [];
  let matched = 0;
  let unmatchedIcs = 0;

  for (const f of fixtures) {
    const opp = f.opponent || fixtureOpponentName(f.home, f.away);
    if (!opp) {
      unmatchedIcs += 1;
      continue;
    }
    let best = null;
    let bestScore = 0;
    for (const m of targets) {
      if (usedTargetIds.has(m.id)) continue;
      if (f.branch && matchBranchKey(m) !== f.branch) continue;
      const mHome = m.fixture?.home || "";
      const mAway = m.fixture?.away || "";
      const mOpp = fixtureOpponentName(mHome, mAway) || (!isOlmeTeamName(mHome) ? mHome : mAway);
      const nameScore = teamNameMatchScore(opp, mOpp);
      if (nameScore < 70) continue;
      const mDate = String(m.fixture?.date || "");
      let dateScore = 0;
      if (mDate && mDate === f.date) dateScore = 50;
      else if (mDate && f.date) {
        const md = Date.parse(`${mDate}T12:00:00`);
        const fd = Date.parse(`${f.date}T12:00:00`);
        if (Number.isFinite(md) && Number.isFinite(fd)) {
          const days = Math.abs(md - fd) / 86400000;
          if (days <= 1) dateScore = 35;
          else if (days <= 3) dateScore = 15;
          else continue; // för långt ifrån — hoppa
        }
      } else {
        dateScore = 5; // saknar datum på matchen
      }
      const score = nameScore + dateScore;
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best || bestScore < 105) {
      unmatchedIcs += 1;
      continue;
    }

    usedTargetIds.add(best.id);
    if (!best.fixture || typeof best.fixture !== "object") best.fixture = {};
    const prevAssist = best.fixture.p11Assist2016;
    const prevP10Count = best.fixture.p10Count2016;
    const prevSeries = best.fixture.series;
    const prevAssociation = best.fixture.association;
    best.fixture = {
      ...best.fixture,
      date: f.date,
      time: f.time || best.fixture.time || "00:00",
      venue: f.venue || best.fixture.venue || "",
      home: f.home || best.fixture.home || "",
      away: f.away || best.fixture.away || "",
      series: prevSeries || best.fixture.series || "",
      association: prevAssociation || best.fixture.association || "",
    };
    if (matchBranchKey(best) === "p11" && prevAssist !== undefined) {
      best.fixture.p11Assist2016 = prevAssist;
    }
    if (matchBranchKey(best) === "p10" && prevP10Count !== undefined) {
      best.fixture.p10Count2016 = prevP10Count;
    }
    touched.push(best.id);
    matched += 1;
  }

  state.matches.sort(compareMatchesChronologically);
  const withBranch = {
    p10: fixtures.filter((f) => f.branch === "p10").length,
    p11: fixtures.filter((f) => f.branch === "p11").length,
    unknown: fixtures.filter((f) => !f.branch).length,
  };
  return {
    updatedMatches: touched.length,
    matched,
    unmatchedIcs,
    sourceCounts: withBranch,
    olmeEvents: fixtures.length,
  };
}

function normalizeTeamKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isDefaultCoachSet(list) {
  if (!Array.isArray(list) || list.length !== COACH_NAMES.length) return false;
  for (let i = 0; i < COACH_NAMES.length; i++) {
    if (String(list[i]?.name || list[i] || "").trim() !== COACH_NAMES[i]) return false;
  }
  return true;
}

function normalizedSettingsPayload(state) {
  const coaches =
    Array.isArray(state?.coaches) && state.coaches.length
      ? state.coaches
          .map((c, i) => ({
            id: c?.id ? String(c.id) : `coach-${i + 1}`,
            name: String(c?.name || "").trim(),
            phone: String(c?.phone || "").trim(),
            role: String(c?.role || "").trim(),
            note: String(c?.note || "").trim(),
          }))
          .filter((c) => c.name)
      : defaultCoaches();
  const logos = {};
  const src = state?.teamLogos && typeof state.teamLogos === "object" ? state.teamLogos : {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== "string" || !v.trim()) continue;
    const nk = normalizeTeamKey(k);
    if (!nk) continue;
    logos[nk] = v;
  }
  return { coaches, teamLogos: logos, updatedAt: new Date().toISOString() };
}

const settingsPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
let remoteSettingsCache = null;
let remoteSettingsReady = false;
let remoteStateCache = null;
let remoteStateReady = false;

function isPlaceholderPlayerName(name) {
  return /^Spelare 201[56]–\d+$/.test(String(name || "").trim());
}

function shouldRestoreFromRemoteState(state) {
  if (!remoteStateReady || !remoteStateCache) return false;
  const localPlayers = Array.isArray(state.players) ? state.players : [];
  const localMatches = Array.isArray(state.matches) ? state.matches : [];
  const localLogos = state.teamLogos && typeof state.teamLogos === "object" ? state.teamLogos : {};
  const localCoaches = Array.isArray(state.coaches) ? state.coaches : [];
  if (localPlayers.length === 0 || localMatches.length === 0) return true;
  const allPlaceholder = localPlayers.length > 0 && localPlayers.every((p) => isPlaceholderPlayerName(p?.name));
  const noLogos = Object.keys(localLogos).length === 0;
  const defaultCoaches = localCoaches.length === 0 || isDefaultCoachSet(localCoaches);
  return allPlaceholder && noLogos && defaultCoaches;
}

async function ensureSettingsTable() {
  if (!settingsPool) throw new Error("DATABASE_URL mangler");
  await settingsPool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadRemoteSettings() {
  if (!settingsPool) throw new Error("DATABASE_URL mangler");
  await ensureSettingsTable();
  const r = await settingsPool.query("SELECT payload FROM app_settings WHERE id = 'main' LIMIT 1");
  remoteSettingsCache = r.rows[0]?.payload || null;
  remoteSettingsReady = true;
}

async function persistRemoteSettings(state) {
  if (!settingsPool) return;
  const payload = normalizedSettingsPayload(state);
  remoteSettingsCache = payload;
  try {
    await ensureSettingsTable();
    await settingsPool.query(
      `INSERT INTO app_settings (id, payload, updated_at)
       VALUES ('main', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(payload)],
    );
  } catch (e) {
    console.warn("Neon settings persist failed:", e.message);
  }
}

async function ensureStateTable() {
  if (!settingsPool) throw new Error("DATABASE_URL mangler");
  await settingsPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureTeamLogosTable() {
  if (!settingsPool) throw new Error("DATABASE_URL mangler");
  await settingsPool.query(`
    CREATE TABLE IF NOT EXISTS team_logos (
      team_key TEXT PRIMARY KEY,
      logo_data TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadTeamLogosMap() {
  if (!settingsPool) return {};
  try {
    await ensureTeamLogosTable();
    const r = await settingsPool.query("SELECT team_key, logo_data FROM team_logos");
    const map = {};
    for (const row of r.rows || []) {
      const key = normalizeTeamKey(row.team_key);
      const val = String(row.logo_data || "").trim();
      if (!key || !val) continue;
      map[key] = val;
    }
    return map;
  } catch (e) {
    console.warn("Neon team logos read failed:", e.message);
    return {};
  }
}

async function upsertTeamLogo(teamKey, logoDataUrl) {
  if (!settingsPool) return;
  const key = normalizeTeamKey(teamKey);
  const value = String(logoDataUrl || "").trim();
  if (!key || !value) return;
  try {
    await ensureTeamLogosTable();
    await settingsPool.query(
      `INSERT INTO team_logos (team_key, logo_data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (team_key) DO UPDATE SET logo_data = EXCLUDED.logo_data, updated_at = NOW()`,
      [key, value],
    );
  } catch (e) {
    console.warn("Neon team logo upsert failed:", e.message);
  }
}

async function deleteTeamLogo(teamKey) {
  if (!settingsPool) return;
  const key = normalizeTeamKey(teamKey);
  if (!key) return;
  try {
    await ensureTeamLogosTable();
    await settingsPool.query("DELETE FROM team_logos WHERE team_key = $1", [key]);
  } catch (e) {
    console.warn("Neon team logo delete failed:", e.message);
  }
}

async function loadRemoteState() {
  if (!settingsPool) throw new Error("DATABASE_URL mangler");
  await ensureStateTable();
  const r = await settingsPool.query("SELECT payload FROM app_state WHERE id = 'main' LIMIT 1");
  remoteStateCache = r.rows[0]?.payload || null;
  remoteStateReady = true;
}

async function persistRemoteState(state) {
  if (!settingsPool) return;
  try {
    await ensureStateTable();
    await settingsPool.query(
      `INSERT INTO app_state (id, payload, updated_at)
       VALUES ('main', $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
    remoteStateCache = JSON.parse(JSON.stringify(state));
  } catch (e) {
    console.warn("Neon state persist failed:", e.message);
  }
}

function applyRemoteSettingsIfNeeded(state) {
  if (!remoteSettingsReady || !remoteSettingsCache) return false;
  const incomingCoaches = Array.isArray(remoteSettingsCache.coaches) ? remoteSettingsCache.coaches : [];
  const incomingLogos =
    remoteSettingsCache.teamLogos && typeof remoteSettingsCache.teamLogos === "object"
      ? remoteSettingsCache.teamLogos
      : {};
  const stateCoaches = Array.isArray(state.coaches) ? state.coaches : [];
  const stateLogos = state.teamLogos && typeof state.teamLogos === "object" ? state.teamLogos : {};
  const shouldRestoreCoaches = incomingCoaches.length > 0 && (stateCoaches.length === 0 || isDefaultCoachSet(stateCoaches));
  const shouldRestoreLogos = Object.keys(incomingLogos).length > 0 && Object.keys(stateLogos).length === 0;
  let dirty = false;
  if (shouldRestoreCoaches) {
    state.coaches = incomingCoaches.map((c, i) => ({
      id: c?.id ? String(c.id) : `coach-${i + 1}`,
      name: String(c?.name || "").trim(),
      phone: String(c?.phone || "").trim(),
      role: String(c?.role || "").trim(),
      note: String(c?.note || "").trim(),
    }));
    state.coachNames = state.coaches.map((c) => c.name);
    dirty = true;
  }
  if (shouldRestoreLogos) {
    state.teamLogos = { ...incomingLogos };
    dirty = true;
  }
  return dirty;
}

function initialPlayers() {
  const p2015 = Array.from({ length: 9 }, (_, i) => ({
    id: `p2015-${i + 1}`,
    name: `Spelare 2015–${i + 1}`,
    birthYear: 2015,
    jerseyNumber: null,
    preferredPosition: "",
    matchesPlayed: 0,
    lastPlayedMatchNumber: null,
    available: true,
    unavailableReason: null,
  }));
  const p2016 = Array.from({ length: 10 }, (_, i) => ({
    id: `p2016-${i + 1}`,
    name: `Spelare 2016–${i + 1}`,
    birthYear: 2016,
    jerseyNumber: null,
    preferredPosition: "",
    matchesPlayed: 0,
    lastPlayedMatchNumber: null,
    available: true,
    unavailableReason: null,
  }));
  return [...p2015, ...p2016];
}

function initialMatches() {
  return Array.from({ length: MATCH_COUNT }, (_, i) => ({
    id: `m${i + 1}`,
    number: i + 1,
    matchNumber: i + 1,
    branch: "p10",
    status: "not_played",
    selectedPlayerIds: [],
    selectedPlayers: [],
    declinedPlayerIds: [],
    unavailablePlayerIds: [],
    intendedGroup2015: null,
    group2015: null,
    intendedGroup2016: null,
    selectionExplanation: null,
    comments: [],
    note: "",
    lineup: null,
    fixture: null,
  }));
}

function defaultCoaches() {
  return COACH_NAMES.map((name, i) => ({
    id: `coach-${i + 1}`,
    name,
    phone: "",
    role: "",
    note: "",
  }));
}

function defaultState() {
  try {
    const rawSeed = fs.readFileSync(SEED_PATH, "utf8");
    const seed = JSON.parse(rawSeed);
    if (Array.isArray(seed?.players) && Array.isArray(seed?.matches) && seed.players.length && seed.matches.length) {
      return seed;
    }
  } catch {
    // Fallback till inbyggd standard om seed saknas.
  }
  const players = initialPlayers();
  const built6 = buildGroups2016FromPlayers(players);
  return {
    meta: {
      revision: 1,
      updatedAt: new Date().toISOString(),
    },
    players,
    matches: initialMatches(),
    groups2015: buildGroups2015FromPlayers(players),
    groups2016: built6.groups2016,
    groups2016Extra: built6.groups2016Extra,
    fixturesP11: [],
    coachNames: [...COACH_NAMES],
    coaches: defaultCoaches(),
    teamLogos: {},
    testLab: { teams: [], lineups: [] },
  };
}

function loadSeedState() {
  try {
    const raw = fs.readFileSync(SEED_PATH, "utf8");
    const seed = JSON.parse(raw);
    if (!Array.isArray(seed?.players) || !Array.isArray(seed?.matches)) return null;
    return seed;
  } catch {
    return null;
  }
}

const SEED_FIXTURE_KEYS = ["series", "association", "date", "time", "venue", "home", "away"];

function mergeSeedFixtureIntoMatch(existing, seedFixture) {
  if (!seedFixture || typeof seedFixture !== "object") return false;
  if (!existing.fixture || typeof existing.fixture !== "object") existing.fixture = {};
  const scheduleLocked = existing.fixtureScheduleLocked === true;
  let changed = false;
  for (const key of SEED_FIXTURE_KEYS) {
    if (scheduleLocked && (key === "date" || key === "time")) continue;
    const seedVal = seedFixture[key];
    if (seedVal == null || seedVal === "") continue;
    if (existing.fixture[key] !== seedVal) {
      existing.fixture[key] = seedVal;
      changed = true;
    }
  }
  return changed;
}

function ensureMinimumScheduleFromSeed(state) {
  const seed = loadSeedState();
  if (!seed) return false;
  let dirty = false;
  const byId = new Map((state.matches || []).map((m) => [m.id, m]));
  for (const sm of seed.matches || []) {
    const existing = byId.get(sm.id);
    if (!existing) {
      state.matches.push(JSON.parse(JSON.stringify(sm)));
      dirty = true;
      continue;
    }
    if (mergeSeedFixtureIntoMatch(existing, sm.fixture)) dirty = true;
  }
  const p11Count = (state.matches || []).filter((m) => m.branch === "p11").length;
  if (p11Count === 0 && Array.isArray(seed.fixturesP11) && seed.fixturesP11.length > 0) {
    state.fixturesP11 = JSON.parse(JSON.stringify(seed.fixturesP11));
    dirty = true;
  }
  if (dirty) {
    state.matches.sort(compareMatchesChronologically);
  }
  return dirty;
}

function ensureMeta(data) {
  if (!data.meta || typeof data.meta !== "object") {
    data.meta = { revision: 1, updatedAt: new Date().toISOString() };
    return true;
  }
  let dirty = false;
  if (!Number.isFinite(Number(data.meta.revision))) {
    data.meta.revision = 1;
    dirty = true;
  }
  if (!data.meta.updatedAt || typeof data.meta.updatedAt !== "string") {
    data.meta.updatedAt = new Date().toISOString();
    dirty = true;
  }
  return dirty;
}

function migrateAvailability(data) {
  let dirty = false;
  for (const p of data.players) {
    if (p.birthYear !== undefined && p.birthYear !== null) {
      const y = Number(p.birthYear);
      if (Number.isFinite(y) && typeof p.birthYear !== "number") {
        p.birthYear = y;
        dirty = true;
      }
    }
    if (normalizePlayerAvailabilityFlags(p)) dirty = true;
    if (p.available === undefined) {
      p.available = true;
      dirty = true;
    }
    if (p.jerseyNumber === undefined) {
      p.jerseyNumber = null;
      dirty = true;
    }
    if (typeof p.preferredPosition !== "string") {
      p.preferredPosition = "";
      dirty = true;
    }
  }
  return dirty;
}

function normalizeLineup(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const formationRaw = src.formation && typeof src.formation === "object" ? src.formation : {};
  const defenders = Math.max(1, Math.min(5, Math.floor(Number(formationRaw.defenders || 2))));
  const midfielders = Math.max(0, Math.min(5, Math.floor(Number(formationRaw.midfielders || 2))));
  const attackers = Math.max(0, Math.min(5, Math.floor(Number(formationRaw.attackers || 2))));
  const formation = { defenders, midfielders, attackers };
  const side = src.side === "höger" ? "höger" : "vänster";
  const starters = Array.isArray(src.starters)
    ? src.starters
        .map((row) => ({
          playerId: String(row?.playerId || "").trim(),
          role: String(row?.role || "").trim(),
          lane: String(row?.lane || "").trim() || "central",
          order: Number.isFinite(Number(row?.order)) ? Math.max(1, Math.floor(Number(row.order))) : 1,
        }))
        .filter((row) => row.playerId && row.role)
    : [];
  const substitutions = Array.isArray(src.substitutions)
    ? src.substitutions
        .map((row) => ({
          order: Number.isFinite(Number(row?.order)) ? Math.max(1, Math.floor(Number(row.order))) : 1,
          outPlayerId: String(row?.outPlayerId || "").trim(),
          inPlayerId: String(row?.inPlayerId || "").trim(),
          note: String(row?.note || "").trim(),
        }))
        .filter((row) => row.outPlayerId || row.inPlayerId || row.note)
    : [];
  return { formation, side, starters, substitutions };
}

function makeCommentId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMatchReportPayload(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const result = String(o.result ?? "").trim().slice(0, 40);
  const positive = String(o.positive ?? "").trim().slice(0, 4000);
  const negative = String(o.negative ?? "").trim().slice(0, 4000);
  let opponentRating = o.opponentRating;
  if (opponentRating === "" || opponentRating === null || opponentRating === undefined) {
    opponentRating = null;
  } else {
    const n = Math.round(Number(opponentRating));
    opponentRating = Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null;
  }
  return { result, positive, negative, opponentRating };
}

/** Räknas som deltagen i en genomförd match: vald, inte tackat nej, och tillgänglig (globalt). */
function playerCountsAsPlayedInMatch(m, playerId, state) {
  const pid = String(playerId ?? "").trim();
  const squad = new Set((m.selectedPlayerIds || []).map((id) => String(id ?? "").trim()).filter(Boolean));
  if (!pid || !squad.has(pid)) return false;
  const declined = new Set((m.declinedPlayerIds || []).map((id) => String(id ?? "").trim()).filter(Boolean));
  if (declined.has(pid)) return false;
  if (matchUnavailablePlayerIdSet(m).has(pid)) return false;
  const pl = state.players.find((x) => String(x?.id ?? "") === pid);
  if (!pl || !isEligibleForMatchSquad(pl)) return false;
  if (!isPlayerAvailable(pl)) return false;
  return true;
}

function reconcilePlayerStats(state) {
  let dirty = false;
  for (const m of state.matches) {
    if (m.status !== "played" && m.status !== "not_played") {
      m.status = "not_played";
      dirty = true;
    }
  }
  const played = state.matches.filter((m) => m.status === "played");
  for (const p of state.players) {
    let n = 0;
    let lastM = null;
    for (const m of played) {
      if (playerCountsAsPlayedInMatch(m, p.id, state)) {
        n++;
        if (!lastM || compareMatchesChronologically(m, lastM) > 0) lastM = m;
      }
    }
    const lastN = lastM ? lastM.number : null;
    if (p.matchesPlayed !== n) {
      p.matchesPlayed = n;
      dirty = true;
    }
    if (p.lastPlayedMatchNumber !== lastN) {
      p.lastPlayedMatchNumber = lastN;
      dirty = true;
    }
  }
  return dirty;
}

function migrateStateShape(data) {
  let dirty = false;
  if (!data.testLab || typeof data.testLab !== "object") {
    data.testLab = { teams: [], lineups: [] };
    dirty = true;
  }
  for (const m of data.matches || []) {
    if (m.number === undefined && m.matchNumber !== undefined) {
      m.number = Number(m.matchNumber);
      dirty = true;
    }
    if (m.matchNumber === undefined) {
      m.matchNumber = Number(m.number) || null;
      dirty = true;
    }
    if (!Array.isArray(m.selectedPlayerIds) && Array.isArray(m.selectedPlayers)) {
      m.selectedPlayerIds = [...m.selectedPlayers];
      dirty = true;
    }
    if (!Array.isArray(m.selectedPlayers)) {
      m.selectedPlayers = Array.isArray(m.selectedPlayerIds) ? [...m.selectedPlayerIds] : [];
      dirty = true;
    }
    if (!Array.isArray(m.declinedPlayerIds)) {
      m.declinedPlayerIds = [];
      dirty = true;
    } else {
      const normalizedDeclines = [...new Set(m.declinedPlayerIds.map((id) => String(id || "").trim()).filter(Boolean))];
      if (JSON.stringify(normalizedDeclines) !== JSON.stringify(m.declinedPlayerIds)) {
        m.declinedPlayerIds = normalizedDeclines;
        dirty = true;
      }
    }
    if (!Array.isArray(m.unavailablePlayerIds)) {
      m.unavailablePlayerIds = [];
      dirty = true;
    } else {
      const normalizedUnavail = [...new Set(m.unavailablePlayerIds.map((id) => String(id || "").trim()).filter(Boolean))];
      if (JSON.stringify(normalizedUnavail) !== JSON.stringify(m.unavailablePlayerIds)) {
        m.unavailablePlayerIds = normalizedUnavail;
        dirty = true;
      }
    }
    if (m.intendedGroup2015 === undefined) {
      m.intendedGroup2015 = null;
      dirty = true;
    }
    if (m.group2015 === undefined) {
      m.group2015 = m.intendedGroup2015 ?? null;
      dirty = true;
    }
    if (m.selectionExplanation === undefined) {
      m.selectionExplanation = null;
      dirty = true;
    }
    if (!Array.isArray(m.comments)) {
      m.comments = [];
      dirty = true;
    }
    if (Array.isArray(m.comments)) {
      const normalizedComments = m.comments
        .map((c) => ({
          id: String(c?.id || "").trim() || makeCommentId(),
          name: String(c?.name || "").trim(),
          text: String(c?.text || "").trim(),
          timestamp: String(c?.timestamp || "").trim() || new Date().toISOString(),
        }))
        .filter((c) => c.name && c.text);
      if (JSON.stringify(normalizedComments) !== JSON.stringify(m.comments)) {
        m.comments = normalizedComments;
        dirty = true;
      }
    }
    if (typeof m.note !== "string") {
      m.note = "";
      dirty = true;
    }
    const legacyNote = String(m.note || "").trim();
    if (legacyNote) {
      const alreadyMigrated = m.comments.some(
        (c) => String(c?.name || "").trim() === "Meddelande" && String(c?.text || "").trim() === legacyNote,
      );
      if (!alreadyMigrated) {
        m.comments.push({
          id: makeCommentId(),
          name: "Meddelande",
          text: legacyNote,
          timestamp: new Date().toISOString(),
        });
      }
      m.note = "";
      dirty = true;
    }
    if (m.lineup === undefined) {
      m.lineup = null;
      dirty = true;
    } else if (m.lineup) {
      const norm = normalizeLineup(m.lineup);
      if (JSON.stringify(norm) !== JSON.stringify(m.lineup)) {
        m.lineup = norm;
        dirty = true;
      }
    }
    if (m.fixture === undefined) {
      m.fixture = null;
      dirty = true;
    }
    if (m.intendedGroup2016 === undefined) {
      m.intendedGroup2016 = null;
      dirty = true;
    }
    if (m.branch === undefined || m.branch === null) {
      const s = typeof m.fixture?.series === "string" ? m.fixture.series : "";
      m.branch = s.includes("P 11") ? "p11" : "p10";
      dirty = true;
    }
    if (m.matchReport !== undefined && m.matchReport !== null) {
      if (typeof m.matchReport !== "object" || Array.isArray(m.matchReport)) {
        m.matchReport = null;
        dirty = true;
      } else {
        const n = normalizeMatchReportPayload(m.matchReport);
        if (JSON.stringify(n) !== JSON.stringify(m.matchReport)) {
          m.matchReport = n;
          dirty = true;
        }
      }
    }
    if (pruneMatchLineupToSelectedSquad(m)) dirty = true;
  }
  if (!Array.isArray(data.fixturesP11)) {
    data.fixturesP11 = [];
    dirty = true;
  }
  if (!Array.isArray(data.coachNames) || data.coachNames.length === 0) {
    data.coachNames = [...COACH_NAMES];
    dirty = true;
  }
  if (!Array.isArray(data.coaches) || data.coaches.length === 0) {
    const srcNames = Array.isArray(data.coachNames) && data.coachNames.length ? data.coachNames : [...COACH_NAMES];
    data.coaches = srcNames.map((name, i) => ({
      id: `coach-${i + 1}`,
      name: String(name || "").trim(),
      phone: "",
      role: "",
      note: "",
    }));
    dirty = true;
  } else {
    const normalized = [];
    for (let i = 0; i < data.coaches.length; i++) {
      const c = data.coaches[i] || {};
      const name = String(c.name || "").trim();
      if (!name) continue;
      normalized.push({
        id: c.id ? String(c.id) : `coach-${i + 1}`,
        name,
        phone: String(c.phone || "").trim(),
        role: String(c.role || "").trim(),
        note: String(c.note || "").trim(),
      });
    }
    if (!normalized.length) normalized.push(...defaultCoaches());
    data.coaches = normalized.slice(0, 20);
    data.coachNames = data.coaches.map((c) => c.name);
    dirty = true;
  }
  if (!data.teamLogos || typeof data.teamLogos !== "object" || Array.isArray(data.teamLogos)) {
    data.teamLogos = {};
    dirty = true;
  } else {
    const normalized = {};
    for (const [k, v] of Object.entries(data.teamLogos)) {
      if (typeof v !== "string" || !v.trim()) continue;
      const nk = normalizeTeamKey(k);
      if (!nk) continue;
      if (!normalized[nk]) normalized[nk] = v;
    }
    const prevKeys = Object.keys(data.teamLogos).sort().join("|");
    const nextKeys = Object.keys(normalized).sort().join("|");
    if (prevKeys !== nextKeys) dirty = true;
    data.teamLogos = normalized;
  }
  if (!data.groups2016 || typeof data.groups2016 !== "object") {
    const built = buildGroups2016FromPlayers(data.players || []);
    data.groups2016 = built.groups2016;
    data.groups2016Extra = built.groups2016Extra;
    dirty = true;
  }
  if (!Array.isArray(data.groups2016Extra)) {
    data.groups2016Extra = [];
    dirty = true;
  }

  const fp = data.fixturesP11 || [];
  const hasP11Match = (data.matches || []).some(
    (m) => m.branch === "p11" || String(m.id || "").startsWith("m11-"),
  );
  if (!hasP11Match && fp.length > 0) {
    const maxNum = Math.max(0, ...(data.matches || []).map((m) => Number(m.number) || 0));
    for (let i = 0; i < fp.length; i++) {
      data.matches.push({
        id: `m11-${i + 1}`,
        number: maxNum + i + 1,
        branch: "p11",
        status: "not_played",
        selectedPlayerIds: [],
        declinedPlayerIds: [],
        unavailablePlayerIds: [],
        intendedGroup2015: null,
        intendedGroup2016: null,
        selectionExplanation: null,
        fixture: {
          ...JSON.parse(JSON.stringify(fp[i])),
          p11Assist2016: Number.isFinite(Math.floor(Number(fp[i]?.p11Assist2016)))
            ? Math.max(0, Math.floor(Number(fp[i]?.p11Assist2016)))
            : 3,
        },
      });
    }
    dirty = true;
  }

  // Standard: om P11-match saknar explicit assistvärde, använd 3.
  for (const m of data.matches || []) {
    if (m.branch !== "p11") continue;
    if (!m.fixture || typeof m.fixture !== "object") m.fixture = {};
    if (m.fixture.p11Assist2016 === undefined || m.fixture.p11Assist2016 === null) {
      m.fixture.p11Assist2016 = 3;
      dirty = true;
    }
  }
  return dirty;
}

async function readState() {
  let data = null;
  let bootstrappedFromFallback = false;
  if (settingsPool) {
    try {
      await ensureStateTable();
      const r = await settingsPool.query("SELECT payload FROM app_state WHERE id = 'main' LIMIT 1");
      if (r.rows[0]?.payload) data = r.rows[0].payload;
    } catch (e) {
      console.warn("Neon state read failed:", e.message);
    }
  }

  if (!data && FILE_FALLBACK_ENABLED) {
    try {
      const raw = fs.readFileSync(DATA_PATH, "utf8");
      data = JSON.parse(raw);
    } catch {
      data = defaultState();
    }
    bootstrappedFromFallback = Boolean(settingsPool);
  }

  if (!data) {
    data = defaultState();
    bootstrappedFromFallback = bootstrappedFromFallback || Boolean(settingsPool);
  }

  if (shouldRestoreFromRemoteState(data)) {
    data = JSON.parse(JSON.stringify(remoteStateCache));
  }
  if (!data.players?.length || !data.matches?.length) {
    if (remoteStateCache) {
      data = JSON.parse(JSON.stringify(remoteStateCache));
    } else {
      data = defaultState();
    }
    bootstrappedFromFallback = bootstrappedFromFallback || Boolean(settingsPool);
  }
  const snapshotBefore = stateMigrationFingerprint(data);
  migrateStateShape(data);
  const dbLogos = await loadTeamLogosMap();
  if (Object.keys(dbLogos).length > 0) {
    if (!data.teamLogos || typeof data.teamLogos !== "object") data.teamLogos = {};
    for (const [k, v] of Object.entries(dbLogos)) {
      if (!data.teamLogos[k]) data.teamLogos[k] = v;
    }
  }
  ensureMeta(data);
  migrateAvailability(data);
  repairGroups2015IfNeeded(data);
  repairGroups2016IfNeeded(data);
  stripLegacyP10SquadsIfNeeded(data);
  repairP11Squad2014IfNeeded(data);
  ensureMinimumScheduleFromSeed(data);
  migrateStateShape(data);
  applyRemoteSettingsIfNeeded(data);
  reconcilePlayerStats(data);
  backfillIntendedGroups2015(data);
  repairClearUnavailableOnPlayedMatches(data);
  const snapshotAfter = stateMigrationFingerprint(data);
  const actuallyChanged = snapshotBefore !== snapshotAfter;
  if (actuallyChanged || bootstrappedFromFallback) await writeState(data);
  return data;
}

/**
 * Fingeravtrykk av migrerbart innhold — utelater `meta` (revision/updatedAt)
 * og felter som regenereres av `jsonState`/`syncMatchShape`. Brukes til å
 * unngå at hver GET trigger en skriving og bumper revision unødig.
 */
function stateMigrationFingerprint(state) {
  if (!state || typeof state !== "object") return "";
  const clone = JSON.parse(JSON.stringify(state));
  delete clone.meta;
  delete clone.rotationView;
  delete clone.coachNames;
  delete clone.fixturesP11;
  if (Array.isArray(clone.matches)) {
    for (const m of clone.matches) {
      delete m.matchNumber;
      delete m.selectedPlayers;
      delete m.group2015;
    }
  }
  return JSON.stringify(clone);
}

function normalizeImportedState(raw) {
  if (!raw || typeof raw !== "object") throw new Error("invalid_backup");
  const data = JSON.parse(JSON.stringify(raw));
  if (!Array.isArray(data.players) || !Array.isArray(data.matches)) throw new Error("invalid_backup");
  migrateStateShape(data);
  migrateAvailability(data);
  repairGroups2015IfNeeded(data);
  repairGroups2016IfNeeded(data);
  stripLegacyP10SquadsIfNeeded(data);
  repairP11Squad2014IfNeeded(data);
  ensureMinimumScheduleFromSeed(data);
  migrateStateShape(data);
  reconcilePlayerStats(data);
  backfillIntendedGroups2015(data);
  repairClearUnavailableOnPlayedMatches(data);
  if (!validateGroups2015(data)) throw new Error("groups2015_invalid");
  if (!validateGroups2016(data)) throw new Error("groups2016_invalid");
  // Keep testLab separate from core backup by default.
  if (!data.testLab || typeof data.testLab !== "object") data.testLab = { teams: [], lineups: [] };
  return data;
}

function syncMatchShape(state) {
  for (const m of state.matches || []) {
    m.matchNumber = Number(m.number) || null;
    m.selectedPlayers = Array.isArray(m.selectedPlayerIds) ? [...m.selectedPlayerIds] : [];
    m.group2015 = m.intendedGroup2015 ?? null;
    if (!Array.isArray(m.comments)) m.comments = [];
    if (m.matchReport != null) {
      if (typeof m.matchReport !== "object" || Array.isArray(m.matchReport)) {
        m.matchReport = null;
      } else {
        m.matchReport = normalizeMatchReportPayload(m.matchReport);
      }
    }
  }
}

async function writeState(state) {
  if (!state.meta || typeof state.meta !== "object") {
    state.meta = { revision: 1, updatedAt: new Date().toISOString() };
  }
  const prevRevision = Number(state.meta.revision) || 0;
  state.meta.revision = prevRevision + 1;
  state.meta.updatedAt = new Date().toISOString();
  syncMatchShape(state);
  const p11Rows = (state.matches || [])
    .filter((m) => m.branch === "p11" && m.fixture)
    .sort(compareMatchesChronologically);
  state.fixturesP11 = p11Rows.map((m) => JSON.parse(JSON.stringify(m.fixture)));
  if (FILE_FALLBACK_ENABLED) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2), "utf8");
  }
  await persistRemoteState(state);
  await persistRemoteSettings(state);
  if (state.teamLogos && typeof state.teamLogos === "object") {
    for (const [k, v] of Object.entries(state.teamLogos)) {
      if (typeof v === "string" && v.trim()) {
        await upsertTeamLogo(k, v);
      }
    }
  }
}

function jsonState(state) {
  syncMatchShape(state);
  const coaches =
    Array.isArray(state.coaches) && state.coaches.length
      ? state.coaches
          .map((c, i) => ({
            id: c?.id ? String(c.id) : `coach-${i + 1}`,
            name: String(c?.name || "").trim(),
            phone: String(c?.phone || "").trim(),
            role: String(c?.role || "").trim(),
            note: String(c?.note || "").trim(),
          }))
          .filter((c) => c.name)
      : defaultCoaches();
  return {
    ...state,
    meta: state.meta || { revision: 1, updatedAt: new Date().toISOString() },
    rotationView: buildRotationView(state),
    coaches,
    coachNames: coaches.map((c) => c.name),
    teamLogos: state.teamLogos && typeof state.teamLogos === "object" ? state.teamLogos : {},
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
// Hindra mellomlagring av API (PWA/service worker, CDN) så klient alltid får färsk state.
app.use((req, res, next) => {
  if (String(req.path || "").startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
  }
  next();
});

const isProd = NODE_ENV === "production";
if (isProd) {
  app.use(express.static(path.join(__dirname, "dist")));
}

app.get("/api/version", (_req, res) => {
  res.json({
    version: PACKAGE_VERSION,
    commit: BUILD_COMMIT,
    env: NODE_ENV,
    updatedAt: new Date().toISOString(),
  });
});

app.get("/api/health/db", async (_req, res) => {
  try {
    if (!settingsPool) {
      return res.status(500).json({
        ok: false,
        db: "missing_database_url",
        message: "DATABASE_URL saknas",
      });
    }
    const r = await settingsPool.query("SELECT NOW() AS now");
    return res.json({
      ok: true,
      db: "connected",
      now: r.rows[0]?.now || null,
      env: NODE_ENV,
      fileFallback: FILE_FALLBACK_ENABLED,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      db: "error",
      message: e.message,
      env: NODE_ENV,
      fileFallback: FILE_FALLBACK_ENABLED,
    });
  }
});

app.get("/api/state", async (_req, res) => {
  res.json(jsonState(await readState()));
});

app.post("/api/fixtures/sync-ics", async (req, res) => {
  try {
    const state = await readState();
    const url = normalizeIcsUrl(req.body?.url);
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(400).json({ error: `Kunde inte hämta ICS (${response.status}).` });
    }
    const icsText = await response.text();
    const fixtures = parseIcsFixtures(icsText);
    if (!fixtures.length) {
      return res.status(400).json({
        error:
          "Inga IFK Ölme-matcher hittades i ICS-flödet. Kontrollera att kalenderlänken tillhör rätt MinFotboll-konto.",
      });
    }
    const result = syncFixturesFromIcs(state, fixtures);
    await writeState(state);
    return res.json({
      ...jsonState(state),
      sync: {
        url,
        parsedEvents: fixtures.length,
        updatedMatches: result.updatedMatches,
        unmatchedIcs: result.unmatchedIcs,
        sourceCounts: result.sourceCounts,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: `ICS-synk misslyckades: ${e.message}` });
  }
});

app.get("/api/simulate-season", async (_req, res) => {
  try {
    const s = await readState();
    res.json(simulateFullSeason(s));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/state/import", async (req, res) => {
  try {
    const existing = await readState();
    const state = normalizeImportedState(req.body);
    // Preserve testLab to avoid mixing "core" backup with the Test sandbox.
    state.testLab = existing?.testLab && typeof existing.testLab === "object" ? existing.testLab : { teams: [], lineups: [] };
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    if (e.message === "invalid_backup") {
      return res.status(400).json({ error: "Ogiltig backupfil." });
    }
    if (e.message === "groups2015_invalid") {
      return res.status(400).json({ error: "Backupen har ogiltiga 2015-grupper." });
    }
    if (e.message === "groups2016_invalid") {
      return res.status(400).json({ error: "Backupen har ogiltiga 2016-grupper." });
    }
    return res.status(400).json({ error: "Kunde inte importera backup." });
  }
});

app.get("/api/testlab/state", async (_req, res) => {
  const state = await readState();
  res.json({
    testLab: state?.testLab && typeof state.testLab === "object" ? state.testLab : { teams: [], lineups: [] },
    updatedAt: state?.meta?.updatedAt || null,
    revision: Number(state?.meta?.revision) || 0,
  });
});

app.put("/api/testlab/state", async (req, res) => {
  const state = await readState();
  const next = req.body?.testLab ?? req.body;
  if (!next || typeof next !== "object") return res.status(400).json({ error: "Ogiltigt testdata." });
  state.testLab = next;
  await writeState(state);
  res.json({
    testLab: state.testLab,
    updatedAt: state?.meta?.updatedAt || null,
    revision: Number(state?.meta?.revision) || 0,
  });
});

app.put("/api/settings/coaches", async (req, res) => {
  const state = await readState();
  const incoming = Array.isArray(req.body?.coaches)
    ? req.body.coaches
    : Array.isArray(req.body?.coachNames)
      ? req.body.coachNames.map((name) => ({ name }))
      : [];
  const coaches = [];
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i] || {};
    const name = String(row.name || "").trim();
    if (!name) continue;
    coaches.push({
      id: row.id ? String(row.id) : `coach-${Date.now()}-${i}`,
      name,
      phone: String(row.phone || "").trim(),
      role: String(row.role || "").trim(),
      note: String(row.note || "").trim(),
    });
  }
  if (!coaches.length) return res.status(400).json({ error: "Ange minst en tränare." });
  state.coaches = coaches.slice(0, 20);
  state.coachNames = state.coaches.map((c) => c.name);
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/team-logos", async (req, res) => {
  const state = await readState();
  const team = String(req.body?.team || "").trim();
  const teamKey = normalizeTeamKey(team);
  const logoDataUrl = req.body?.logoDataUrl;
  if (!teamKey) return res.status(400).json({ error: "Lag saknas." });
  if (!state.teamLogos || typeof state.teamLogos !== "object") state.teamLogos = {};
  if (logoDataUrl === null) {
    delete state.teamLogos[team];
    delete state.teamLogos[teamKey];
    await deleteTeamLogo(teamKey);
    await writeState(state);
    return res.json(jsonState(state));
  }
  const value = String(logoDataUrl || "").trim();
  if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml)(;[^,]*)?,/i.test(value)) {
    return res.status(400).json({ error: "Ogiltig bild. Ladda upp PNG/JPG/WebP/GIF/SVG." });
  }
  state.teamLogos[teamKey] = value;
  await upsertTeamLogo(teamKey, value);
  await writeState(state);
  res.json(jsonState(state));
});

/** Spara fasta 2015-grupper (exakt tre spelare per grupp A/B/C, alla nio täckta). */
app.put("/api/groups2015", async (req, res) => {
  const state = await readState();
  const { A, B, C } = req.body || {};
  if (!Array.isArray(A) || !Array.isArray(B) || !Array.isArray(C)) {
    return res.status(400).json({ error: "Ogiltigt format (A, B, C som listor)." });
  }
  const test = { ...state, groups2015: { A: [...A], B: [...B], C: [...C] } };
  if (!validateGroups2015(test)) {
    return res.status(400).json({
      error: "Grupperna måste ha exakt tre spelare vardera och täcka alla nio födda 2015.",
    });
  }
  state.groups2015 = { A: [...A], B: [...B], C: [...C] };
  await writeState(state);
  res.json(jsonState(state));
});

app.post("/api/players", async (req, res) => {
  const { name, birthYear, jerseyNumber, preferredPosition } = req.body;
  const year = Number(birthYear);
  if (!name || (year !== 2014 && year !== 2015 && year !== 2016)) {
    return res.status(400).json({ error: "Ogiltig spelare" });
  }
  const state = await readState();
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.players.push({
    id,
    name: String(name).trim(),
    birthYear: year,
    jerseyNumber: Number.isFinite(Number(jerseyNumber)) ? Math.max(1, Math.floor(Number(jerseyNumber))) : null,
    preferredPosition: String(preferredPosition || "").trim().slice(0, 40),
    matchesPlayed: 0,
    lastPlayedMatchNumber: null,
    available: true,
    unavailableReason: null,
  });
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  await writeState(state);
  res.json(jsonState(state));
});

/** Spara fasta 2016-grupper (tre per A/B/C vid minst nio 2016-spelare; övriga i extra-listan). */
app.put("/api/groups2016", async (req, res) => {
  const state = await readState();
  const { A, B, C, extra } = req.body || {};
  if (!Array.isArray(A) || !Array.isArray(B) || !Array.isArray(C)) {
    return res.status(400).json({ error: "Ogiltigt format (A, B, C som listor)." });
  }
  const extraList = Array.isArray(extra) ? [...extra] : [];
  const test = {
    ...state,
    groups2016: { A: [...A], B: [...B], C: [...C] },
    groups2016Extra: extraList,
  };
  if (!validateGroups2016(test)) {
    return res.status(400).json({
      error: "2016-grupperna måste täcka alla födda 2016: vid minst nio spelare exakt tre per A, B och C; övriga endast i extra.",
    });
  }
  state.groups2016 = { A: [...A], B: [...B], C: [...C] };
  state.groups2016Extra = extraList;
  await writeState(state);
  res.json(jsonState(state));
});

// POST /api/matches — opprett en manuell match (treningskamp eller saknad seriematch).
// Markeres med manualSource: true og fixtureScheduleLocked: true så ICS-sync og
// seed-merge ikke overskriver den.
app.post("/api/matches", async (req, res) => {
  try {
    const state = await readState();
    const body = req.body || {};
    const branch = body.branch === "p11" ? "p11" : "p10";
    const f = body.fixture || {};
    const date = String(f.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Ogiltigt datum (ÅÅÅÅ-MM-DD)." });
    }
    const home = String(f.home || "").trim();
    const away = String(f.away || "").trim();
    if (!home && !away) {
      return res.status(400).json({ error: "Ange minst ett av hemma- och bortalag." });
    }
    const time = String(f.time || "").trim();
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "Ogiltig tid (HH:MM)." });
    }

    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    const id = `mx-${branch}-${ts}-${rnd}`;
    const maxNum = Math.max(
      0,
      ...(state.matches || []).map((m) => Number(m.number) || 0),
    );

    const fixture = {
      series: String(f.series || "").trim(),
      association: String(f.association || "").trim(),
      date,
      time,
      venue: String(f.venue || "").trim(),
      home,
      away,
    };
    if (branch === "p11") {
      const n = Math.floor(Number(f.p11Assist2016));
      fixture.p11Assist2016 = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 3;
    } else if (f.p10Count2016 !== undefined && f.p10Count2016 !== null && f.p10Count2016 !== "") {
      const n = Math.floor(Number(f.p10Count2016));
      if (Number.isFinite(n)) fixture.p10Count2016 = Math.max(0, Math.min(20, n));
    }

    state.matches.push({
      id,
      number: maxNum + 1,
      matchNumber: maxNum + 1,
      branch,
      status: "not_played",
      selectedPlayerIds: [],
      selectedPlayers: [],
      declinedPlayerIds: [],
      unavailablePlayerIds: [],
      intendedGroup2015: null,
      group2015: null,
      intendedGroup2016: null,
      selectionExplanation: null,
      comments: [],
      note: "",
      lineup: null,
      fixture,
      fixtureScheduleLocked: true,
      manualSource: true,
    });
    state.matches.sort(compareMatchesChronologically);
    await writeState(state);
    res.json({ ...jsonState(state), createdMatchId: id });
  } catch (e) {
    res.status(500).json({ error: e.message || "Kunde inte skapa match." });
  }
});

// DELETE /api/matches/:id — endast tillåtet för manuellt skapade matcher,
// så att seed-/ICS-matcher inte kan raderas av misstag.
app.delete("/api/matches/:id", async (req, res) => {
  try {
    const state = await readState();
    const idx = (state.matches || []).findIndex((m) => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Match hittades inte." });
    const target = state.matches[idx];
    if (!target.manualSource) {
      return res.status(400).json({
        error: "Endast manuellt skapade matcher kan tas bort.",
      });
    }
    state.matches.splice(idx, 1);
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    res.status(500).json({ error: e.message || "Kunde inte ta bort match." });
  }
});

app.put("/api/matches/:id/fixture", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const body = req.body || {};
  if (!match.fixture || typeof match.fixture !== "object") match.fixture = {};
  const allowed = [
    "series",
    "association",
    "date",
    "time",
    "venue",
    "home",
    "away",
    "homeLogo",
    "awayLogo",
    "p11Assist2016",
    "p10Count2016",
  ];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    if (key === "p11Assist2016") {
      const n = Math.floor(Number(body.p11Assist2016));
      match.fixture.p11Assist2016 = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 0;
    } else if (key === "p10Count2016") {
      if (body.p10Count2016 === null || body.p10Count2016 === "") {
        delete match.fixture.p10Count2016;
      } else {
        const n = Math.floor(Number(body.p10Count2016));
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ error: "Ogiltigt antal födda 2016." });
        }
        match.fixture.p10Count2016 = Math.max(0, Math.min(20, n));
      }
    } else if (key === "date") {
      const d = String(body.date).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ error: "Ogiltigt datum (ÅÅÅÅ-MM-DD)." });
      }
      match.fixture.date = d;
      match.fixtureScheduleLocked = true;
    } else if (key === "time") {
      match.fixture.time = String(body.time ?? "").trim();
      match.fixtureScheduleLocked = true;
    } else {
      match.fixture[key] = String(body[key] ?? "").trim();
    }
  }
  state.matches.sort(compareMatchesChronologically);
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/players/:id", async (req, res) => {
  const state = await readState();
  const p = state.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Hittades inte" });
  const { name, birthYear, available, unavailableReason, jerseyNumber, preferredPosition } = req.body;
  const absenceReasons = new Set(["sick", "other"]);
  if (name != null) p.name = String(name).trim();
  if (birthYear != null) {
    const y = Number(birthYear);
    if (y !== 2014 && y !== 2015 && y !== 2016) return res.status(400).json({ error: "Ogiltigt födelseår" });
    p.birthYear = y;
  }
  if (available !== undefined && available !== null) {
    p.available = available === true || available === "true" || available === 1 || available === "1";
    if (p.available) {
      p.unavailableReason = null;
      clearPlayerAbsenceOnUpcomingMatches(state, p.id);
    } else if (unavailableReason === undefined) p.unavailableReason = "sick";
    normalizePlayerAvailabilityFlags(p);
  }
  if (unavailableReason !== undefined && unavailableReason !== null) {
    if (p.available) {
      p.unavailableReason = null;
    } else {
      const r = String(unavailableReason).trim();
      p.unavailableReason = absenceReasons.has(r) ? r : "sick";
    }
  }
  if (jerseyNumber !== undefined) {
    p.jerseyNumber = Number.isFinite(Number(jerseyNumber)) ? Math.max(1, Math.floor(Number(jerseyNumber))) : null;
  }
  if (preferredPosition !== undefined) {
    p.preferredPosition = String(preferredPosition || "").trim().slice(0, 40);
  }
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/lineup", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  if (!Array.isArray(match.selectedPlayerIds) || match.selectedPlayerIds.length === 0) {
    return res.status(400).json({ error: "Välj lag först innan startuppställning sparas." });
  }
  const lineup = normalizeLineup(req.body || {});
  const pool = new Set(match.selectedPlayerIds);
  for (const row of lineup.starters) {
    if (!pool.has(row.playerId)) {
      return res.status(400).json({ error: "Startelvan får bara innehålla valda spelare." });
    }
  }
  const gkCount = lineup.starters.filter((row) => row.role === "goalkeeper").length;
  const outfieldCount = lineup.starters.filter((row) => row.role !== "goalkeeper").length;
  if (gkCount > 1 || outfieldCount > 6) {
    return res.status(400).json({ error: "Startelvan kan ha högst 1 målvakt och 6 utespelare." });
  }
  const unique = new Set(lineup.starters.map((row) => row.playerId));
  if (unique.size !== lineup.starters.length) {
    return res.status(400).json({ error: "En spelare kan bara ha en position i startelvan." });
  }
  for (const sub of lineup.substitutions) {
    if (sub.outPlayerId && !pool.has(sub.outPlayerId)) {
      return res.status(400).json({ error: "Byten: utgående spelare måste vara i matchtruppen." });
    }
    if (sub.inPlayerId && !pool.has(sub.inPlayerId)) {
      return res.status(400).json({ error: "Byten: inbytt spelare måste vara i matchtruppen." });
    }
  }
  match.lineup = lineup;
  await writeState(state);
  res.json(jsonState(state));
});

async function applyMatchSquadUpdate(state, match, uniq) {
  const p11Complete = (match.branch || "p10") === "p11";
  const selectedPlayerIds = p11Complete ? appendP11Bench2014Players(state, uniq) : uniq;

  const squadValidation = validateMatchSquadForComplete(state, match, selectedPlayerIds);
  if (!squadValidation.ok) return { error: squadValidation.error };

  match.selectedPlayerIds = selectedPlayerIds;
  pruneMatchUnavailableToSquad(match);
  pruneMatchLineupToSelectedSquad(match);
  if (match.status === "played") reconcilePlayerStats(state);
  return { ok: true };
}

/** Korrigera trupp (spelad match) eller justera urval (kommande match). */
app.put("/api/matches/:id/squad", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  if (match.status === "played" || match.status === "not_played") {
    // ok
  } else {
    return res.status(400).json({ error: "Truppen kan inte ändras för denna matchstatus." });
  }
  const raw = req.body?.selectedPlayerIds;
  if (!Array.isArray(raw)) return res.status(400).json({ error: "Ogiltig trupp" });
  const uniq = [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))];
  const result = await applyMatchSquadUpdate(state, match, uniq);
  if (result.error) return res.status(400).json({ error: result.error });
  await writeState(state);
  res.json(jsonState(state));
});

/** Byt ut födda 2015 som tackat nej eller är sjuka i truppen. */
app.post("/api/matches/:id/squad/replace-2015", async (req, res) => {
  try {
    const state = await readState();
    const match = state.matches.find((m) => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: "Match hittades inte" });
    if (match.status === "played") {
      return res.status(400).json({ error: "Byt 2015-ersättare innan matchen markeras som genomförd." });
    }
    if (!match.selectedPlayerIds?.length) {
      return res.status(400).json({ error: "Välj lag först." });
    }
    const need = match2015PlayersNeedingReplacement(match, state);
    if (!need.length) {
      return res.status(400).json({ error: "Ingen född 2015 i truppen behöver ersättas." });
    }
    const replacementPlayerIds = req.body?.replacementPlayerIds;
    if (!Array.isArray(replacementPlayerIds)) {
      return res.status(400).json({ error: "Ogiltigt ersättarurval." });
    }
    const newSelected = buildSquadWith2015Replacements(match, state, replacementPlayerIds);
    const result = await applyMatchSquadUpdate(state, match, newSelected);
    if (result.error) return res.status(400).json({ error: result.error });
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    if (e.message === "replacement_2015_wrong_count") {
      return res.status(400).json({ error: "Välj rätt antal ersättare födda 2015." });
    }
    if (e.message === "replacement_2015_invalid") {
      return res.status(400).json({ error: "Ogiltig ersättare (måste vara tillgänglig född 2015)." });
    }
    if (e.message === "replacement_2015_already_in_squad") {
      return res.status(400).json({ error: "Spelaren ingår redan i truppen." });
    }
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/api/players/:id", async (req, res) => {
  const state = await readState();
  state.players = state.players.filter((x) => x.id !== req.params.id);
  for (const m of state.matches) {
    m.selectedPlayerIds = m.selectedPlayerIds.filter((id) => id !== req.params.id);
  }
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  await writeState(state);
  res.json(jsonState(state));
});

app.post("/api/matches/:id/select", async (req, res) => {
  try {
    const state = await readState();
    selectTeamForMatch(state, req.params.id, {
      override2015PlayerIds: req.body?.override2015PlayerIds,
      override2016PlayerIds: req.body?.override2016PlayerIds,
      rng: Math.random,
    });
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    if (e.message === "match_already_played") return res.status(400).json({ error: "Matchen är redan spelad" });
    if (e.message === "match_not_found") return res.status(404).json({ error: "Match hittades inte" });
    if (e.message === "override_too_many_2015") return res.status(400).json({ error: "Högst tre spelare födda 2015" });
    if (e.message === "override_invalid_2015") return res.status(400).json({ error: "Ogiltigt manuellt urval (endast 2015)" });
    if (e.message === "max_2015_exceeded") return res.status(400).json({ error: "Max tre spelare födda 2015" });
    if (e.message === "player_unavailable") return res.status(400).json({ error: "Otillgänglig spelare kan inte väljas" });
    if (e.message === "invalid_2015_pick") return res.status(400).json({ error: "Ogiltigt 2015-urval" });
    if (e.message === "cannot_field_three_2015") {
      return res.status(400).json({
        error: "Kan inte ta ut tre tillgängliga spelare födda 2015. Ändra tillgänglighet eller grupper.",
      });
    }
    if (e.message === "groups2015_invalid") {
      return res.status(400).json({
        error: "2015-grupperna är ogiltiga. Det krävs nio spelare födda 2015 och tre per grupp A, B, C.",
      });
    }
    if (e.message === "no_available_2016") {
      return res.status(400).json({ error: "Inga tillgängliga spelare födda 2016." });
    }
    if (e.message === "no_available_2015") {
      return res.status(400).json({ error: "Inga tillgängliga spelare födda 2015." });
    }
    if (e.message === "groups2016_invalid") {
      return res.status(400).json({
        error: "2016-grupperna är ogiltiga. Öppna Spelargrupp och spara A/B/C för födda 2016.",
      });
    }
    if (e.message === "p11_assist_zero") {
      return res.status(400).json({
        error: "Sätt antal födda 2016 (P 11-assist) till minst 1 på matchen, eller välj vanlig P 11 utan assist.",
      });
    }
    if (e.message === "invalid_2016_pick") return res.status(400).json({ error: "Ogiltigt 2016-urval" });
    if (e.message === "max_2016_exceeded") return res.status(400).json({ error: "För många födda 2016 i urvalet" });
    if (e.message === "cannot_field_2016_assist") {
      return res.status(400).json({ error: "För få tillgängliga födda 2016 för detta assistantal." });
    }
    if (e.message === "override_invalid_2016") return res.status(400).json({ error: "Ogiltigt manuellt 2016-urval" });
    if (e.message === "override_2016_wrong_count") {
      return res.status(400).json({ error: "Antal manuellt valda 2016 måste stämma med assistantalet." });
    }
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/matches/:id/complete", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  if (match.status === "played") return res.status(400).json({ error: "Redan markerad som genomförd" });
  if (!match.selectedPlayerIds?.length) return res.status(400).json({ error: "Välj lag först" });

  const p11Complete = (match.branch || "p10") === "p11";
  if (p11Complete) {
    match.selectedPlayerIds = appendP11Bench2014Players(state, [...match.selectedPlayerIds]);
  }

  const squadValidation = validateMatchSquadForComplete(state, match, match.selectedPlayerIds);
  if (!squadValidation.ok) return res.status(400).json({ error: squadValidation.error });

  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  if (!match.intendedGroup2015) {
    const ids2015 = match.selectedPlayerIds.filter((id) => birthYearNum(state.players.find((p) => p.id === id)) === 2015);
    if (ids2015.length > 0) {
      match.intendedGroup2015 = inferIntendedGroup2015(state.groups2015, ids2015);
    }
  }
  if (matchSquadMode(match) === "p11Mixed" && !match.intendedGroup2016) {
    const ids2016 = match.selectedPlayerIds.filter((id) => birthYearNum(state.players.find((p) => p.id === id)) === 2016);
    if (ids2016.length) {
      match.intendedGroup2016 = inferIntendedGroup2016(state.groups2016, ids2016);
    }
  }

  const normalizedReport = normalizeMatchReportPayload(req.body?.matchReport ?? req.body ?? {});
  match.matchReport = normalizedReport;

  match.status = "played";
  clearMatchUnavailableFlags(match);
  reconcilePlayerStats(state);
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/report", async (req, res) => {
  try {
    const state = await readState();
    const match = state.matches.find((m) => m.id === req.params.id);
    if (!match) return res.status(404).json({ error: "Match hittades inte" });
    if (match.status !== "played") {
      return res.status(400).json({ error: "Endast genomförda matcher kan ha rapport" });
    }
    const normalizedReport = normalizeMatchReportPayload(req.body?.matchReport ?? req.body ?? {});
    match.matchReport = normalizedReport;
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/matches/:id/decline", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const playerId = String(req.body?.playerId || "").trim();
  if (!playerId) return res.status(400).json({ error: "Spelar-ID saknas" });
  const declined = Boolean(req.body?.declined);
  if (!Array.isArray(match.declinedPlayerIds)) match.declinedPlayerIds = [];
  const normalized = match.declinedPlayerIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  match.declinedPlayerIds = [...new Set(normalized)];
  const exists = match.declinedPlayerIds.includes(playerId);
  if (declined && !exists) match.declinedPlayerIds.push(playerId);
  if (!declined && exists) {
    match.declinedPlayerIds = match.declinedPlayerIds.filter((id) => id !== playerId);
  }
  await writeState(state);
  res.json(jsonState(state));
});

/** Sätt hela listan «tackade nej» (t.ex. i efterhand för genomförda matcher). */
app.put("/api/matches/:id/declined-players", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const raw = req.body?.declinedPlayerIds;
  if (!Array.isArray(raw)) return res.status(400).json({ error: "Ogiltig lista över spelare" });
  const ids = [...new Set(raw.map((id) => String(id ?? "").trim()).filter(Boolean))];
  for (const id of ids) {
    if (!state.players.some((p) => String(p.id) === id)) {
      return res.status(400).json({ error: "Truppen innehåller ogiltigt spelar-ID." });
    }
  }
  match.declinedPlayerIds = ids;
  if (match.status === "played") reconcilePlayerStats(state);
  await writeState(state);
  res.json(jsonState(state));
});

/** Frånvaro (sjuk m.m.) bara för denna match — påverkar inte nästa match. */
app.put("/api/matches/:id/unavailable", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const playerId = String(req.body?.playerId || "").trim();
  if (!playerId) return res.status(400).json({ error: "Spelar-ID saknas" });
  const pl = state.players.find((p) => p.id === playerId);
  if (!pl) return res.status(404).json({ error: "Spelaren hittades inte" });
  const unavailable = Boolean(req.body?.unavailable);
  if (match.status === "played" && unavailable) {
    return res.status(400).json({ error: "Matchen är redan genomförd — frånvaro kan inte läggas till." });
  }
  if (!Array.isArray(match.unavailablePlayerIds)) match.unavailablePlayerIds = [];
  const set = new Set(match.unavailablePlayerIds);
  if (unavailable) {
    set.add(playerId);
  } else {
    set.delete(playerId);
  }
  match.unavailablePlayerIds = [...set];
  await writeState(state);
  res.json(jsonState(state));
});

async function handleMakePlayerAvailable(req, res) {
  try {
    const state = await readState();
    const matchId = String(req.params.matchId || req.params.id || "").trim();
    const playerId = String(req.params.playerId || req.body?.playerId || "").trim();
    applyPlayerMakeAvailable(state, matchId, playerId, {
      clearGlobal: req.body?.clearGlobal !== false,
      clearAllUpcoming: req.body?.clearAllUpcoming !== false,
    });
    await writeState(state);
    res.json(jsonState(state));
  } catch (e) {
    if (e.message === "match_not_found") return res.status(404).json({ error: "Match hittades inte" });
    if (e.message === "player_not_found") return res.status(404).json({ error: "Spelaren hittades inte" });
    if (e.message === "player_id_missing") return res.status(400).json({ error: "Spelar-ID saknas" });
    return res.status(500).json({ error: e.message });
  }
}

/** Gör spelaren tillgänglig för matchen (och alla kommande matcher). */
app.post("/api/matches/:matchId/players/:playerId/make-available", handleMakePlayerAvailable);
app.put("/api/matches/:matchId/players/:playerId/make-available", handleMakePlayerAvailable);
app.put("/api/matches/:matchId/make-player-available", handleMakePlayerAvailable);

/** Ångra match — tar bort genomförd status, återställer rotation utifrån kvarvarande matcher, uppdaterar statistik. */
app.post("/api/matches/:id/reopen", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  if (match.status !== "played") return res.status(400).json({ error: "Matchen är inte genomförd" });
  match.status = "not_played";
  match.intendedGroup2015 = null;
  match.intendedGroup2016 = null;
  match.selectionExplanation = null;
  match.matchReport = null;
  match.unavailablePlayerIds = [];
  reconcilePlayerStats(state);
  await writeState(state);
  res.json(jsonState(state));
});

app.post("/api/matches/:id/comments", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const name = String(req.body?.name || "").trim();
  const text = String(req.body?.text || "").trim();
  const allowedNames =
    Array.isArray(state.coaches) && state.coaches.length
      ? state.coaches.map((c) => String(c?.name || "").trim()).filter(Boolean)
      : Array.isArray(state.coachNames) && state.coachNames.length
        ? state.coachNames.map((n) => String(n || "").trim()).filter(Boolean)
        : [...COACH_NAMES];
  if (!allowedNames.includes(name)) return res.status(400).json({ error: "Ogiltigt namn" });
  if (!text) return res.status(400).json({ error: "Kommentaren är tom" });
  if (!Array.isArray(match.comments)) match.comments = [];
  match.comments.push({
    id: makeCommentId(),
    name,
    text,
    timestamp: new Date().toISOString(),
  });
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/comments/:commentId", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const commentId = String(req.params.commentId || "").trim();
  if (!commentId) return res.status(400).json({ error: "Kommentar-ID saknas" });
  if (!Array.isArray(match.comments)) match.comments = [];
  const idx = match.comments.findIndex((c) => String(c?.id || "") === commentId);
  if (idx < 0) return res.status(404).json({ error: "Kommentaren hittades inte" });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Kommentaren är tom" });
  match.comments[idx].text = text.slice(0, 500);
  match.comments[idx].editedAt = new Date().toISOString();
  await writeState(state);
  res.json(jsonState(state));
});

app.delete("/api/matches/:id/comments/:commentId", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const commentId = String(req.params.commentId || "").trim();
  if (!commentId) return res.status(400).json({ error: "Kommentar-ID saknas" });
  if (!Array.isArray(match.comments)) match.comments = [];
  const next = match.comments.filter((c) => String(c?.id || "") !== commentId);
  if (next.length === match.comments.length) return res.status(404).json({ error: "Kommentaren hittades inte" });
  match.comments = next;
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/note", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const note = String(req.body?.note || "").trim();
  if (note) {
    if (!Array.isArray(match.comments)) match.comments = [];
    match.comments.push({
      id: makeCommentId(),
      name: "Meddelande",
      text: note.slice(0, 500),
      timestamp: new Date().toISOString(),
    });
  }
  match.note = "";
  await writeState(state);
  res.json(jsonState(state));
});

/** Nollställ säsong: matcher, räknare, tillgänglighet; behåller spelare och giltiga 2015-grupper. */
app.post("/api/reset-season", async (_req, res) => {
  const state = await readState();
  for (const p of state.players) {
    p.matchesPlayed = 0;
    p.lastPlayedMatchNumber = null;
    p.available = true;
  }
  for (const m of state.matches) {
    m.status = "not_played";
    m.selectedPlayerIds = [];
    m.declinedPlayerIds = [];
    m.unavailablePlayerIds = [];
    m.intendedGroup2015 = null;
    m.intendedGroup2016 = null;
    m.selectionExplanation = null;
    m.matchReport = null;
  }
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  await writeState(state);
  res.json(jsonState(state));
});

if (isProd) {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

const PORT = Number(process.env.PORT) || 37831;
async function startServer() {
  if (isProd && !settingsPool) {
    console.error("DATABASE_URL mangler i production. Stoppar server.");
    process.exit(1);
  }
  try {
    await loadRemoteState();
  } catch (e) {
    console.warn("Neon state init failed:", e.message);
    remoteStateReady = true;
  }
  try {
    await loadRemoteSettings();
  } catch (e) {
    console.warn("Neon settings init failed:", e.message);
    remoteSettingsReady = true;
  }
  app.listen(PORT, () => {
    console.log(`API lyssnar på http://localhost:${PORT}`);
  });
}

startServer();
