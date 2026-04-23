import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resolveTeamLogoUrl, teamInitials } from "@/lib/teamLogos";
import { matchSquadMode, p11Assist2016Count, compareMatchesChronologically } from "../selection.mjs";

const PROD_API_FALLBACK = "https://ifkolme-production.up.railway.app";
const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
const API_BASE = import.meta.env.DEV
  ? ""
  : configuredApiBase
    ? configuredApiBase.replace(/\/+$/, "")
    : PROD_API_FALLBACK;

async function api(path, options = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path;
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : options.body,
    cache: "no-store",
  });
  if (!r.ok) {
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || r.statusText);
    }
    const text = await r.text().catch(() => "");
    const hint =
      r.status === 404
        ? " (troligen fel port eller backend körs inte – starta med npm run dev)"
        : "";
    throw new Error(
      text.trim()
        ? `${r.status} ${r.statusText}: ${text.slice(0, 200)}${hint}`
        : `${r.status} ${r.statusText}${hint}`,
    );
  }
  return r.json();
}

const TABS = [
  { id: "players", label: "Spelargrupp" },
  { id: "matches", label: "Matcher" },
  { id: "overview", label: "Statistik" },
  { id: "settings", label: "Inställningar" },
];

const LS_STATE_KEY = "lagval.state.v1";
const LS_UI_KEY = "lagval.ui.v1";
const DEFAULT_MINFOTBOLL_ICS_URL =
  "webcal://minfotboll-api.azurewebsites.net/api/ExternalCalendarAPI/GetMemberCalendar/dmJFMkpKuMBlDjjZjRJNMKsxWnquLwbT.ics";
const DEFAULT_COACH_NAMES = ["Jonas", "Per", "Anders", "Kim"];
const PLAYER_POSITIONS = ["Målvakt", "Försvarare", "Mittfältare", "Anfallare", "Allround"];

function roleLabelSv(role) {
  if (role === "goalkeeper") return "Målvakt";
  if (role === "defender") return "Försvar";
  if (role === "midfielder") return "Mittfält";
  if (role === "attacker") return "Anfall";
  return role || "—";
}

function lanePattern(count) {
  if (count <= 1) return ["central"];
  if (count === 2) return ["vänster", "höger"];
  if (count === 3) return ["vänster", "central", "höger"];
  if (count === 4) return ["vänster", "central", "central", "höger"];
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return "vänster";
    if (i === count - 1) return "höger";
    return "central";
  });
}

function buildOutfieldSlots(formation) {
  const out = [];
  const pushGroup = (role, n) => {
    const lanes = lanePattern(n);
    for (let i = 0; i < n; i++) {
      out.push({ key: `${role}-${i + 1}`, role, lane: lanes[i], order: out.length + 1 });
    }
  };
  pushGroup("defender", Number(formation?.defenders || 0));
  pushGroup("midfielder", Number(formation?.midfielders || 0));
  pushGroup("attacker", Number(formation?.attackers || 0));
  return out;
}

function slotLabelFromKey(slotKey, outfieldSlots) {
  if (slotKey === "bench") return "Bänk";
  if (slotKey === "gk") return "Målvakt";
  const slot = outfieldSlots.find((s) => s.key === slotKey);
  if (!slot) return "Bänk";
  const lane = slot.lane === "vänster" ? "vänster" : slot.lane === "höger" ? "höger" : "central";
  return `${roleLabelSv(slot.role)} (${lane})`;
}

function seasonYear() {
  return new Date().getFullYear();
}

function playerAge(birthYear) {
  return seasonYear() - birthYear;
}

function groupLabelDisp(g) {
  if (g === "A" || g === "B" || g === "C") return `Grupp ${g}`;
  return "—";
}

function assignmentFromGroups2016(groups2016, groups2016Extra, players2016) {
  const m = {};
  for (const letter of ["A", "B", "C"]) {
    for (const id of groups2016[letter] || []) m[id] = letter;
  }
  for (const id of groups2016Extra || []) m[id] = "X";
  for (const p of players2016) {
    if (!m[p.id]) m[p.id] = "A";
  }
  return m;
}

function formatFixtureDateSv(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return "—";
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return isoDate;
  const [y, mo, d] = parts;
  const dt = new Date(y, mo - 1, d);
  return dt.toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" });
}

