import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";
import {
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
  matchSquadMode,
  p11Assist2016Count,
  stripLegacyP10SquadsIfNeeded,
  compareMatchesChronologically,
} from "./selection.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "data.json");
const SEED_PATH = path.join(__dirname, "data.seed.json");
const MATCH_COUNT = 13;
const MAX_2015 = 3;
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
    const branch = inferBranchFromText(hintText);
    if (!branch) continue;
    const teams = parseTeamsFromSummary(ev.summary || "");
    parsed.push({
      branch,
      date: dt.date,
      time: dt.time,
      venue: ev.location || "",
      home: teams.home,
      away: teams.away,
      summary: ev.summary || "",
      sortTs: dt.sortTs,
    });
  }
  return parsed.sort((a, b) => a.sortTs - b.sortTs);
}

function syncFixturesFromIcs(state, fixtures) {
  const byBranch = {
    p10: fixtures.filter((f) => f.branch === "p10"),
    p11: fixtures.filter((f) => f.branch === "p11"),
  };
  const touched = [];
  for (const branch of ["p10", "p11"]) {
    const targetMatches = (state.matches || [])
      .filter((m) => (m.branch || "p10") === branch)
      .sort(compareMatchesChronologically);
    const src = byBranch[branch];
    const n = Math.min(targetMatches.length, src.length);
    for (let i = 0; i < n; i++) {
      const m = targetMatches[i];
      const f = src[i];
      if (!m.fixture || typeof m.fixture !== "object") m.fixture = {};
      const prevAssist = m.fixture.p11Assist2016;
      m.fixture = {
        ...m.fixture,
        date: f.date,
        time: f.time || "00:00",
        venue: f.venue || m.fixture.venue || "",
        home: f.home || m.fixture.home || "",
        away: f.away || m.fixture.away || "",
      };
      if (branch === "p11" && prevAssist !== undefined) {
        m.fixture.p11Assist2016 = prevAssist;
      }
      touched.push(m.id);
    }
  }
  state.matches.sort(compareMatchesChronologically);
  return {
    updatedMatches: touched.length,
    sourceCounts: { p10: byBranch.p10.length, p11: byBranch.p11.length },
  };
}

