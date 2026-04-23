import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
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
const DEFAULT_MINFOTBOLL_ICS_URL =
  process.env.MINFOTBOLL_ICS_URL ||
  "https://minfotboll-api.azurewebsites.net/api/ExternalCalendarAPI/GetMemberCalendar/dmJFMkpKuMBlDjjZjRJNMKsxWnquLwbT.ics";

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
    matchesPlayed: 0,
    lastPlayedMatchNumber: null,
    available: true,
  }));
  const p2016 = Array.from({ length: 10 }, (_, i) => ({
    id: `p2016-${i + 1}`,
    name: `Spelare 2016–${i + 1}`,
    birthYear: 2016,
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
    fixture: null,
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
  }
  return dirty;
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

function readState() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data.players?.length || !data.matches?.length) return defaultState();
    let dirty = migrateStateShape(data);
    if (ensureMeta(data)) dirty = true;
    if (migrateAvailability(data)) dirty = true;
    if (repairGroups2015IfNeeded(data)) dirty = true;
    if (repairGroups2016IfNeeded(data)) dirty = true;
    if (stripLegacyP10SquadsIfNeeded(data)) dirty = true;
    if (ensureMinimumScheduleFromSeed(data)) dirty = true;
    if (reconcilePlayerStats(data)) dirty = true;
    if (backfillIntendedGroups2015(data)) dirty = true;
    if (dirty) writeState(data);
    return data;
  } catch {
    const s = defaultState();
    writeState(s);
    return s;
  }
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

function writeState(state) {
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
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2), "utf8");
}

function jsonState(state) {
  syncMatchShape(state);
  return {
    ...state,
    meta: state.meta || { revision: 1, updatedAt: new Date().toISOString() },
    rotationView: buildRotationView(state),
    coachNames: COACH_NAMES,
  };
}

const app = express();
app.use(cors());
app.use(express.json());

const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  app.use(express.static(path.join(__dirname, "dist")));
}

app.get("/api/state", (_req, res) => {
  res.json(jsonState(readState()));
});

app.post("/api/fixtures/sync-ics", async (req, res) => {
  try {
    const state = readState();
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
    writeState(state);
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

app.get("/api/simulate-season", (_req, res) => {
  try {
    const s = readState();
    res.json(simulateFullSeason(s));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/state/import", (req, res) => {
  try {
    const state = normalizeImportedState(req.body);
    writeState(state);
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

/** Spara fasta 2015-grupper (exakt tre spelare per grupp A/B/C, alla nio täckta). */
app.put("/api/groups2015", (req, res) => {
  const state = readState();
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
  writeState(state);
  res.json(jsonState(state));
});

app.post("/api/players", (req, res) => {
  const { name, birthYear } = req.body;
  const year = Number(birthYear);
  if (!name || (year !== 2015 && year !== 2016)) {
    return res.status(400).json({ error: "Ogiltig spelare" });
  }
  const state = readState();
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  state.players.push({
    id,
    name: String(name).trim(),
    birthYear: year,
    matchesPlayed: 0,
    lastPlayedMatchNumber: null,
    available: true,
  });
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  writeState(state);
  res.json(jsonState(state));
});

/** Spara fasta 2016-grupper (tre per A/B/C vid minst nio 2016-spelare; övriga i extra-listan). */
app.put("/api/groups2016", (req, res) => {
  const state = readState();
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
  writeState(state);
  res.json(jsonState(state));
});

app.put("/api/matches/:id/fixture", (req, res) => {
  const state = readState();
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
  writeState(state);
  res.json(jsonState(state));
});

app.put("/api/players/:id", (req, res) => {
  const state = readState();
  const p = state.players.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Hittades inte" });
  const { name, birthYear, available } = req.body;
  if (name != null) p.name = String(name).trim();
  if (birthYear != null) {
    const y = Number(birthYear);
    if (y !== 2015 && y !== 2016) return res.status(400).json({ error: "Ogiltigt födelseår" });
    p.birthYear = y;
  }
  if (available !== undefined && available !== null) {
    p.available = Boolean(available);
  }
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  writeState(state);
  res.json(jsonState(state));
});

app.delete("/api/players/:id", (req, res) => {
  const state = readState();
  state.players = state.players.filter((x) => x.id !== req.params.id);
  for (const m of state.matches) {
    m.selectedPlayerIds = m.selectedPlayerIds.filter((id) => id !== req.params.id);
  }
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  writeState(state);
  res.json(jsonState(state));
});

app.post("/api/matches/:id/select", (req, res) => {
  try {
    const state = readState();
    selectTeamForMatch(state, req.params.id, {
      override2015PlayerIds: req.body?.override2015PlayerIds,
      override2016PlayerIds: req.body?.override2016PlayerIds,
      rng: Math.random,
    });
    writeState(state);
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

app.post("/api/matches/:id/complete", (req, res) => {
  const state = readState();
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
  writeState(state);
  res.json(jsonState(state));
});

/** Ångra match — tar bort genomförd status, återställer rotation utifrån kvarvarande matcher, uppdaterar statistik. */
app.post("/api/matches/:id/reopen", (req, res) => {
  const state = readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  if (match.status !== "played") return res.status(400).json({ error: "Matchen är inte genomförd" });
  match.status = "not_played";
  match.intendedGroup2015 = null;
  match.intendedGroup2016 = null;
  match.selectionExplanation = null;
  reconcilePlayerStats(state);
  writeState(state);
  res.json(jsonState(state));
});

app.post("/api/matches/:id/comments", (req, res) => {
  const state = readState();
  const match = state.matches.find((m) => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match hittades inte" });
  const name = String(req.body?.name || "").trim();
  const text = String(req.body?.text || "").trim();
  if (!COACH_NAMES.includes(name)) return res.status(400).json({ error: "Ogiltigt namn" });
  if (!text) return res.status(400).json({ error: "Kommentaren är tom" });
  if (!Array.isArray(match.comments)) match.comments = [];
  match.comments.push({
    name,
    text,
    timestamp: new Date().toISOString(),
  });
  writeState(state);
  res.json(jsonState(state));
});

/** Nollställ säsong: matcher, räknare, tillgänglighet; behåller spelare och giltiga 2015-grupper. */
app.post("/api/reset-season", (_req, res) => {
  const state = readState();
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
  writeState(state);
  res.json(jsonState(state));
});

if (isProd) {
  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html"));
  });
}

const PORT = Number(process.env.PORT) || 37831;
app.listen(PORT, () => {
  console.log(`API lyssnar på http://localhost:${PORT}`);
});