function formatTimestampSv(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseIsoDateLocal(isoDate) {
  if (!isoDate || typeof isoDate !== "string") return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function normalizeTeamKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function monthKeyOf(dateObj) {
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthKey(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  if (!y || !m) return null;
  return { year: y, month: m - 1 };
}

/** Truppvisning: samma namn-/år-typografi som översikten, sorterat 2015 först. */
function MatchLineupNames({ playerIds, players, canToggleAvailability = false, onToggleAvailability }) {
  const rows = useMemo(() => {
    return [...playerIds]
      .map((id) => players.find((p) => p.id === id))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.birthYear !== b.birthYear) return (a.birthYear || 0) - (b.birthYear || 0);
        return a.name.localeCompare(b.name, "sv");
      });
  }, [playerIds, players]);

  if (!rows.length) return null;
  return (
    <ul className="lineup-list" aria-label="Trupp">
      {rows.map((p) => (
        <li key={p.id} className="lineup-list__row">
          <span className="lineup-list__name">
            {p.name}
            {p.available === false ? <span className="lineup-list__status">Ej tillgänglig</span> : null}
          </span>
          <span className="lineup-list__year">{p.birthYear}</span>
          {canToggleAvailability ? (
            <button
              type="button"
              className={`btn btn--sm ${p.available === false ? "btn--secondary" : "btn--plain"} lineup-list__availability-btn`}
              onClick={() => onToggleAvailability?.(p)}
            >
              {p.available === false ? "Markera tillgänglig" : "Markera otillgänglig"}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FixtureCrest({ name, logoUrl }) {
  const resolvedUrl = useMemo(
    () => resolveTeamLogoUrl(name, logoUrl),
    [name, logoUrl],
  );
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [resolvedUrl]);

  const showImage = Boolean(resolvedUrl) && !imgFailed;

  return (
    <div
      className={`fixture-crest${showImage ? " fixture-crest--logo" : ""}`}
      aria-hidden
      data-team={name}
    >
      {showImage ? (
        <img
          className="fixture-crest__img"
          src={resolvedUrl}
          alt=""
          onError={() => setImgFailed(true)}
        />
      ) : (
        teamInitials(name || "")
      )}
    </div>
  );
}

function CalendarEventCrest({ name, logoUrl }) {
  const resolvedUrl = useMemo(() => resolveTeamLogoUrl(name, logoUrl), [name, logoUrl]);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [resolvedUrl]);
  if (!resolvedUrl || imgFailed) {
    return <span className="calendar-event__crest-fallback">{teamInitials(name || "")}</span>;
  }
  return <img className="calendar-event__crest" src={resolvedUrl} alt="" onError={() => setImgFailed(true)} />;
}

/** Seriekort (serie, tid, lag). */
function MinFotbollFixture({ fixture, getStoredTeamLogo }) {
  if (!fixture) return null;
  const homeTeam = String(fixture.home || fixture.homeTeam || "").trim();
  const awayTeam = String(fixture.away || fixture.awayTeam || "").trim();
  const dateLabel = formatFixtureDateSv(fixture.date);
  const timeIsPlaceholder = fixture.time === "00:00";
  const homeLogo = fixture.homeLogo || getStoredTeamLogo?.(homeTeam);
  const awayLogo = fixture.awayLogo || getStoredTeamLogo?.(awayTeam);
  return (
    <div className="fixture-block">
      <header className="fixture-block__head">
        <span className="fixture-block__series">{fixture.series}</span>
        {fixture.association ? <span className="fixture-block__assoc">{fixture.association}</span> : null}
      </header>
      <div className="fixture-block__row">
        <div className="fixture-block__side fixture-block__side--home">
          <FixtureCrest name={homeTeam} logoUrl={homeLogo} />
          <span className="fixture-block__club">{homeTeam || "Hemmalag"}</span>
        </div>
        <div className="fixture-block__center">
          {fixture.venue ? <span className="fixture-block__venue">{fixture.venue}</span> : null}
          {timeIsPlaceholder ? (
            <span className="fixture-time-tbd">TBD</span>
          ) : (
            <span className="fixture-block__time">{fixture.time}</span>
          )}
          <span className="fixture-block__date">{dateLabel}</span>
        </div>
        <div className="fixture-block__side fixture-block__side--away">
          <FixtureCrest name={awayTeam} logoUrl={awayLogo} />
          <span className="fixture-block__club">{awayTeam || "Bortalag"}</span>
        </div>
      </div>
    </div>
  );
}

/** Vilken A/B/C-lista en 2015-spelare tillhör (för visning på spelarkort). */
function groupLetterFor2015Player(id, groups2015) {
  if (!groups2015) return null;
  for (const g of ["A", "B", "C"]) {
    if ((groups2015[g] || []).includes(id)) return g;
  }
  return null;
}

function assignmentFromGroups(groups2015, players2015) {
  const m = {};
  for (const g of ["A", "B", "C"]) {
    for (const id of groups2015[g] || []) m[id] = g;
  }
  for (const p of players2015) {
    if (!m[p.id]) m[p.id] = "A";
  }
  return m;
}

function Groups2015Editor({ groups2015, players2015, load, setErr, revision }) {
  const [assign, setAssign] = useState({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!groups2015 || !players2015.length) return;
    if (dirty) return;
    setAssign(assignmentFromGroups(groups2015, players2015));
  }, [groups2015, players2015, dirty, revision]);

  const sorted2015 = useMemo(() => {
    return [...players2015].sort((a, b) => {
      const ga = assign[a.id] || "A";
      const gb = assign[b.id] || "A";
      if (ga !== gb) return ga.localeCompare(gb);
      return a.name.localeCompare(b.name, "sv");
    });
  }, [players2015, assign]);

  const namesInGroup = (letter) =>
    players2015
      .filter((p) => (assign[p.id] || "A") === letter)
      .sort((a, b) => a.name.localeCompare(b.name, "sv"));

  if (players2015.length !== 9) {
    return (
      <p className="empty-hint">
        Exakt nio spelare födda 2015 krävs för att hantera grupperna A, B och C (tre per grupp).
      </p>
    );
  }

  return (
    <div className="group-editor">
      <p className="panel__lead" style={{ marginTop: 0 }}>
        Tre per grupp. Spara efter ändring.
      </p>

      <div className="group-grid" aria-label="Översikt grupp A B C">
        {["A", "B", "C"].map((letter) => (
          <div key={letter} className="group-pillar">
            <h4 className="group-pillar__title">Grupp {letter}</h4>
            <ul>
              {namesInGroup(letter).map((p) => (
                <li key={p.id}>{p.name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <h4 className="panel__title" style={{ fontSize: 15, margin: "16px 0 8px" }}>
        Ändra grupper
      </h4>
      <div className="group-editor__table-wrap">
        <table className="group-editor__table">
          <thead>
            <tr>
              <th>Grupp</th>
              <th>Spelare</th>
            </tr>
          </thead>
          <tbody>
            {sorted2015.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 120 }}>
                  <select
                    className="field__select"
                    style={{ maxWidth: "100%" }}
                    value={assign[p.id] || "A"}
                    onChange={(e) => {
                      setDirty(true);
                      setAssign((prev) => ({ ...prev, [p.id]: e.target.value }));
                    }}
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </select>
                </td>
                <td>{p.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn btn--primary"
        style={{ marginTop: 14 }}
        onClick={async () => {
          const A = [];
          const B = [];
          const C = [];
          for (const p of players2015) {
            const g = assign[p.id] || "A";
            if (g === "A") A.push(p.id);
            else if (g === "B") B.push(p.id);
            else C.push(p.id);
          }
          if (A.length !== 3 || B.length !== 3 || C.length !== 3) {
            setErr("Varje grupp måste ha exakt tre spelare.");
            return;
          }
          setErr("");
          try {
            await api("/api/groups2015", { method: "PUT", body: { A, B, C } });
            setDirty(false);
            await load();
          } catch (x) {
            setErr(x.message);
          }
        }}
      >
        Spara grupper
      </button>
    </div>
  );
}

function Groups2016Editor({ groups2016, groups2016Extra, players2016, load, setErr, revision }) {
  const [assign, setAssign] = useState({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!groups2016 || !players2016.length) return;
    if (dirty) return;
    setAssign(assignmentFromGroups2016(groups2016, groups2016Extra, players2016));
  }, [groups2016, groups2016Extra, players2016, dirty, revision]);

  const sorted2016 = useMemo(() => {
    return [...players2016].sort((a, b) => {
      const ga = assign[a.id] || "A";
      const gb = assign[b.id] || "A";
      if (ga !== gb) return ga.localeCompare(gb);
      return a.name.localeCompare(b.name, "sv");
    });
  }, [players2016, assign]);

  if (players2016.length < 9) {
    return (
      <p className="empty-hint">
        Minst nio spelare födda 2016 krävs för rotationsgrupper A, B och C (tre per grupp). Övriga 2016 hamnar i
        extra-listan när ni är tio eller fler.
      </p>
    );
  }

  return (
    <div className="group-editor">
      <p className="panel__lead" style={{ marginTop: 0 }}>
        Tre per grupp A/B/C för rotation vid P 11 med 2016-assist. Övriga 2016: välj &quot;Extra&quot;. Spara efter
        ändring.
      </p>

      <h4 className="panel__title" style={{ fontSize: 15, margin: "16px 0 8px" }}>
        Ändra grupper (2016)
      </h4>
      <div className="group-editor__table-wrap">
        <table className="group-editor__table">
          <thead>
            <tr>
              <th>Grupp</th>
              <th>Spelare</th>
            </tr>
          </thead>
          <tbody>
            {sorted2016.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 120 }}>
                  <select
                    className="field__select"
                    style={{ maxWidth: "100%" }}
                    value={assign[p.id] || "A"}
                    onChange={(e) => {
                      setDirty(true);
                      setAssign((prev) => ({ ...prev, [p.id]: e.target.value }));
                    }}
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                    <option value="X">Extra</option>
                  </select>
                </td>
                <td>{p.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn btn--primary"
        style={{ marginTop: 14 }}
        onClick={async () => {
          const A = [];
          const B = [];
          const C = [];
          const extra = [];
          for (const p of players2016) {
            const g = assign[p.id] || "A";
            if (g === "A") A.push(p.id);
            else if (g === "B") B.push(p.id);
            else if (g === "C") C.push(p.id);
            else extra.push(p.id);
          }
          if (A.length !== 3 || B.length !== 3 || C.length !== 3) {
            setErr("Grupp A, B och C ska ha exakt tre spelare vardera. Övriga ska ligga under Extra.");
            return;
          }
          setErr("");
          try {
            await api("/api/groups2016", { method: "PUT", body: { A, B, C, extra } });
            setDirty(false);
            await load();
          } catch (x) {
            setErr(x.message);
          }
        }}
      >
        Spara 2016-grupper
      </button>
    </div>
  );
}

function MatchCard({
  m,
  rotationView,
  players2015,
  players2016,
  state,
  playerName,
  load,
  setErr,
  groupsValid,
  coachNames = [],
  onCopied,
  cardTitle = "Match",
  displayNumber,
  getStoredTeamLogo,
}) {
  const squadMode = matchSquadMode(m);
  const series = typeof m.fixture?.series === "string" ? m.fixture.series : "";
  const isP11Series = series.includes("P 11");
  const assist2016Target = isP11Series ? p11Assist2016Count(m, state) : 0;
  const n15 = m.selectedPlayerIds.filter((id) => players2015.some((p) => p.id === id)).length;
  const n16 = m.selectedPlayerIds.length - n15;
  const [showManual, setShowManual] = useState(false);
  const [manualIds, setManualIds] = useState([]);
  const [showManual2016, setShowManual2016] = useState(false);
  const [manual2016Ids, setManual2016Ids] = useState([]);
  const [assistDraft, setAssistDraft] = useState(() => String(m.fixture?.p11Assist2016 ?? 0));
  const [commentName, setCommentName] = useState(() => coachNames[0] || "Jonas");
  const [commentText, setCommentText] = useState("");
  const [noteDraft, setNoteDraft] = useState(m.note || "");
  const [formationDraft, setFormationDraft] = useState(() => ({
    defenders: Number(m.lineup?.formation?.defenders || 2),
    midfielders: Number(m.lineup?.formation?.midfielders || 2),
    attackers: Number(m.lineup?.formation?.attackers || 2),
  }));
  const sideDraft = "vänster";
  const [matchSubTab, setMatchSubTab] = useState("squad");
  const [positionDraftByPlayer, setPositionDraftByPlayer] = useState({});

  useEffect(() => {
    setAssistDraft(String(m.fixture?.p11Assist2016 ?? 0));
  }, [m.fixture?.p11Assist2016, m.id]);
  useEffect(() => {
    setNoteDraft(m.note || "");
  }, [m.note, m.id]);
  useEffect(() => {
    const formation = {
      defenders: Number(m.lineup?.formation?.defenders || 2),
      midfielders: Number(m.lineup?.formation?.midfielders || 2),
      attackers: Number(m.lineup?.formation?.attackers || 2),
    };
    setFormationDraft(formation);
    const slots = buildOutfieldSlots(formation);
    const next = {};
    for (const p of (m.selectedPlayerIds || []).map((id) => state.players.find((x) => x.id === id)).filter(Boolean)) {
      next[p.id] = "bench";
    }
    for (const row of m.lineup?.starters || []) {
      if (!row?.playerId) continue;
      if (row.role === "goalkeeper") {
        next[row.playerId] = "gk";
        continue;
      }
      const slot = slots.find((s) => s.role === row.role && Number(s.order) === Number(row.order));
      if (slot) next[row.playerId] = slot.key;
    }
    setPositionDraftByPlayer(next);
  }, [m.id, m.lineup, m.selectedPlayerIds, state.players]);
  useEffect(() => {
    setMatchSubTab("squad");
  }, [m.id]);
  useEffect(() => {
    if (coachNames.length && !coachNames.includes(commentName)) {
      setCommentName(coachNames[0]);
    }
  }, [coachNames, commentName]);

  const toggle2015 = (id) => {
    setManualIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });
  };

  const atLimit = manualIds.length >= 3;

  const toggle2016 = (id) => {
    const max = assist2016Target;
    if (max <= 0) return;
    setManual2016Ids((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= max) return prev;
      return [...prev, id];
    });
  };

  const p11Manual2016Ok = !showManual2016 || manual2016Ids.length === assist2016Target;
  const matchNo = displayNumber ?? m.number;
  const selectedRows = m.selectedPlayerIds
    .map((id) => state.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.birthYear !== b.birthYear) return a.birthYear - b.birthYear;
      return a.name.localeCompare(b.name, "sv");
    });
  const outfieldSlots = useMemo(() => buildOutfieldSlots(formationDraft), [formationDraft]);
  const formationTotal = Number(formationDraft.defenders || 0) + Number(formationDraft.midfielders || 0) + Number(formationDraft.attackers || 0);
  const slotToPlayer = useMemo(() => {
    const map = {};
    for (const [playerId, slotKey] of Object.entries(positionDraftByPlayer || {})) {
      if (!slotKey || slotKey === "bench") continue;
      if (!map[slotKey]) map[slotKey] = playerId;
    }
    return map;
  }, [positionDraftByPlayer]);
  const starterIds = Object.values(slotToPlayer).filter(Boolean);
  const startersUnique = new Set(starterIds).size === starterIds.length;
  const startersReady = Boolean(slotToPlayer.gk) && outfieldSlots.every((slot) => Boolean(slotToPlayer[slot.key])) && startersUnique;
  const selectedById = useMemo(() => {
    const map = new Map();
    for (const p of selectedRows) map.set(p.id, p);
    return map;
  }, [selectedRows]);
  const benchPlayers = useMemo(
    () => selectedRows.filter((p) => (positionDraftByPlayer[p.id] || "bench") === "bench"),
    [selectedRows, positionDraftByPlayer],
  );

  const names2015 = selectedRows.filter((p) => p.birthYear === 2015).map((p) => p.name);
  const names2016 = selectedRows.filter((p) => p.birthYear === 2016).map((p) => p.name);

  const copyTeam = async () => {
    const lines = [];
    lines.push(`${cardTitle} ${matchNo}`);
    if (m.intendedGroup2015) lines.push(`Grupp: ${m.intendedGroup2015}`);
    lines.push("");
    lines.push("2015:");
    if (names2015.length) lines.push(...names2015);
    else lines.push("—");
    lines.push("");
    lines.push("2016:");
    if (names2016.length) lines.push(...names2016);
    else lines.push("—");
    if (Array.isArray(m.comments) && m.comments.length) {
      lines.push("");
      lines.push("Kommentarer:");
      for (const c of m.comments) lines.push(`- ${c.name} (${formatTimestampSv(c.timestamp)}): ${c.text}`);
    }
    if ((m.note || "").trim()) {
      lines.push("");
      lines.push(`Notis: ${(m.note || "").trim()}`);
    }
    if (m.lineup?.starters?.length) {
      lines.push("");
      lines.push(`Startuppställning (${m.lineup.formation?.defenders || 0}-${m.lineup.formation?.midfielders || 0}-${m.lineup.formation?.attackers || 0})`);
      const starters = [...(m.lineup.starters || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      for (const s of starters) {
        lines.push(`- ${roleLabelSv(s.role)} ${s.lane || "central"}: ${playerName(s.playerId)}`);
      }
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setErr("");
    if (typeof onCopied === "function") onCopied("Lag kopierat till urklipp.");
  };

  const togglePlayerAvailability = async (player) => {
    setErr("");
    try {
      await api(`/api/players/${player.id}`, {
        method: "PUT",
        body: { available: player.available === false },
      });
      await load({ silent: true });
    } catch (x) {
      setErr(x.message);
    }
  };

  return (
    <article className="match-card">
      {m.fixture ? <MinFotbollFixture fixture={m.fixture} getStoredTeamLogo={getStoredTeamLogo} /> : null}
      <div className="match-card__inner">
      <div className="match-card__head match-card__headrow">
        <h3 className="match-card__label">
          {cardTitle} {matchNo}
        </h3>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {m.status === "played" ? (
            <span className="badge badge--success">Genomförd</span>
          ) : m.selectedPlayerIds?.length ? (
            <span className="badge badge--info">Trupp vald</span>
          ) : (
            <span className="badge badge--muted">Kommande</span>
          )}
          {m.status === "played" && (
            <button
              type="button"
              className="btn btn--plain"
              style={{ minHeight: 36, fontSize: 15, padding: "6px 10px" }}
              onClick={async () => {
                if (
                  !confirm(
                    "Ångra match? Den tas bort från historiken som genomförd, matchräknare minskas för valda spelare och grupprotationen följer åter de kvarvarande genomförda matcherna."
                  )
                )
                  return;
                setErr("");
                try {
                  await api(`/api/matches/${m.id}/reopen`, { method: "POST" });
                  await load();
                } catch (x) {
                  setErr(x.message);
                }
              }}
            >
              Ångra match
            </button>
          )}
        </div>
      </div>

      {m.intendedGroup2015 && (
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600 }}>
          Grupp 2015 (rotation): {groupLabelDisp(m.intendedGroup2015)}
        </p>
      )}
      {squadMode === "p11Mixed" && m.intendedGroup2016 && (
        <p style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600 }}>
          Grupp 2016 (rotation assist): {groupLabelDisp(m.intendedGroup2016)}
        </p>
      )}

      <div className="segmented segmented--nested segmented--match-tabs" role="tablist" aria-label="Matchdetaljer">
        <button
          type="button"
          role="tab"
          className="segmented__btn"
          aria-selected={matchSubTab === "squad"}
          onClick={() => setMatchSubTab("squad")}
        >
          Trupp
        </button>
        <button
          type="button"
          role="tab"
          className="segmented__btn"
          aria-selected={matchSubTab === "lineup"}
          onClick={() => setMatchSubTab("lineup")}
        >
          Laguppställning
        </button>
        <button
          type="button"
          role="tab"
          className="segmented__btn"
          aria-selected={matchSubTab === "notes"}
          onClick={() => setMatchSubTab("notes")}
        >
          Notis & kommentarer
        </button>
      </div>

      {matchSubTab === "squad" && <div className="match-card__body">
        {m.selectedPlayerIds.length > 0 ? (
          <>
            <p className="match-card__lineup-meta">
              <strong>{m.selectedPlayerIds.length}</strong> spelare
              {(n15 > 0 || n16 > 0) && (
                <span className="match-card__lineup-breakdown">
                  {" "}
                  ·{" "}
                  {[n15 > 0 ? `${n15} födda 2015` : null, n16 > 0 ? `${n16} födda 2016` : null].filter(Boolean).join(" · ")}
                </span>
              )}
            </p>
            <MatchLineupNames
              playerIds={m.selectedPlayerIds}
              players={state.players}
              canToggleAvailability={m.status !== "played"}
              onToggleAvailability={(p) => {
                togglePlayerAvailability(p).catch(() => null);
              }}
            />
          </>
        ) : (
          <p className="text-muted">Inget uttag</p>
        )}
      </div>}

      {matchSubTab === "lineup" && m.selectedPlayerIds.length > 0 && (
        <div className="group group--flush lineup-panel" style={{ marginBottom: 12 }}>
          <h4 className="panel__title" style={{ fontSize: 15, margin: "0 0 8px" }}>
            Startuppställning (1 målvakt + 6 utespelare)
          </h4>
          <div className="lineup-formation-wrap" style={{ marginBottom: 10 }}>
            <div className="field">
              <span className="field__label">Formation (F-M-A)</span>
              <div className="lineup-formation-grid">
                <input
                  className="field__select"
                  type="number"
                  min={1}
                  max={5}
                  value={formationDraft.defenders}
                  onChange={(e) => setFormationDraft((f) => ({ ...f, defenders: Number(e.target.value || 0) }))}
                />
                <input
                  className="field__select"
                  type="number"
                  min={0}
                  max={5}
                  value={formationDraft.midfielders}
                  onChange={(e) => setFormationDraft((f) => ({ ...f, midfielders: Number(e.target.value || 0) }))}
                />
                <input
                  className="field__select"
                  type="number"
                  min={0}
                  max={5}
                  value={formationDraft.attackers}
                  onChange={(e) => setFormationDraft((f) => ({ ...f, attackers: Number(e.target.value || 0) }))}
                />
              </div>
            </div>
          </div>
          {formationTotal !== 6 ? (
            <p className="text-muted">Summan av försvar + mittfält + anfall måste vara 6.</p>
          ) : (
            <>
              <div className="lineup-dnd-help">Velg posisjon for hver spiller. Smart-fyll bruker spillerens foretrukne posisjon.</div>
              <div className="btn-row" style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => {
                    const remaining = [...selectedRows];
                    const slotOrder = ["gk", ...outfieldSlots.map((s) => s.key)];
                    const next = {};
                    const pickOne = (predicate) => {
                      const idx = remaining.findIndex(predicate);
                      if (idx < 0) return null;
                      const [p] = remaining.splice(idx, 1);
                      return p;
                    };
                    const gk = pickOne((p) => /målvakt/i.test(p.preferredPosition || "")) || remaining.shift() || null;
                    if (gk) next[gk.id] = "gk";
                    for (const slotKey of slotOrder.slice(1)) {
                      const slot = outfieldSlots.find((s) => s.key === slotKey);
                      if (!slot) continue;
                      const pref =
                        slot.role === "defender"
                          ? /försvar/i
                          : slot.role === "midfielder"
                            ? /mittfält/i
                            : /anfall/i;
                      const player = pickOne((p) => pref.test(p.preferredPosition || "")) || pickOne((p) => /allround/i.test(p.preferredPosition || "")) || remaining.shift() || null;
                      if (player) next[player.id] = slotKey;
                    }
                    for (const p of remaining) next[p.id] = "bench";
                    setPositionDraftByPlayer((prev) => ({ ...prev, ...next }));
                  }}
                >
                  Smart fyll
                </button>
              </div>
              <div className="lineup-player-grid">
                {selectedRows.map((p) => (
                  <div key={`pos-${p.id}`} className="field">
                    <span className="field__label">
                      {p.name} {p.jerseyNumber ? `#${p.jerseyNumber}` : ""}
                    </span>
                    <select
                      className="field__select"
                      value={positionDraftByPlayer[p.id] || "bench"}
                      onChange={(e) =>
                        setPositionDraftByPlayer((prev) => ({
                          ...prev,
                          [p.id]: e.target.value,
                        }))
                      }
                    >
                      <option value="bench">Bänk</option>
                      <option value="gk">Målvakt</option>
                      {outfieldSlots.map((slot) => (
                        <option key={`opt-${slot.key}`} value={slot.key}>
                          {slotLabelFromKey(slot.key, outfieldSlots)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              {!startersUnique ? <p className="text-muted">En position kan bara ha en spelare. Välj unika positioner.</p> : null}
              {benchPlayers.length > 0 ? (
                <p className="text-muted">Bänk: {benchPlayers.map((p) => p.name).join(", ")}</p>
              ) : null}
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={formationTotal !== 6 || !startersReady}
                  onClick={async () => {
                    setErr("");
                    try {
                      const starters = [
                        { playerId: slotToPlayer.gk, role: "goalkeeper", lane: "central", order: 0 },
                        ...outfieldSlots.map((slot) => ({
                          playerId: slotToPlayer[slot.key],
                          role: slot.role,
                          lane: slot.lane,
                          order: slot.order,
                        })),
                      ];
                      await api(`/api/matches/${m.id}/lineup`, {
                        method: "PUT",
                        body: {
                          formation: formationDraft,
                          side: sideDraft,
                          starters,
                          substitutions: [],
                        },
                      });
                      await load();
                    } catch (x) {
                      setErr(x.message);
                    }
                  }}
                >
                  Spara startuppställning
                </button>
              </div>
              <div className="lineup-pitch" aria-label="Startelva på fotbollsplan">
                <div className="lineup-pitch__surface">
                  <div className="lineup-pitch__half" />
                  <div className="lineup-pitch__circle" />
                  <div className="lineup-pitch__box lineup-pitch__box--top" />
                  <div className="lineup-pitch__box lineup-pitch__box--bottom" />
                  {[{ key: "gk", role: "goalkeeper", x: 50, y: 86 }, ...outfieldSlots.map((slot) => ({
                    key: slot.key,
                    role: slot.role,
                    x: slot.lane === "vänster" ? 24 : slot.lane === "höger" ? 76 : 50,
                    y: slot.role === "defender" ? 66 : slot.role === "midfielder" ? 48 : 30,
                  }))].map((slotNode) => {
                    const playerId = slotToPlayer[slotNode.key];
                    const player = playerId ? selectedById.get(playerId) : null;
                    return (
                      <div
                        key={slotNode.key}
                        className={`lineup-pitch__slot lineup-pitch__slot--${slotNode.role} ${player ? "is-filled" : ""}`}
                        style={{ left: `${slotNode.x}%`, top: `${slotNode.y}%` }}
                        title={player ? `${player.name}${player.jerseyNumber ? ` (#${player.jerseyNumber})` : ""}` : roleLabelSv(slotNode.role)}
                      >
                        {player ? (
                          <div className={`lineup-pitch__player lineup-pitch__player--${slotNode.role}`}>
                            <span className="lineup-pitch__number">{player.jerseyNumber || "?"}</span>
                            <span className="lineup-pitch__name">{player.name}</span>
                          </div>
                        ) : (
                          <span className="lineup-pitch__empty">{roleLabelSv(slotNode.role)}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="lineup-pitch__meta">
                  Formation {formationDraft.defenders}-{formationDraft.midfielders}-{formationDraft.attackers}
                </p>
              </div>
            </>
          )}
        </div>
      )}
      {matchSubTab === "lineup" && m.selectedPlayerIds.length === 0 && <p className="text-muted">Välj lag först för att sätta laguppställning.</p>}

      {matchSubTab === "notes" && <div className="match-comments" aria-label="Kommentarer">
        <h4 className="panel__title" style={{ fontSize: 15, margin: "0 0 8px" }}>
          Notis
        </h4>
        <div className="match-comments__form" style={{ marginBottom: 10 }}>
          <textarea
            className="field__input"
            rows={2}
            placeholder="Kort intern notis för matchen"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={async () => {
              setErr("");
              try {
                await api(`/api/matches/${m.id}/note`, {
                  method: "PUT",
                  body: { note: noteDraft },
                });
                await load();
              } catch (x) {
                setErr(x.message);
              }
            }}
          >
            Spara notis
          </button>
        </div>

        <h4 className="panel__title" style={{ fontSize: 15, margin: "0 0 8px" }}>
          Kommentarer
        </h4>
        <div className="match-comments__form">
          <select className="field__select" value={commentName} onChange={(e) => setCommentName(e.target.value)}>
            {(coachNames.length ? coachNames : ["Jonas", "Per", "Anders", "Kim"]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <textarea
            className="field__input"
            rows={3}
            placeholder="Skriv kommentar (t.ex. sjukdom, transport, byten)"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={async () => {
              const t = commentText.trim();
              if (!t) return;
              setErr("");
              try {
                await api(`/api/matches/${m.id}/comments`, {
                  method: "POST",
                  body: { name: commentName, text: t },
                });
                setCommentText("");
                await load();
              } catch (x) {
                setErr(x.message);
              }
            }}
          >
            Lägg till kommentar
          </button>
        </div>
        <div className="match-comments__list">
          {(m.comments || []).length === 0 ? (
            <p className="text-muted">Inga kommentarer.</p>
          ) : (
            [...(m.comments || [])].reverse().map((c, i) => (
              <p key={`${c.timestamp}-${i}`} className="match-comments__item">
                <strong>{c.name}</strong> ({formatTimestampSv(c.timestamp)}): {c.text}
              </p>
            ))
          )}
        </div>
      </div>}

      {matchSubTab === "squad" && m.status !== "played" && isP11Series && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 15, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            Antal födda 2016 (P 11-assist)
            <input
              type="number"
              min={0}
              max={20}
              className="field__select"
              style={{ width: 88 }}
              value={assistDraft}
              onChange={(e) => setAssistDraft(e.target.value)}
              onBlur={async () => {
                const n = Math.floor(Number(assistDraft));
                const v = Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 0;
                setAssistDraft(String(v));
                setErr("");
                try {
                  await api(`/api/matches/${m.id}/fixture`, { method: "PUT", body: { p11Assist2016: v } });
                  await load();
                } catch (x) {
                  setErr(x.message);
                }
              }}
            />
          </label>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted-foreground)" }}>
            0 = endast 2015. När antalet är 1–20 föreslår appen nästa i kön utifrån 2016-grupper A/B/C. Spara genom att lämna fältet (blur) eller tryck Tab.
          </p>
        </div>
      )}

      {matchSubTab === "squad" && m.status !== "played" && squadMode === "mixed" && (
        <div style={{ marginBottom: 12 }}>
          <label className="cb-row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showManual}
              onChange={(e) => {
                const on = e.target.checked;
                setShowManual(on);
                if (on && rotationView?.canonical2015Ids?.length) {
                  const avail = rotationView.canonical2015Ids.filter((id) => {
                    const pl = players2015.find((x) => x.id === id);
                    return pl && pl.available !== false;
                  });
                  setManualIds(avail.length ? [...avail] : []);
                } else if (!on) {
                  setManualIds([]);
                }
              }}
            />
            <span style={{ fontSize: 15 }}>Manuellt urval 2015 (max 3)</span>
          </label>
          {showManual && (
            <div className="cb-grid">
              {players2015.map((p) => (
                <label
                  key={p.id}
                  className="cb-row"
                  style={{ cursor: p.available === false ? "not-allowed" : "pointer", opacity: p.available === false ? 0.45 : 1 }}
                >
                  <input
                    type="checkbox"
                    checked={manualIds.includes(p.id)}
                    disabled={p.available === false || (!manualIds.includes(p.id) && atLimit)}
                    onChange={() => {
                      if (p.available === false) return;
                      toggle2015(p.id);
                    }}
                  />
                  <span>
                    {p.name}{" "}
                    <span style={{ color: "var(--text-secondary)" }}>({p.birthYear})</span>
                    {p.available === false && (
                      <span style={{ color: "var(--danger)", fontSize: 13 }}> · Ej tillgänglig</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {matchSubTab === "squad" && m.status !== "played" && squadMode === "p11Mixed" && assist2016Target > 0 && (
        <div style={{ marginBottom: 12 }}>
          <label className="cb-row" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showManual2016}
              onChange={(e) => {
                const on = e.target.checked;
                setShowManual2016(on);
                if (on) {
                  const avail = players2016.filter((pl) => pl.available !== false).map((pl) => pl.id);
                  const canon = (rotationView?.canonical2016Ids || []).filter((id) => avail.includes(id));
                  const rest = avail
                    .filter((id) => !canon.includes(id))
                    .sort((a, b) => playerName(a).localeCompare(playerName(b), "sv"));
                  const seed = [...canon, ...rest].slice(0, assist2016Target);
                  setManual2016Ids(seed.length ? seed : []);
                } else {
                  setManual2016Ids([]);
                }
              }}
            />
            <span style={{ fontSize: 15 }}>
              Manuellt urval 2016 ({assist2016Target} spelare)
            </span>
          </label>
          {showManual2016 && (
            <div className="cb-grid">
              {players2016.map((p) => (
                <label
                  key={p.id}
                  className="cb-row"
                  style={{ cursor: p.available === false ? "not-allowed" : "pointer", opacity: p.available === false ? 0.45 : 1 }}
                >
                  <input
                    type="checkbox"
                    checked={manual2016Ids.includes(p.id)}
                    disabled={
                      p.available === false ||
                      (!manual2016Ids.includes(p.id) && manual2016Ids.length >= assist2016Target)
                    }
                    onChange={() => {
                      if (p.available === false) return;
                      toggle2016(p.id);
                    }}
                  />
                  <span>
                    {p.name}{" "}
                    <span style={{ color: "var(--text-secondary)" }}>({p.birthYear})</span>
                    {p.available === false && (
                      <span style={{ color: "var(--danger)", fontSize: 13 }}> · Ej tillgänglig</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {matchSubTab === "squad" && <div className="match-card__actions">
        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={
            m.status === "played" ||
            groupsValid === false ||
            (squadMode === "p11Mixed" && showManual2016 && !p11Manual2016Ok)
          }
          onClick={async () => {
            setErr("");
            try {
              const body = {};
              if (squadMode === "mixed" && showManual && manualIds.length) {
                body.override2015PlayerIds = manualIds;
              }
              if (squadMode === "p11Mixed" && showManual2016 && manual2016Ids.length) {
                body.override2016PlayerIds = manual2016Ids;
              }
              await api(`/api/matches/${m.id}/select`, {
                method: "POST",
                body: Object.keys(body).length ? body : undefined,
              });
              await load();
            } catch (x) {
              setErr(x.message);
            }
          }}
        >
          Välj lag
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          disabled={m.status === "played" || !m.selectedPlayerIds.length}
          onClick={async () => {
            setErr("");
            try {
              await api(`/api/matches/${m.id}/complete`, { method: "POST" });
              await load();
            } catch (x) {
              setErr(x.message);
            }
          }}
        >
          Markera som genomförd
        </button>
        <button
          type="button"
          className="btn btn--secondary btn--block"
          disabled={!m.selectedPlayerIds.length}
          onClick={() => {
            copyTeam().catch((e) => setErr(e.message));
          }}
        >
          Kopiera lag
        </button>
      </div>}
      </div>
    </article>
  );
}

export default function App() {
  const [state, setState] = useState(null);
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("matches");
  const [form, setForm] = useState({ name: "", birthYear: "2016", jerseyNumber: "", preferredPosition: "" });
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editYear, setEditYear] = useState("2016");
  const [editJerseyNumber, setEditJerseyNumber] = useState("");
  const [editPreferredPosition, setEditPreferredPosition] = useState("");
  const [overviewBirth, setOverviewBirth] = useState("all");
  const [overviewAge, setOverviewAge] = useState("all");
  /** Underflikar inom Spelargrupp: spelarlista, grupper eller tränare */
  const [playerSubTab, setPlayerSubTab] = useState("players");
  /** Underflikar inom Matcher: P10 / P11 */
  const [activeMatchId, setActiveMatchId] = useState(null);
  const [showMatchCalendar, setShowMatchCalendar] = useState(false);
  const [playersSort, setPlayersSort] = useState({ key: "birthYear", dir: "asc" });
  const [importing, setImporting] = useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);
  const [installHint, setInstallHint] = useState("");
  const [icsUrl, setIcsUrl] = useState(DEFAULT_MINFOTBOLL_ICS_URL);
  const [syncingIcs, setSyncingIcs] = useState(false);
  const [coachesDraft, setCoachesDraft] = useState([]);
  const [coachesDraftDirty, setCoachesDraftDirty] = useState(false);
  const [buildInfo, setBuildInfo] = useState(null);
  const cachedSnapshotRef = useRef(null);
  const restoringSettingsRef = useRef(false);
  const restoredSettingsRef = useRef(false);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      const triggerUpdate = () => registration.update().catch(() => null);
      triggerUpdate();
      // Keep PWA clients in sync with the latest deploy.
      const intervalId = window.setInterval(triggerUpdate, 60 * 1000);
      window.addEventListener("focus", triggerUpdate);
      document.addEventListener("visibilitychange", triggerUpdate);
      return () => {
        window.clearInterval(intervalId);
        window.removeEventListener("focus", triggerUpdate);
        document.removeEventListener("visibilitychange", triggerUpdate);
      };
    },
  });

  const load = useCallback(async (opts = {}) => {
    if (!opts.silent) setErr("");
    const s = await api("/api/state");
    setState(() => s);
    return s;
  }, []);

  useEffect(() => {
    let hasCachedState = false;
    try {
      const cached = localStorage.getItem(LS_STATE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.matches && parsed.players) {
          setState(parsed);
          cachedSnapshotRef.current = parsed;
          hasCachedState = true;
          setLoading(false);
        }
      }
      const ui = localStorage.getItem(LS_UI_KEY);
      if (ui) {
        const parsedUi = JSON.parse(ui);
        if (parsedUi?.playerSubTab) setPlayerSubTab(parsedUi.playerSubTab);
        if (parsedUi?.overviewBirth) setOverviewBirth(parsedUi.overviewBirth);
        if (parsedUi?.overviewAge) setOverviewAge(parsedUi.overviewAge);
        if (parsedUi?.activeMatchId) setActiveMatchId(parsedUi.activeMatchId);
        if (parsedUi?.icsUrl) setIcsUrl(parsedUi.icsUrl);
      }
    } catch {
      // Ignorera trasig localStorage och fortsätt med API.
    }
    load()
      .catch((e) => {
        if (!hasCachedState) setErr(e.message);
      })
      .finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (!needRefresh) return;
    // Avoid stale UI from lingering service workers in installed app mode.
    const timer = window.setTimeout(() => {
      updateServiceWorker(true);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [needRefresh, updateServiceWorker]);

  useEffect(() => {
    api('/api/version')
      .then((meta) => setBuildInfo(meta))
      .catch(() => setBuildInfo(null));
  }, []);

  useEffect(() => {
    if (!state || restoredSettingsRef.current || restoringSettingsRef.current) return;
    const cached = cachedSnapshotRef.current;
    if (!cached) return;

    const cachedCoaches = Array.isArray(cached.coaches) ? cached.coaches.filter((c) => String(c?.name || "").trim()) : [];
    const cachedLogos = cached.teamLogos && typeof cached.teamLogos === "object" ? cached.teamLogos : {};
    const cachedLogoEntries = Object.entries(cachedLogos).filter(([, v]) => typeof v === "string" && v.trim());

    const serverCoaches = Array.isArray(state.coaches) ? state.coaches.filter((c) => String(c?.name || "").trim()) : [];
    const serverLogos = state.teamLogos && typeof state.teamLogos === "object" ? state.teamLogos : {};
    const serverLogoCount = Object.keys(serverLogos).length;

    const serverCoachNames = serverCoaches.map((c) => c.name);
    const serverIsDefaultCoaches =
      serverCoachNames.length === DEFAULT_COACH_NAMES.length &&
      DEFAULT_COACH_NAMES.every((n, i) => serverCoachNames[i] === n);

    const shouldRestoreCoaches = cachedCoaches.length > 0 && (serverCoaches.length === 0 || serverIsDefaultCoaches);
    const shouldRestoreLogos = cachedLogoEntries.length > 0 && serverLogoCount === 0;

    if (!shouldRestoreCoaches && !shouldRestoreLogos) {
      restoredSettingsRef.current = true;
      return;
    }

    restoringSettingsRef.current = true;
    (async () => {
      try {
        if (shouldRestoreCoaches) {
          await api("/api/settings/coaches", { method: "PUT", body: { coaches: cachedCoaches } });
        }
        if (shouldRestoreLogos) {
          for (const [team, logoDataUrl] of cachedLogoEntries) {
            await api("/api/team-logos", { method: "PUT", body: { team, logoDataUrl } });
          }
        }
        await load({ silent: true });
      } catch {
        // Låt appen fungera vidare även om återställning misslyckas.
      } finally {
        restoringSettingsRef.current = false;
        restoredSettingsRef.current = true;
      }
    })();
  }, [state, load]);

  useEffect(() => {
    const onFocus = () => {
      load({ silent: true }).catch(() => null);
    };
    const onOnline = () => {
      load({ silent: true }).catch(() => null);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    const timer = setInterval(() => {
      if (navigator.onLine) load({ silent: true }).catch(() => null);
    }, 15000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!state) return;
    try {
      localStorage.setItem(LS_STATE_KEY, JSON.stringify(state));
    } catch {
      // Ignorera quota/serialization-fel.
    }
  }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem(
        LS_UI_KEY,
        JSON.stringify({ playerSubTab, overviewBirth, overviewAge, activeMatchId, icsUrl }),
      );
    } catch {
      // Ignorera localStorage-fel.
    }
  }, [playerSubTab, overviewBirth, overviewAge, activeMatchId, icsUrl]);

  useEffect(() => {
    const incoming = Array.isArray(state?.coaches)
      ? state.coaches
      : Array.isArray(state?.coachNames)
        ? state.coachNames.map((name, i) => ({ id: `coach-${i + 1}`, name, phone: "", role: "", note: "" }))
        : [];
    if (coachesDraftDirty) return;
    setCoachesDraft(
      incoming.map((c, i) => ({
        id: c?.id ? String(c.id) : `coach-${i + 1}`,
        name: String(c?.name || ""),
        phone: String(c?.phone || ""),
        role: String(c?.role || ""),
        note: String(c?.note || ""),
      })),
    );
  }, [state?.coaches, state?.coachNames, coachesDraftDirty]);

  useEffect(() => {
    if (!okMsg) return;
    const t = setTimeout(() => setOkMsg(""), 1800);
    return () => clearTimeout(t);
  }, [okMsg]);

  useEffect(() => {
    const onBeforeInstall = (e) => {
      e.preventDefault();
      setDeferredInstallPrompt(e);
      setInstallHint("");
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  const playersSorted = state
    ? [...state.players].sort((a, b) => {
        if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
        return a.name.localeCompare(b.name, "sv");
      })
    : [];

  const uniqueAges = state
    ? [...new Set(state.players.map((p) => playerAge(p.birthYear)))].sort((a, b) => a - b)
    : [];

  const playersOverview = playersSorted.filter((p) => {
    if (overviewBirth !== "all" && p.birthYear !== Number(overviewBirth)) return false;
    if (overviewAge !== "all" && playerAge(p.birthYear) !== Number(overviewAge)) return false;
    return true;
  });

  const matchesCompleted = state ? state.matches.filter((m) => m.status === "played").length : 0;
  const matchesTotal = state ? state.matches.length : 0;
  const rotationView = state?.rotationView;

  const matchesCalendar = useMemo(() => {
    const arr = (state?.matches || []).filter((m) => parseIsoDateLocal(m.fixture?.date));
    return [...arr].sort(compareMatchesChronologically);
  }, [state?.matches]);
  const calendarMonthKeys = useMemo(() => {
    const keys = new Set();
    const now = new Date();
    const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);
    keys.add(monthKeyOf(currentMonthDate));
    for (const m of matchesCalendar) {
      const dt = parseIsoDateLocal(m.fixture?.date);
      if (!dt) continue;
      keys.add(monthKeyOf(new Date(dt.getFullYear(), dt.getMonth(), 1)));
    }
    return [...keys].sort();
  }, [matchesCalendar]);
  const [calendarMonthKey, setCalendarMonthKey] = useState(() => {
    const now = new Date();
    return monthKeyOf(new Date(now.getFullYear(), now.getMonth(), 1));
  });
  useEffect(() => {
    if (!calendarMonthKeys.length) return;
    if (calendarMonthKeys.includes(calendarMonthKey)) return;
    const now = new Date();
    const current = monthKeyOf(new Date(now.getFullYear(), now.getMonth(), 1));
    setCalendarMonthKey(calendarMonthKeys.includes(current) ? current : calendarMonthKeys[0]);
  }, [calendarMonthKeys, calendarMonthKey]);
  const visibleCalendarMonth = useMemo(() => {
    const parsed = parseMonthKey(calendarMonthKey);
    if (parsed) return parsed;
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  }, [calendarMonthKey]);
  const calendarMonthView = useMemo(() => {
    const { year, month } = visibleCalendarMonth;
    const monthMatches = matchesCalendar.filter((m) => {
      const dt = parseIsoDateLocal(m.fixture?.date);
      return dt && dt.getFullYear() === year && dt.getMonth() === month;
    });
    const matchesByDay = new Map();
    for (const m of monthMatches) {
      const dt = parseIsoDateLocal(m.fixture?.date);
      if (!dt) continue;
      const day = dt.getDate();
      if (!matchesByDay.has(day)) matchesByDay.set(day, []);
      matchesByDay.get(day).push(m);
    }
    const totalDays = daysInMonth(year, month);
    const first = new Date(year, month, 1);
    const lead = (first.getDay() + 6) % 7; // Måndag = 0
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= totalDays; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return {
      key: monthKeyOf(new Date(year, month, 1)),
      year,
      month,
      matchesByDay,
      cells,
    };
  }, [matchesCalendar, visibleCalendarMonth]);
  const players2015 = useMemo(
    () => (state?.players ? state.players.filter((p) => p.birthYear === 2015) : []),
    [state?.players]
  );
  const players2016 = useMemo(
    () => (state?.players ? state.players.filter((p) => p.birthYear === 2016) : []),
    [state?.players]
  );
  const sortedPlayersTable = useMemo(() => {
    const rows = [...(state?.players || [])];
    const dirMul = playersSort.dir === "desc" ? -1 : 1;
    const valueOf = (p, key) => {
      if (key === "name") return p.name || "";
      if (key === "jerseyNumber") return Number(p.jerseyNumber || 0);
      if (key === "preferredPosition") return p.preferredPosition || "";
      if (key === "birthYear") return Number(p.birthYear || 0);
      if (key === "group") return p.birthYear === 2015 ? groupLetterFor2015Player(p.id, state?.groups2015) || "" : "";
      if (key === "matchesPlayed") return Number(p.matchesPlayed || 0);
      if (key === "lastPlayedMatchNumber") return Number(p.lastPlayedMatchNumber || 0);
      if (key === "available") return p.available === false ? 0 : 1;
      return "";
    };
    rows.sort((a, b) => {
      const av = valueOf(a, playersSort.key);
      const bv = valueOf(b, playersSort.key);
      if (typeof av === "number" && typeof bv === "number") {
        if (av !== bv) return (av - bv) * dirMul;
      } else {
        const cmp = String(av).localeCompare(String(bv), "sv", { sensitivity: "base" });
        if (cmp !== 0) return cmp * dirMul;
      }
      return a.name.localeCompare(b.name, "sv");
    });
    return rows;
  }, [state?.players, state?.groups2015, playersSort]);

  const togglePlayersSort = useCallback((key) => {
    setPlayersSort((prev) => ({
      key,
      dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc",
    }));
  }, []);
  const sortMark = useCallback((key) => {
    if (playersSort.key !== key) return "";
    return playersSort.dir === "asc" ? " ↑" : " ↓";
  }, [playersSort]);

  const matchGroupsValid =
    rotationView?.groupsValid !== false && rotationView?.groups2016Valid !== false;

  const [simulation, setSimulation] = useState(null);
  const coachNames = useMemo(() => {
    if (Array.isArray(state?.coaches) && state.coaches.length) {
      return state.coaches.map((c) => c.name).filter(Boolean);
    }
    return state?.coachNames || ["Jonas", "Per", "Anders", "Kim"];
  }, [state?.coaches, state?.coachNames]);
  const teamNames = useMemo(() => {
    const set = new Set();
    for (const m of state?.matches || []) {
      if (m.fixture?.home) set.add(m.fixture.home);
      if (m.fixture?.away) set.add(m.fixture.away);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "sv"));
  }, [state?.matches]);
  const getStoredTeamLogo = useCallback(
    (teamName) => {
      if (!teamName) return "";
      const direct = state?.teamLogos?.[teamName];
      if (direct) return direct;
      const norm = normalizeTeamKey(teamName);
      return state?.teamLogos?.[norm] || "";
    },
    [state?.teamLogos],
  );

  useEffect(() => {
    if (!matchesCalendar.length) return;
    if (activeMatchId && matchesCalendar.some((m) => m.id === activeMatchId)) return;
    const firstInVisibleMonth = matchesCalendar.find((m) => {
      const dt = parseIsoDateLocal(m.fixture?.date);
      return (
        dt &&
        dt.getFullYear() === visibleCalendarMonth.year &&
        dt.getMonth() === visibleCalendarMonth.month
      );
    });
    setActiveMatchId((firstInVisibleMonth || matchesCalendar[0]).id);
  }, [matchesCalendar, activeMatchId, visibleCalendarMonth.year, visibleCalendarMonth.month]);
  const activeMatch = useMemo(
    () => matchesCalendar.find((m) => m.id === activeMatchId) || null,
    [matchesCalendar, activeMatchId],
  );
  const openMatchDetail = useCallback((matchId) => {
    setActiveMatchId(matchId);
    setShowMatchCalendar(false);
  }, []);

  function playerName(id) {
    return state?.players.find((p) => p.id === id)?.name ?? id;
  }
  function calendarStatus(m) {
    if (m.status === "played") return { label: "Spelad", cls: "calendar-match__dot--played" };
    if ((m.selectedPlayerIds || []).length) return { label: "Lag valt", cls: "calendar-match__dot--selected" };
    return { label: "Ej vald", cls: "calendar-match__dot--empty" };
  }

  function calendarOpponentName(m) {
    const home = m.fixture?.home || m.fixture?.homeTeam || "";
    const away = m.fixture?.away || m.fixture?.awayTeam || "";
    if (!home && !away) return "Motståndare saknas";
    if (/ifk\s*ölme/i.test(home) || /ifk\s*olme/i.test(home)) return away || home;
    if (/ifk\s*ölme/i.test(away) || /ifk\s*olme/i.test(away)) return home || away;
    return away || home;
  }

  function calendarTimeLabel(m) {
    if (!m.fixture?.time || m.fixture.time === "00:00") return "Tid ej satt";
    return m.fixture.time;
  }

  function calendarOpponentLogo(m) {
    const home = m.fixture?.home || m.fixture?.homeTeam || "";
    const away = m.fixture?.away || m.fixture?.awayTeam || "";
    const homeLogo = m.fixture?.homeLogo || getStoredTeamLogo(home);
    const awayLogo = m.fixture?.awayLogo || getStoredTeamLogo(away);
    if (/ifk\s*ölme/i.test(home) || /ifk\s*olme/i.test(home)) return { name: away, logoUrl: awayLogo };
    if (/ifk\s*ölme/i.test(away) || /ifk\s*olme/i.test(away)) return { name: home, logoUrl: homeLogo };
    return { name: away || home, logoUrl: awayLogo || homeLogo };
  }

  const calendarMonthIndex = Math.max(0, calendarMonthKeys.indexOf(calendarMonthView.key));
  const hasPrevCalendarMonth = calendarMonthIndex > 0;
  const hasNextCalendarMonth =
    calendarMonthIndex >= 0 && calendarMonthIndex < calendarMonthKeys.length - 1;

  async function installApp() {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      setDeferredInstallPrompt(null);
      return;
    }
    const ua = navigator.userAgent.toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua);
    if (isIos) {
      setInstallHint("Tryck på dela → Lägg till på hemskärmen");
    } else {
      setInstallHint("Tryck på meny → Installera app");
    }
  }

  async function syncFromMinFotboll() {
    setErr("");
    setSyncingIcs(true);
    try {
      const next = await api("/api/fixtures/sync-ics", {
        method: "POST",
        body: { url: icsUrl },
      });
      setState(next);
      const updated = Number(next?.sync?.updatedMatches || 0);
      const parsed = Number(next?.sync?.parsedEvents || 0);
      setOkMsg(`MinFotboll synkad: ${updated} matcher uppdaterade (${parsed} händelser lästa).`);
      if (next?.matches?.length) {
        const activeExists = next.matches.some((m) => m.id === activeMatchId);
        if (!activeExists) setActiveMatchId(next.matches[0].id);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setSyncingIcs(false);
    }
  }

  async function saveCoaches() {
    const cleaned = coachesDraft
      .map((c, i) => ({
        id: c?.id ? String(c.id) : `coach-${i + 1}`,
        name: String(c?.name || "").trim(),
        phone: String(c?.phone || "").trim(),
        role: String(c?.role || "").trim(),
        note: String(c?.note || "").trim(),
      }))
      .filter((c) => c.name);
    if (!cleaned.length) {
      setErr("Ange minst en tränare.");
      return;
    }
    setErr("");
    try {
      const next = await api("/api/settings/coaches", {
        method: "PUT",
        body: { coaches: cleaned },
      });
      setState(next);
      setCoachesDraftDirty(false);
      setOkMsg("Tränarlista uppdaterad.");
    } catch (e) {
      setErr(e.message);
    }
  }

  async function uploadTeamLogo(team, file) {
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Kunde inte läsa bildfilen."));
      reader.readAsDataURL(file);
    });
    const next = await api("/api/team-logos", {
      method: "PUT",
      body: { team, logoDataUrl: dataUrl },
    });
    setState(next);
    setOkMsg(`Logo sparad för ${team}.`);
  }

  async function clearTeamLogo(team) {
    const next = await api("/api/team-logos", {
      method: "PUT",
      body: { team, logoDataUrl: null },
    });
    setState(next);
    setOkMsg(`Logo borttagen för ${team}.`);
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportBackup() {
    if (!state) return;
    const date = new Date().toISOString().slice(0, 10);
    const base = `fotboll_backup_${date}`;

    const jsonBlob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json;charset=utf-8" });
    downloadBlob(`${base}.json`, jsonBlob);

    const wsPlayers = XLSX.utils.json_to_sheet(
      (state.players || []).map((p) => ({
        Namn: p.name,
        "Födelseår": p.birthYear,
        "Antal matcher": p.matchesPlayed,
        "Senast spelad match": p.lastPlayedMatchNumber ?? "—",
      })),
    );
    const wsMatches = XLSX.utils.json_to_sheet(
      (state.matches || []).map((m) => ({
        Match: m.matchNumber ?? m.number,
        "Grupp (2015)": m.group2015 ?? m.intendedGroup2015 ?? "—",
        "Spelare valda": (m.selectedPlayers || m.selectedPlayerIds || []).length,
        Status: m.status === "played" ? "Spelad" : (m.selectedPlayerIds || []).length ? "Lag valt" : "Ej vald",
      })),
    );
    const commentRows = [];
    for (const m of state.matches || []) {
      for (const c of m.comments || []) {
        commentRows.push({
          Match: m.matchNumber ?? m.number,
          Namn: c.name,
          Kommentar: c.text,
          Tid: formatTimestampSv(c.timestamp),
        });
      }
    }
    const wsComments = XLSX.utils.json_to_sheet(commentRows);

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsPlayers, "Spelare");
    XLSX.utils.book_append_sheet(wb, wsMatches, "Matcher");
    XLSX.utils.book_append_sheet(wb, wsComments, "Kommentarer");
    const xlsxArray = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const xlsxBlob = new Blob([xlsxArray], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    downloadBlob(`${base}.xlsx`, xlsxBlob);
    setOkMsg("Backup exporterad (JSON + Excel).");
  }

  async function importBackupFile(file) {
    if (!file) return;
    const ok = confirm("Detta ersätter all data. Vill du fortsätta?");
    if (!ok) return;
    setErr("");
    setImporting(true);
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Ogiltig JSON-fil.");
      }
      const next = await api("/api/state/import", { method: "POST", body: parsed });
      setState(next);
      setOkMsg("Backup importerad.");
    } catch (e) {
      setErr(e.message || "Kunde inte importera backup.");
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="app app-state" role="status" aria-live="polite">
        <div className="spinner" aria-hidden />
        <p className="app-state__title">Laddar…</p>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app app-state">
        <p className="app-state__title">Kunde inte läsa data</p>
        <p>Försök ladda om sidan.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <img className="app-header__logo" src="/logos/ifk-olme.png" alt="IFK Ölme" />
          <div>
            <h1 className="app-title">Lagval</h1>
            <p className="app-footnote">Olme IF · ungdom{buildInfo?.version ? ` · v${buildInfo.version}` : ""}{buildInfo?.commit ? ` · ${String(buildInfo.commit).slice(0, 7)}` : ""}</p>
          </div>
        </div>
      </header>

      {err && (
        <div className="banner banner--error" role="alert">
          {err}
        </div>
      )}
      {okMsg && (
        <div className="banner banner--ok" role="status">
          {okMsg}
        </div>
      )}
      {needRefresh && (
        <div className="banner banner--ok" role="status">
          Ny version tillgänglig.
          <button
            type="button"
            className="btn btn--secondary"
            style={{ marginLeft: 10 }}
            onClick={() => {
              updateServiceWorker(true);
              setNeedRefresh(false);
            }}
          >
            Uppdatera
          </button>
        </div>
      )}

      <div className="segmented app-bottom-nav" role="tablist" aria-label="Huvudnavigering">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            className="segmented__btn"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: -8, marginBottom: 12 }}>
        <button type="button" className="btn btn--secondary" onClick={() => installApp().catch(() => null)}>
          Installera app
        </button>
      </div>
      {installHint ? (
        <div className="banner banner--ok" role="status" style={{ marginTop: -6 }}>
          {installHint}
        </div>
      ) : null}

      {tab === "players" && (
        <section className="panel" role="tabpanel" id="panel-players" aria-labelledby="tab-players">
          <h2 className="panel__title">Spelargrupp</h2>
          <p className="panel__lead">
            Spelare, grupper A/B/C för födda 2015 och 2016 (rotation). P 10-matcher: tre 2015 + alla tillgängliga
            2016. Frånvaro: markera ej tillgänglig.
          </p>

          {rotationView && rotationView.groupsValid === false && (
            <div className="callout callout--muted" role="status">
              <strong>Ogiltiga 2015-grupper.</strong> Välj fliken <strong>Grupper</strong> och fördela exakt tre
              spelare i A, B och C, sedan spara — eller åtgärda antalet födda 2015.
            </div>
          )}
          {rotationView && rotationView.groups2016Valid === false && (
            <div className="callout callout--muted" role="status">
              <strong>Ogiltiga 2016-grupper.</strong> Öppna <strong>Grupper</strong> och spara A/B/C (tre per grupp)
              samt Extra för övriga födda 2016.
            </div>
          )}

          <div className="segmented segmented--nested" role="tablist" aria-label="Spelargrupp undermeny">
            <button
              type="button"
              role="tab"
              className="segmented__btn"
              aria-selected={playerSubTab === "players"}
              onClick={() => setPlayerSubTab("players")}
            >
              Spelare
            </button>
            <button
              type="button"
              role="tab"
              className="segmented__btn"
              aria-selected={playerSubTab === "groups"}
              onClick={() => setPlayerSubTab("groups")}
            >
              Grupper
            </button>
            <button
              type="button"
              role="tab"
              className="segmented__btn"
              aria-selected={playerSubTab === "coaches"}
              onClick={() => setPlayerSubTab("coaches")}
            >
              Tränare
            </button>
          </div>

          {playerSubTab === "players" && (
            <>
              <form
                className="form-add"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setErr("");
                  try {
                    await api("/api/players", {
                      method: "POST",
                      body: {
                        name: form.name,
                        birthYear: Number(form.birthYear),
                        jerseyNumber: form.jerseyNumber ? Number(form.jerseyNumber) : null,
                        preferredPosition: form.preferredPosition,
                      },
                    });
                    setForm({ name: "", birthYear: form.birthYear, jerseyNumber: "", preferredPosition: form.preferredPosition });
                    await load();
                  } catch (x) {
                    setErr(x.message);
                  }
                }}
              >
                <div className="field">
                  <span className="field__label">Namn</span>
                  <input
                    className="field__input"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    required
                    autoComplete="name"
                    enterKeyHint="done"
                  />
                </div>
                <div className="field">
                  <span className="field__label">Födelseår</span>
                  <select
                    className="field__select"
                    value={form.birthYear}
                    onChange={(e) => setForm((f) => ({ ...f, birthYear: e.target.value }))}
                  >
                    <option value="2015">2015</option>
                    <option value="2016">2016</option>
                  </select>
                </div>
                <div className="field">
                  <span className="field__label">Draktnummer</span>
                  <input
                    className="field__input"
                    type="number"
                    min={1}
                    value={form.jerseyNumber}
                    onChange={(e) => setForm((f) => ({ ...f, jerseyNumber: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <span className="field__label">Föredragen position</span>
                  <select
                    className="field__select"
                    value={form.preferredPosition}
                    onChange={(e) => setForm((f) => ({ ...f, preferredPosition: e.target.value }))}
                  >
                    <option value="">Ingen</option>
                    {PLAYER_POSITIONS.map((pos) => (
                      <option key={pos} value={pos}>
                        {pos}
                      </option>
                    ))}
                  </select>
                </div>
                <button type="submit" className="btn btn--primary">
                  Lägg till spelare
                </button>
              </form>

              <div className="players-table-wrap" style={{ marginTop: 16 }}>
                <table className="players-table">
                  <thead>
                    <tr>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("name")}>{`Namn${sortMark("name")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("jerseyNumber")}>{`Nr${sortMark("jerseyNumber")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("preferredPosition")}>{`Position${sortMark("preferredPosition")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("birthYear")}>{`År${sortMark("birthYear")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("group")}>{`Grupp${sortMark("group")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("matchesPlayed")}>{`Matcher${sortMark("matchesPlayed")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("lastPlayedMatchNumber")}>{`Senast${sortMark("lastPlayedMatchNumber")}`}</button></th>
                      <th><button type="button" className="players-sort-btn" onClick={() => togglePlayersSort("available")}>{`Status${sortMark("available")}`}</button></th>
                      <th className="actions-cell" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPlayersTable.map((p) => {
                        const gLet = p.birthYear === 2015 ? groupLetterFor2015Player(p.id, state.groups2015) : null;
                        if (editingId === p.id) {
                          return (
                            <tr key={p.id} className="players-table__edit">
                              <td colSpan={9} style={{ padding: "12px 14px", background: "var(--fill-secondary)" }}>
                                <div className="form-add" style={{ marginBottom: 0 }}>
                                  <div className="field">
                                    <span className="field__label">Namn</span>
                                    <input
                                      className="field__input"
                                      value={editName}
                                      onChange={(e) => setEditName(e.target.value)}
                                    />
                                  </div>
                                  <div className="field">
                                    <span className="field__label">Födelseår</span>
                                    <select
                                      className="field__select"
                                      value={editYear}
                                      onChange={(e) => setEditYear(e.target.value)}
                                    >
                                      <option value="2015">2015</option>
                                      <option value="2016">2016</option>
                                    </select>
                                  </div>
                                  <div className="field">
                                    <span className="field__label">Draktnummer</span>
                                    <input
                                      className="field__input"
                                      type="number"
                                      min={1}
                                      value={editJerseyNumber}
                                      onChange={(e) => setEditJerseyNumber(e.target.value)}
                                    />
                                  </div>
                                  <div className="field">
                                    <span className="field__label">Föredragen position</span>
                                    <select
                                      className="field__select"
                                      value={editPreferredPosition}
                                      onChange={(e) => setEditPreferredPosition(e.target.value)}
                                    >
                                      <option value="">Ingen</option>
                                      {PLAYER_POSITIONS.map((pos) => (
                                        <option key={pos} value={pos}>
                                          {pos}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div className="btn-row" style={{ marginTop: 10 }}>
                                  <button
                                    type="button"
                                    className="btn btn--primary btn--table"
                                    onClick={async () => {
                                      setErr("");
                                      try {
                                        await api(`/api/players/${p.id}`, {
                                          method: "PUT",
                                          body: {
                                            name: editName,
                                            birthYear: Number(editYear),
                                            jerseyNumber: editJerseyNumber ? Number(editJerseyNumber) : null,
                                            preferredPosition: editPreferredPosition,
                                          },
                                        });
                                        setEditingId(null);
                                        await load();
                                      } catch (x) {
                                        setErr(x.message);
                                      }
                                    }}
                                  >
                                    Spara
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--secondary btn--table"
                                    onClick={() => setEditingId(null)}
                                  >
                                    Avbryt
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        }
                        return (
                          <tr key={p.id}>
                            <td className="players-table__name" data-label="Namn">
                              {p.name}
                            </td>
                            <td data-label="Nr">{p.jerseyNumber || "—"}</td>
                            <td data-label="Position">{p.preferredPosition || "—"}</td>
                            <td data-label="År">{p.birthYear}</td>
                            <td data-label="Grupp">{p.birthYear === 2015 ? (gLet ? gLet : "—") : "—"}</td>
                            <td data-label="Matcher">{p.matchesPlayed}</td>
                            <td data-label="Senast">{p.lastPlayedMatchNumber != null ? p.lastPlayedMatchNumber : "—"}</td>
                            <td data-label="Status">
                              {p.available === false ? (
                                <span className="badge-avail badge-avail--no">Ej tillgänglig</span>
                              ) : (
                                <span className="badge-avail badge-avail--ok">Tillgänglig</span>
                              )}
                            </td>
                            <td className="actions-cell">
                              <div className="actions-inner">
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--table"
                                  onClick={async () => {
                                    setErr("");
                                    const cur = p.available !== false;
                                    try {
                                      await api(`/api/players/${p.id}`, {
                                        method: "PUT",
                                        body: { available: !cur },
                                      });
                                      await load();
                                    } catch (x) {
                                      setErr(x.message);
                                    }
                                  }}
                                >
                                  {p.available === false ? "Tillgänglig" : "Frånvaro"}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--table"
                                  onClick={() => {
                                    setEditingId(p.id);
                                    setEditName(p.name);
                                    setEditYear(String(p.birthYear));
                                    setEditJerseyNumber(p.jerseyNumber ? String(p.jerseyNumber) : "");
                                    setEditPreferredPosition(p.preferredPosition || "");
                                  }}
                                >
                                  Redigera
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--danger btn--table"
                                  onClick={async () => {
                                    if (!confirm(`Ta bort ${p.name}?`)) return;
                                    setErr("");
                                    try {
                                      await api(`/api/players/${p.id}`, { method: "DELETE" });
                                      await load();
                                    } catch (x) {
                                      setErr(x.message);
                                    }
                                  }}
                                >
                                  Ta bort
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {playerSubTab === "groups" && (
            <div role="tabpanel" aria-label="Grupper">
              <h3 className="panel__title" style={{ fontSize: 17, marginTop: 0 }}>
                Grupper
              </h3>
              <h4 className="panel__title" style={{ fontSize: 16, margin: "12px 0 8px" }}>
                Födda 2015
              </h4>
              <Groups2015Editor
                groups2015={state.groups2015}
                players2015={players2015}
                load={load}
                setErr={setErr}
                revision={state?.meta?.revision}
              />
              <h4 className="panel__title" style={{ fontSize: 16, margin: "24px 0 8px" }}>
                Födda 2016
              </h4>
              <Groups2016Editor
                groups2016={state.groups2016}
                groups2016Extra={state.groups2016Extra ?? []}
                players2016={players2016}
                load={load}
                setErr={setErr}
                revision={state?.meta?.revision}
              />
            </div>
          )}

          {playerSubTab === "coaches" && (
            <div role="tabpanel" aria-label="Tränare">
              <h3 className="panel__title" style={{ fontSize: 17, marginTop: 0 }}>
                Tränare
              </h3>
              <p className="panel__lead">Lägg in namn, telefon och extra info för varje tränare.</p>
              <div className="group group--flush">
                {coachesDraft.map((c, idx) => (
                  <div key={c.id || idx} className="list-row">
                    <div className="field">
                      <span className="field__label">Namn</span>
                      <input
                        className="field__input"
                        value={c.name}
                        onChange={(e) =>
                          setCoachesDraft((prev) => {
                            setCoachesDraftDirty(true);
                            return prev.map((row, i) => (i === idx ? { ...row, name: e.target.value } : row));
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <span className="field__label">Telefon</span>
                      <input
                        className="field__input"
                        value={c.phone}
                        onChange={(e) =>
                          setCoachesDraft((prev) => {
                            setCoachesDraftDirty(true);
                            return prev.map((row, i) => (i === idx ? { ...row, phone: e.target.value } : row));
                          })
                        }
                        placeholder="+46..."
                      />
                    </div>
                    <div className="field">
                      <span className="field__label">Roll</span>
                      <input
                        className="field__input"
                        value={c.role}
                        onChange={(e) =>
                          setCoachesDraft((prev) => {
                            setCoachesDraftDirty(true);
                            return prev.map((row, i) => (i === idx ? { ...row, role: e.target.value } : row));
                          })
                        }
                        placeholder="Huvudtränare / Assisterande"
                      />
                    </div>
                    <div className="field">
                      <span className="field__label">Notis</span>
                      <textarea
                        className="field__input"
                        rows={2}
                        value={c.note}
                        onChange={(e) =>
                          setCoachesDraft((prev) => {
                            setCoachesDraftDirty(true);
                            return prev.map((row, i) => (i === idx ? { ...row, note: e.target.value } : row));
                          })
                        }
                        placeholder="Valfri info"
                      />
                    </div>
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn--plain btn--sm"
                        onClick={() =>
                          setCoachesDraft((prev) => {
                            setCoachesDraftDirty(true);
                            return prev.filter((_, i) => i !== idx);
                          })
                        }
                      >
                        Ta bort
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() =>
                    setCoachesDraft((prev) => {
                      setCoachesDraftDirty(true);
                      return [
                        ...prev,
                        { id: `coach-${Date.now()}-${prev.length + 1}`, name: "", phone: "", role: "", note: "" },
                      ];
                    })
                  }
                >
                  Lägg till tränare
                </button>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => saveCoaches().catch(() => null)}>
                  Spara tränare
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === "matches" && (
        <section className="panel matches-page" role="tabpanel" id="panel-matches" aria-labelledby="tab-matches">
          <h2 className="panel__title">Matcher</h2>

          {rotationView && rotationView.groupsValid === false && (
            <div className="banner banner--error" role="status">
              Ogiltiga 2015-grupper — öppna <strong>Spelargrupp</strong> och spara A/B/C.
            </div>
          )}
          {rotationView && rotationView.groups2016Valid === false && (
            <div className="banner banner--error" role="status">
              Ogiltiga 2016-grupper — öppna <strong>Spelargrupp → Grupper</strong> och spara A/B/C/Extra.
            </div>
          )}

          <p className="panel__lead" style={{ marginTop: 0 }}>
            Nästa grupp i tur: <strong>{rotationView?.nextGroupLabel ?? "Grupp A"}</strong>
          </p>
          <div className="matches-layout">
            <div className="matches-layout__toolbar">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setShowMatchCalendar((v) => !v)}
              >
                {showMatchCalendar ? "Dölj kalender" : "Visa kalender"}
              </button>
            </div>
            {showMatchCalendar && <div className="matches-layout__calendar">
              <h3 className="panel__title" style={{ fontSize: 17, margin: "0 0 8px" }}>
                Matchkalender
              </h3>
              <div className="calendar-month-stack" aria-label="Matchkalender">
                <div className="calendar-nav">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => hasPrevCalendarMonth && setCalendarMonthKey(calendarMonthKeys[calendarMonthIndex - 1])}
                disabled={!hasPrevCalendarMonth}
              >
                ← Föregående
              </button>
              <h4 className="calendar-month__title" style={{ margin: 0 }}>
                {new Date(calendarMonthView.year, calendarMonthView.month, 1).toLocaleDateString("sv-SE", {
                  month: "long",
                  year: "numeric",
                })}
              </h4>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => hasNextCalendarMonth && setCalendarMonthKey(calendarMonthKeys[calendarMonthIndex + 1])}
                disabled={!hasNextCalendarMonth}
              >
                Nästa →
              </button>
                </div>
                <section className="calendar-month">
                  <div className="calendar-month__weekdays" aria-hidden>
                    {["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"].map((w) => (
                      <span key={w}>{w}</span>
                    ))}
                  </div>
                  <div className="calendar-month__grid">
                    {calendarMonthView.cells.map((day, i) => {
                      if (!day) return <div key={`empty-${calendarMonthView.key}-${i}`} className="calendar-day calendar-day--empty" />;
                      const dayMatches = calendarMonthView.matchesByDay.get(day) || [];
                      return (
                        <div key={`${calendarMonthView.key}-${day}`} className="calendar-day">
                          <span className="calendar-day__date">{day}</span>
                          <div className="calendar-day__matches">
                            {dayMatches.map((m) => {
                              const st = calendarStatus(m);
                              const branchLabel = (m.branch || "p10") === "p11" ? "P11" : "P10";
                              const opponent = calendarOpponentName(m);
                              const oppLogo = calendarOpponentLogo(m);
                              const hasUpdate = Boolean((m.note || "").trim()) || (m.comments || []).length > 0;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  className={`calendar-event calendar-event--${branchLabel.toLowerCase()}${activeMatchId === m.id ? " calendar-event--active" : ""}`}
                                  onClick={() => openMatchDetail(m.id)}
                                  title={`Match ${m.number} · ${branchLabel} · ${opponent} · ${calendarTimeLabel(m)} · ${st.label}`}
                                >
                                  <div className="calendar-event__top">
                                    <span className={`calendar-match__dot ${st.cls}`} aria-hidden />
                                    <strong>{branchLabel}</strong>
                                    {hasUpdate ? <span className="calendar-event__update">Notis</span> : null}
                                  </div>
                                  <div className="calendar-event__opponent">
                                    <CalendarEventCrest name={oppLogo.name} logoUrl={oppLogo.logoUrl} />
                                    <span>{opponent}</span>
                                  </div>
                                  <div className="calendar-event__time">
                                    {calendarTimeLabel(m)}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>
            </div>}

            <div className="matches-layout__detail">
              {activeMatch ? (
                <div className="section-spacer">
                  <MatchCard
                    m={activeMatch}
                    rotationView={rotationView}
                    players2015={players2015}
                    players2016={players2016}
                    state={state}
                    playerName={playerName}
                    load={load}
                    setErr={setErr}
                    groupsValid={matchGroupsValid}
                    coachNames={coachNames}
                    onCopied={setOkMsg}
                    cardTitle="Match"
                    displayNumber={activeMatch?.number}
                    getStoredTeamLogo={getStoredTeamLogo}
                  />
                </div>
              ) : (
                <p className="text-muted">Välj en match i kalendern.</p>
              )}
            </div>
          </div>
        </section>
      )}

      {tab === "overview" && (
        <section className="panel" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
          <h2 className="panel__title">Statistik</h2>
          <p className="panel__lead">
            Sortering: minst genomförda matcher först. Ålder: {seasonYear()} minus födelseår.
          </p>

          <p className="overview-meta">
            <span>
              Genomförda matcher: <strong>{matchesCompleted}</strong> / {matchesTotal}
            </span>
            <span>
              Visar <strong>{playersOverview.length}</strong> av {playersSorted.length} spelare
            </span>
          </p>

          <div className="filter-block">
            <span className="filter-block__label">Lag / födelseår</span>
            <div className="segmented segmented--filter" role="group" aria-label="Filtrera på födelseår">
              {[
                { id: "all", label: "Båda" },
                { id: "2015", label: "2015" },
                { id: "2016", label: "2016" },
              ].map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="segmented__btn"
                  aria-selected={overviewBirth === o.id}
                  onClick={() => setOverviewBirth(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-block">
            <span className="filter-block__label">Ålder ({seasonYear()})</span>
            <div className="segmented segmented--filter segmented--scroll" role="group" aria-label="Filtrera på ålder">
              <button
                type="button"
                className="segmented__btn"
                aria-selected={overviewAge === "all"}
                onClick={() => setOverviewAge("all")}
              >
                Alla
              </button>
              {uniqueAges.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="segmented__btn"
                  aria-selected={overviewAge === String(a)}
                  onClick={() => setOverviewAge(String(a))}
                >
                  {a} år
                </button>
              ))}
            </div>
          </div>

          {playersOverview.length === 0 ? (
            <p className="empty-hint">Inga spelare matchar filtren.</p>
          ) : (
            <div className="stat-list stat-list--4col">
              <div className="stat-head" aria-hidden>
                <span>Namn</span>
                <span>År</span>
                <span>Antal matcher</span>
                <span>Senast</span>
              </div>
              {playersOverview.map((p) => (
                <div key={p.id} className="stat-row">
                  <p className="stat-row__name">
                    {p.name}
                    <span style={{ fontWeight: 400, color: "var(--text-secondary)", fontSize: 14 }}>
                      {" "}
                      · {playerAge(p.birthYear)} år
                    </span>
                  </p>
                  <span className="stat-row__year">{p.birthYear}</span>
                  <span className="stat-row__value">{p.matchesPlayed}</span>
                  <span className="stat-row__last">{p.lastPlayedMatchNumber != null ? p.lastPlayedMatchNumber : "—"}</span>
                </div>
              ))}
            </div>
          )}

          <div className="section-spacer" style={{ marginTop: 20 }}>
            <div className="btn-row" style={{ marginBottom: 10 }}>
              <button type="button" className="btn btn--secondary btn--block" onClick={exportBackup}>
                Exportera data
              </button>
              <label className="btn btn--secondary btn--block" style={{ cursor: importing ? "wait" : "pointer" }}>
                Importera data
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: "none" }}
                  disabled={importing}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    importBackupFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <button
              type="button"
              className="btn btn--danger btn--block"
              onClick={async () => {
                if (
                  !confirm(
                    "Återställa säsongen? Alla matcher och matchräknare nollställs, alla spelare markeras som tillgängliga och nästa grupp blir A (ingen genomförd match)."
                  )
                )
                  return;
                setErr("");
                try {
                  await api("/api/reset-season", { method: "POST" });
                  await load();
                } catch (x) {
                  setErr(x.message);
                }
              }}
            >
              Återställ säsong
            </button>
          </div>
        </section>
      )}

      {tab === "settings" && (
        <section className="panel" role="tabpanel" id="panel-settings" aria-labelledby="tab-settings">
          <h2 className="panel__title">Inställningar</h2>
          <div className="group" style={{ padding: 12, marginBottom: 12 }}>
            <p className="panel__lead" style={{ margin: "0 0 8px" }}>
              MinFotboll-koppling (ICS)
            </p>
            <div className="field" style={{ marginBottom: 8 }}>
              <label className="field__label" htmlFor="ics-url">
                Kalenderlänk
              </label>
              <input
                id="ics-url"
                className="field__input"
                type="text"
                value={icsUrl}
                onChange={(e) => setIcsUrl(e.target.value)}
                placeholder="webcal://... eller https://..."
              />
            </div>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => syncFromMinFotboll().catch(() => null)}
              disabled={syncingIcs}
            >
              {syncingIcs ? "Synkar..." : "Synka MinFotboll"}
            </button>
          </div>

          <div className="group" style={{ padding: 12, marginBottom: 12 }}>
            <p className="panel__lead" style={{ margin: "0 0 8px" }}>
              Laglogotyper
            </p>
            <div className="logo-manager">
              {teamNames.map((team) => (
                <div key={team} className="logo-manager__row">
                  <div className="logo-manager__name">
                    <FixtureCrest name={team} logoUrl={getStoredTeamLogo(team)} />
                    <span>{team}</span>
                  </div>
                  <label className="btn btn--secondary btn--sm">
                    Ladda upp logo
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        uploadTeamLogo(team, file).catch((x) => setErr(x.message));
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn--plain btn--sm"
                    onClick={() => clearTeamLogo(team).catch((x) => setErr(x.message))}
                  >
                    Ta bort
                  </button>
                </div>
              ))}
            </div>
          </div>

        </section>
      )}
    </div>
  );
}