function expectedAvailableIdsByYear(state, year) {
  return state.players
    .filter((p) => p.birthYear === year && isPlayerAvailable(p))
    .map((p) => p.id)
    .sort();
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

function sameSortedIdSets(a, b) {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
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

function ensureMinimumScheduleFromSeed(state) {
  const seed = loadSeedState();
  if (!seed) return false;
  let dirty = false;
  const has = new Set((state.matches || []).map((m) => m.id));
  for (const sm of seed.matches || []) {
    if (!has.has(sm.id)) {
      state.matches.push(JSON.parse(JSON.stringify(sm)));
      dirty = true;
    }
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
      if (m.selectedPlayerIds?.includes(p.id)) {
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
    if (typeof m.note !== "string") {
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
  let dirty = migrateStateShape(data);
  const dbLogos = await loadTeamLogosMap();
  if (Object.keys(dbLogos).length > 0) {
    if (!data.teamLogos || typeof data.teamLogos !== "object") data.teamLogos = {};
    let mergedAny = false;
    for (const [k, v] of Object.entries(dbLogos)) {
      if (!data.teamLogos[k]) {
        data.teamLogos[k] = v;
        mergedAny = true;
      }
    }
    if (mergedAny) dirty = true;
  }
  if (ensureMeta(data)) dirty = true;
  if (migrateAvailability(data)) dirty = true;
  if (repairGroups2015IfNeeded(data)) dirty = true;
  if (repairGroups2016IfNeeded(data)) dirty = true;
  if (stripLegacyP10SquadsIfNeeded(data)) dirty = true;
  if (ensureMinimumScheduleFromSeed(data)) dirty = true;
  if (applyRemoteSettingsIfNeeded(data)) dirty = true;
  if (reconcilePlayerStats(data)) dirty = true;
  if (backfillIntendedGroups2015(data)) dirty = true;
  if (dirty || bootstrappedFromFallback) await writeState(data);
  return data;
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
  ensureMinimumScheduleFromSeed(data);
  reconcilePlayerStats(data);
  backfillIntendedGroups2015(data);
  if (!validateGroups2015(data)) throw new Error("groups2015_invalid");
  if (!validateGroups2016(data)) throw new Error("groups2016_invalid");
  return data;
}

function syncMatchShape(state) {
  for (const m of state.matches || []) {
    m.matchNumber = Number(m.number) || null;
    m.selectedPlayers = Array.isArray(m.selectedPlayerIds) ? [...m.selectedPlayerIds] : [];
    m.group2015 = m.intendedGroup2015 ?? null;
    if (!Array.isArray(m.comments)) m.comments = [];
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
      return res.status(400).json({ error: "Inga matcher hittades i ICS-flödet." });
    }
    const result = syncFixturesFromIcs(state, fixtures);
    await writeState(state);
    return res.json({
      ...jsonState(state),
      sync: {
        url,
        parsedEvents: fixtures.length,
        updatedMatches: result.updatedMatches,
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
    const state = normalizeImportedState(req.body);
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
  if (!name || (year !== 2015 && year !== 2016)) {
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
  ];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    if (key === "p11Assist2016") {
      const n = Math.floor(Number(body.p11Assist2016));
      match.fixture.p11Assist2016 = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 0;
    } else {
      match.fixture[key] = body[key];
    }
  }
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/players/:id", async (req, res) => {
  const state = await readState();
  const p = state.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Hittades inte" });
  const { name, birthYear, available, jerseyNumber, preferredPosition } = req.body;
  if (name != null) p.name = String(name).trim();
  if (birthYear != null) {
    const y = Number(birthYear);
    if (y !== 2015 && y !== 2016) return res.status(400).json({ error: "Ogiltigt födelseår" });
    p.birthYear = y;
  }
  if (available !== undefined && available !== null) {
    p.available = Boolean(available);
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
  if (gkCount !== 1 || outfieldCount !== 6) {
    return res.status(400).json({ error: "Startelvan måste ha exakt 1 målvakt och 6 utespelare." });
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

  for (const id of match.selectedPlayerIds) {
    const pl = state.players.find((p) => p.id === id);
    if (!pl || !isPlayerAvailable(pl)) {
      return res.status(400).json({ error: "Alla valda spelare måste vara tillgängliga." });
    }
  }

  const count2015 = match.selectedPlayerIds.filter((id) => {
    const pl = state.players.find((p) => p.id === id);
    return pl?.birthYear === 2015;
  }).length;
  const count2016 = match.selectedPlayerIds.filter((id) => {
    const pl = state.players.find((p) => p.id === id);
    return pl?.birthYear === 2016;
  }).length;
  const mode = matchSquadMode(match);
  if (mode === "p11Mixed") {
    const nAssist = p11Assist2016Count(match, state);
    const want2015 = expectedAvailableIdsByYear(state, 2015);
    const sel2015 = match.selectedPlayerIds.filter((id) => state.players.find((p) => p.id === id)?.birthYear === 2015);
    if (!sameSortedIdSets(sel2015, want2015)) {
      return res.status(400).json({
        error: "Alla tillgängliga födda 2015 krävs. Välj lag på nytt om tillgänglighet ändrats.",
      });
    }
    if (count2016 !== nAssist) {
      return res.status(400).json({
        error: `Exakt ${nAssist} spelare födda 2016 krävs (assist). Välj lag på nytt.`,
      });
    }
  } else if (mode === "all2015") {
    if (count2016 !== 0) {
      return res.status(400).json({ error: "P11-seriematcher får endast innehålla spelare födda 2015." });
    }
    const want = expectedAvailableIdsByYear(state, 2015);
    if (!sameSortedIdSets(match.selectedPlayerIds, want)) {
      return res.status(400).json({
        error: "Alla tillgängliga födda 2015 krävs. Välj lag på nytt om tillgänglighet ändrats.",
      });
    }
  } else {
    if (count2015 !== MAX_2015) {
      return res.status(400).json({ error: "Exakt tre spelare födda 2015 krävs för att genomföra matchen." });
    }
    const want2016 = expectedAvailableIdsByYear(state, 2016);
    const sel2016 = match.selectedPlayerIds.filter((id) => state.players.find((p) => p.id === id)?.birthYear === 2016);
    if (!sameSortedIdSets(sel2016, want2016)) {
      return res.status(400).json({
        error: "Alla tillgängliga födda 2016 och exakt tre födda 2015 krävs. Välj lag på nytt om tillgänglighet ändrats.",
      });
    }
  }

  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  if (!match.intendedGroup2015) {
    const ids2015 = match.selectedPlayerIds.filter((id) => state.players.find((p) => p.id === id)?.birthYear === 2015);
    if (ids2015.length > 0) {
      match.intendedGroup2015 = inferIntendedGroup2015(state.groups2015, ids2015);
    }
  }
  if (mode === "p11Mixed" && !match.intendedGroup2016) {
    const ids2016 = match.selectedPlayerIds.filter((id) => state.players.find((p) => p.id === id)?.birthYear === 2016);
    if (ids2016.length) {
      match.intendedGroup2016 = inferIntendedGroup2016(state.groups2016, ids2016);
    }
  }

  match.status = "played";
  reconcilePlayerStats(state);
  await writeState(state);
  res.json(jsonState(state));
});

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
    name,
    text,
    timestamp: new Date().toISOString(),
  });
  await writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/note", async (req, res) => {
  const state = await readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const note = String(req.body?.note || "").trim();
  match.note = note.slice(0, 500);
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
    m.intendedGroup2015 = null;
    m.intendedGroup2016 = null;
    m.selectionExplanation = null;
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
