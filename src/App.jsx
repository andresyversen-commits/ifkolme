import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { normalizeClubName, resolveTeamLogoUrl, teamInitials } from "@/lib/teamLogos";
import {
  birthYearNum,
  matchSquadMode,
  matchBranchKey,
  p11Assist2016Count,
  compareMatchesChronologically,
  playerCountsAsPlayedInMatchForTeamScope,
  playerMatchParticipationKind,
} from "../selection.mjs";

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
  { id: "test", label: "Test" },
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

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function encodeTestLabShare(state) {
  try {
    const json = JSON.stringify(state || {});
    return btoa(unescape(encodeURIComponent(json)));
  } catch {
    return "";
  }
}

function decodeTestLabShare(value) {
  try {
    if (!value) return null;
    const json = decodeURIComponent(escape(atob(value)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function createEmptyTestLabState() {
  return {
    teams: [],
    lineups: [],
  };
}

function normalizeTestLabFormation(input) {
  const raw = input && typeof input === "object" ? input : {};
  let defenders = Math.max(0, Math.min(6, Math.floor(Number(raw.defenders ?? 0))));
  let midfielders = Math.max(0, Math.min(6, Math.floor(Number(raw.midfielders ?? 0))));
  let attackers = Math.max(0, Math.min(6, Math.floor(Number(raw.attackers ?? 0))));
  const total = 6;
  const sum = defenders + midfielders + attackers;
  if (sum === total) return { defenders, midfielders, attackers };
  if (sum > total) {
    let excess = sum - total;
    // Minska anfallare först, sedan mittfält, sedan försvar.
    const take = (key, n) => {
      const v = { defenders, midfielders, attackers }[key];
      const dec = Math.min(v, n);
      if (key === "defenders") defenders -= dec;
      if (key === "midfielders") midfielders -= dec;
      if (key === "attackers") attackers -= dec;
      return n - dec;
    };
    excess = take("attackers", excess);
    excess = take("midfielders", excess);
    excess = take("defenders", excess);
    return { defenders, midfielders, attackers };
  }
  let missing = total - sum;
  // Lägg till anfallare först, sedan mittfält, sedan försvar.
  const add = (key, n) => {
    const v = { defenders, midfielders, attackers }[key];
    const inc = Math.min(6 - v, n);
    if (key === "defenders") defenders += inc;
    if (key === "midfielders") midfielders += inc;
    if (key === "attackers") attackers += inc;
    return n - inc;
  };
  missing = add("attackers", missing);
  missing = add("midfielders", missing);
  missing = add("defenders", missing);
  return { defenders, midfielders, attackers };
}

function adjustTestLabFormation(current, changedKey, nextValue) {
  const base = normalizeTestLabFormation(current);
  const next = { ...base };
  next[changedKey] = Math.max(0, Math.min(6, Math.floor(Number(nextValue ?? 0))));
  const total = 6;
  const keysToAdjust = ["attackers", "midfielders", "defenders"].filter((k) => k !== changedKey);
  let sum = next.defenders + next.midfielders + next.attackers;
  if (sum === total) return next;
  if (sum > total) {
    let excess = sum - total;
    for (const k of keysToAdjust) {
      const dec = Math.min(next[k], excess);
      next[k] -= dec;
      excess -= dec;
      if (!excess) break;
    }
    return next;
  }
  let missing = total - sum;
  for (const k of keysToAdjust) {
    const inc = Math.min(6 - next[k], missing);
    next[k] += inc;
    missing -= inc;
    if (!missing) break;
  }
  return next;
}

function normalizeTestLabState(input) {
  const base = createEmptyTestLabState();
  if (!input || typeof input !== "object") return base;
  const teams = Array.isArray(input.teams)
    ? input.teams.map((t) => ({
        id: String(t?.id || makeId("t")),
        name: String(t?.name || "").trim() || "Uten navn",
        players: Array.isArray(t?.players)
          ? t.players
              .map((p) => ({
                id: String(p?.id || makeId("tp")),
                name: String(p?.name || "").trim(),
                number: Number.isFinite(Number(p?.number)) ? Math.max(1, Math.floor(Number(p.number))) : null,
              }))
              .filter((p) => p.name)
          : [],
      }))
    : [];
  const teamIds = new Set(teams.map((t) => t.id));
  const lineups = Array.isArray(input.lineups)
    ? input.lineups
        .map((l) => ({
          id: String(l?.id || makeId("lu")),
          teamId: String(l?.teamId || ""),
          name: String(l?.name || "").trim() || "Uppställning",
          formation: normalizeTestLabFormation(l?.formation ?? { defenders: 2, midfielders: 2, attackers: 2 }),
          positions: l?.positions && typeof l.positions === "object" ? { ...l.positions } : {},
        }))
        .filter((l) => teamIds.has(l.teamId))
    : [];
  return { teams, lineups };
}

function TestLabPanel({ setErr, setOkMsg }) {
  const [state, setState] = useState(() => createEmptyTestLabState());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [exportLineupIds, setExportLineupIds] = useState([]);
  const [teamNameDraft, setTeamNameDraft] = useState("");
  const [teamEditDraft, setTeamEditDraft] = useState("");
  const [editingTeamId, setEditingTeamId] = useState("");
  const [playerNameDraft, setPlayerNameDraft] = useState("");
  const [playerNumberDraft, setPlayerNumberDraft] = useState("");
  const [editingPlayerId, setEditingPlayerId] = useState("");
  const [playerEditNameDraft, setPlayerEditNameDraft] = useState("");
  const [playerEditNumberDraft, setPlayerEditNumberDraft] = useState("");
  const [lineupNameDraft, setLineupNameDraft] = useState("");
  const [activeTeamId, setActiveTeamId] = useState("");
  const [activeLineupId, setActiveLineupId] = useState("");

  useEffect(() => {
    const sharedParam = new URLSearchParams(window.location.search).get("testlab");
    const shared = decodeTestLabShare(sharedParam);
    const run = async () => {
      setErr("");
      setLoading(true);
      try {
        const remote = await api("/api/testlab/state");
        const base = normalizeTestLabState(remote?.testLab);
        if (shared) {
          const merged = normalizeTestLabState(shared);
          setState(merged);
          setOkMsg("Delad testdata importerad.");
          // Persist import immediately.
          setSaving(true);
          const saved = await api("/api/testlab/state", { method: "PUT", body: { testLab: merged } });
          setLastSavedAt(saved?.updatedAt || new Date().toISOString());
          // Strip query param after successful import.
          if (sharedParam) {
            const url = new URL(window.location.href);
            url.searchParams.delete("testlab");
            window.history.replaceState({}, "", url.toString());
          }
        } else {
          setState(base);
          setLastSavedAt(remote?.updatedAt || null);
        }
      } catch (e) {
        setErr(e.message || "Kunde inte ladda testdata.");
      } finally {
        setSaving(false);
        setLoading(false);
      }
    };
    run().catch(() => null);
  }, [setErr, setOkMsg]);

  useEffect(() => {
    if (loading) return;
    const t = setTimeout(async () => {
      try {
        setSaving(true);
        const saved = await api("/api/testlab/state", { method: "PUT", body: { testLab: normalizeTestLabState(state) } });
        setLastSavedAt(saved?.updatedAt || new Date().toISOString());
      } catch (e) {
        setErr(e.message || "Kunde inte spara testdata.");
      } finally {
        setSaving(false);
      }
    }, 650);
    return () => clearTimeout(t);
  }, [state, loading, setErr]);

  useEffect(() => {
    if (!activeTeamId || state.teams.some((t) => t.id === activeTeamId)) return;
    setActiveTeamId(state.teams[0]?.id || "");
  }, [state.teams, activeTeamId]);

  useEffect(() => {
    if (activeTeamId) return;
    if (state.teams[0]?.id) setActiveTeamId(state.teams[0].id);
  }, [state.teams, activeTeamId]);

  const activeTeam = useMemo(() => state.teams.find((t) => t.id === activeTeamId) || null, [state.teams, activeTeamId]);
  const teamLineups = useMemo(
    () => state.lineups.filter((l) => l.teamId === activeTeamId),
    [state.lineups, activeTeamId],
  );
  const activeLineup = useMemo(
    () => state.lineups.find((l) => l.id === activeLineupId && l.teamId === activeTeamId) || teamLineups[0] || null,
    [state.lineups, activeLineupId, activeTeamId, teamLineups],
  );

  useEffect(() => {
    if (!activeLineup) {
      setActiveLineupId("");
      return;
    }
    if (activeLineupId !== activeLineup.id) setActiveLineupId(activeLineup.id);
  }, [activeLineup, activeLineupId]);

  useEffect(() => {
    if (!activeTeamId) {
      setExportLineupIds([]);
      return;
    }
    const ids = teamLineups.map((l) => l.id);
    setExportLineupIds((prev) => {
      const set = new Set(prev);
      const keep = ids.filter((id) => set.has(id));
      return keep.length ? keep : ids;
    });
  }, [activeTeamId, teamLineups]);

  const outfieldSlots = useMemo(() => buildOutfieldSlots(activeLineup?.formation || {}), [activeLineup?.formation]);
  const slotNodes = useMemo(
    () => [{ key: "gk", role: "goalkeeper", lane: "central", y: 86 }, ...outfieldSlots.map((slot) => ({
      ...slot,
      y: slot.role === "defender" ? 67 : slot.role === "midfielder" ? 49 : 31,
    }))],
    [outfieldSlots],
  );
  const slotToPlayerId = useMemo(() => {
    const map = {};
    if (!activeLineup || !activeTeam) return map;
    const validPlayerIds = new Set(activeTeam.players.map((p) => p.id));
    for (const p of activeTeam.players) {
      const slotKey = String(activeLineup.positions?.[p.id] || "bench");
      if (!validPlayerIds.has(p.id) || !slotKey || slotKey === "bench") continue;
      if (!map[slotKey]) map[slotKey] = p.id;
    }
    return map;
  }, [activeLineup, activeTeam]);
  const duplicateSlots = useMemo(() => {
    if (!activeLineup || !activeTeam) return [];
    const counts = new Map();
    for (const p of activeTeam.players) {
      const slotKey = String(activeLineup.positions?.[p.id] || "bench");
      if (!slotKey || slotKey === "bench") continue;
      counts.set(slotKey, (counts.get(slotKey) || 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  }, [activeLineup, activeTeam]);

  const updateState = useCallback((updater) => {
    setState((prev) => normalizeTestLabState(typeof updater === "function" ? updater(prev) : updater));
  }, []);

  const addTeam = (e) => {
    e.preventDefault();
    const name = teamNameDraft.trim();
    if (!name) return;
    const id = makeId("t");
    updateState((prev) => ({
      ...prev,
      teams: [...prev.teams, { id, name, players: [] }],
    }));
    setTeamNameDraft("");
    setActiveTeamId(id);
    setOkMsg("Testlag skapat.");
  };

  const startEditTeam = () => {
    if (!activeTeam) return;
    setEditingTeamId(activeTeam.id);
    setTeamEditDraft(activeTeam.name);
  };

  const saveEditTeam = () => {
    if (!editingTeamId) return;
    const name = teamEditDraft.trim();
    if (!name) return;
    updateState((prev) => ({
      ...prev,
      teams: prev.teams.map((t) => (t.id === editingTeamId ? { ...t, name } : t)),
    }));
    setEditingTeamId("");
    setTeamEditDraft("");
    setOkMsg("Testlag uppdaterat.");
  };

  const deleteTeam = () => {
    if (!activeTeam) return;
    if (!confirm(`Ta bort testlaget "${activeTeam.name}"? Detta tar även bort alla uppställningar för laget.`)) return;
    const id = activeTeam.id;
    updateState((prev) => ({
      ...prev,
      teams: prev.teams.filter((t) => t.id !== id),
      lineups: prev.lineups.filter((l) => l.teamId !== id),
    }));
    setActiveTeamId("");
    setActiveLineupId("");
    setEditingTeamId("");
    setTeamEditDraft("");
    setOkMsg("Testlag borttaget.");
  };

  const addPlayer = (e) => {
    e.preventDefault();
    if (!activeTeam) return;
    const name = playerNameDraft.trim();
    if (!name) return;
    const number = Number.isFinite(Number(playerNumberDraft)) ? Math.max(1, Math.floor(Number(playerNumberDraft))) : null;
    const player = { id: makeId("tp"), name, number };
    updateState((prev) => ({
      ...prev,
      teams: prev.teams.map((t) => (t.id === activeTeam.id ? { ...t, players: [...t.players, player] } : t)),
    }));
    setPlayerNameDraft("");
    setPlayerNumberDraft("");
  };

  const startEditPlayer = (p) => {
    setEditingPlayerId(p.id);
    setPlayerEditNameDraft(p.name);
    setPlayerEditNumberDraft(p.number != null ? String(p.number) : "");
  };

  const saveEditPlayer = () => {
    if (!activeTeam || !editingPlayerId) return;
    const name = playerEditNameDraft.trim();
    if (!name) return;
    const number = Number.isFinite(Number(playerEditNumberDraft)) ? Math.max(1, Math.floor(Number(playerEditNumberDraft))) : null;
    updateState((prev) => ({
      ...prev,
      teams: prev.teams.map((t) =>
        t.id === activeTeam.id
          ? { ...t, players: t.players.map((p) => (p.id === editingPlayerId ? { ...p, name, number } : p)) }
          : t,
      ),
    }));
    setEditingPlayerId("");
    setPlayerEditNameDraft("");
    setPlayerEditNumberDraft("");
    setOkMsg("Spelare uppdaterad.");
  };

  const deletePlayer = (player) => {
    if (!activeTeam) return;
    if (!confirm(`Ta bort ${player.name} från testlaget?`)) return;
    updateState((prev) => {
      const teams = prev.teams.map((t) =>
        t.id === activeTeam.id ? { ...t, players: t.players.filter((p) => p.id !== player.id) } : t,
      );
      const lineups = prev.lineups.map((l) => {
        if (l.teamId !== activeTeam.id) return l;
        const positions = { ...(l.positions || {}) };
        delete positions[player.id];
        return { ...l, positions };
      });
      return { ...prev, teams, lineups };
    });
    if (editingPlayerId === player.id) {
      setEditingPlayerId("");
      setPlayerEditNameDraft("");
      setPlayerEditNumberDraft("");
    }
    setOkMsg("Spelare borttagen.");
  };

  const addLineup = (e) => {
    e.preventDefault();
    if (!activeTeam) return;
    const name = lineupNameDraft.trim() || `Uppställning ${teamLineups.length + 1}`;
    const lineup = {
      id: makeId("lu"),
      teamId: activeTeam.id,
      name,
      formation: { defenders: 2, midfielders: 2, attackers: 2 },
      positions: {},
    };
    updateState((prev) => ({ ...prev, lineups: [...prev.lineups, lineup] }));
    setLineupNameDraft("");
    setActiveLineupId(lineup.id);
  };

  const updateLineup = (patch) => {
    if (!activeLineup) return;
    updateState((prev) => ({
      ...prev,
      lineups: prev.lineups.map((l) => (l.id === activeLineup.id ? { ...l, ...patch } : l)),
    }));
  };

  const updatePlayerPosition = (playerId, slotKey) => {
    if (!activeLineup) return;
    const next = { ...(activeLineup.positions || {}) };
    next[playerId] = slotKey;
    updateLineup({ positions: next });
  };

  const buildExportStateForActiveTeam = useCallback(() => {
    const normalized = normalizeTestLabState(state);
    if (!activeTeamId) return createEmptyTestLabState();
    const team = normalized.teams.find((t) => t.id === activeTeamId);
    if (!team) return createEmptyTestLabState();
    const allowed = new Set(exportLineupIds.length ? exportLineupIds : normalized.lineups.filter((l) => l.teamId === activeTeamId).map((l) => l.id));
    const lineups = normalized.lineups.filter((l) => l.teamId === activeTeamId && allowed.has(l.id));
    return { teams: [team], lineups };
  }, [state, activeTeamId, exportLineupIds]);

  const exportJson = () => {
    const payload = buildExportStateForActiveTeam();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `test-uppstallningar-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setOkMsg("Testdata exporterad som JSON.");
  };

  const lineupExportText = useMemo(() => {
    const exportState = buildExportStateForActiveTeam();
    const team = exportState.teams[0];
    if (!team) return "";
    const playerById = new Map(team.players.map((p) => [p.id, p]));
    const lines = [`Lag: ${team.name}`];
    for (const lu of exportState.lineups) {
      const outSlots = buildOutfieldSlots(lu.formation);
      const nodes = [{ key: "gk", role: "goalkeeper", lane: "central" }, ...outSlots];
      const slotToPlayer = {};
      for (const p of team.players) {
        const slotKey = String(lu.positions?.[p.id] || "bench");
        if (!slotKey || slotKey === "bench") continue;
        if (!slotToPlayer[slotKey]) slotToPlayer[slotKey] = p.id;
      }
      lines.push("");
      lines.push(`Uppställning: ${lu.name}`);
      lines.push(`Formation: ${lu.formation.defenders}-${lu.formation.midfielders}-${lu.formation.attackers}`);
      lines.push("");
      for (const node of nodes) {
        const pid = slotToPlayer[node.key];
        const player = pid ? playerById.get(pid) : null;
        const lane = node.lane ? ` ${node.lane}` : "";
        lines.push(`${roleLabelSv(node.role)}${lane}: ${player ? `${player.name}${player.number ? ` (#${player.number})` : ""}` : "—"}`);
      }
      const bench = team.players.filter((p) => !Object.values(slotToPlayer).includes(p.id));
      lines.push("");
      lines.push("Bänk:");
      for (const p of bench) lines.push(`- ${p.name}${p.number ? ` (#${p.number})` : ""}`);
    }
    return lines.join("\n").trim();
  }, [buildExportStateForActiveTeam]);

  const copyLineup = async () => {
    if (!lineupExportText) return;
    await navigator.clipboard.writeText(lineupExportText);
    setOkMsg("Uppställningar kopierade.");
  };

  const copyShareLink = async () => {
    const encoded = encodeTestLabShare(buildExportStateForActiveTeam());
    if (!encoded) throw new Error("Kunde inte skapa delningslänk.");
    const url = new URL(window.location.href);
    url.searchParams.set("testlab", encoded);
    await navigator.clipboard.writeText(url.toString());
    setOkMsg("Delningslänk kopierad.");
  };

  const shareLineup = async () => {
    if (!navigator.share) throw new Error("Delning stöds inte på den här enheten.");
    await navigator.share({
      title: "Test – uppställningar",
      text: lineupExportText || "Se uppställningar.",
    });
  };

  return (
    <section className="panel" role="tabpanel" id="panel-test" aria-labelledby="tab-test">
      <h2 className="panel__title">Test</h2>
      <p className="panel__lead">Separat sandlåda för testlag och uppställningar. Detta påverkar inte matchdata.</p>
      <p className="text-muted" style={{ margin: "0 0 12px" }}>
        Status: {loading ? "Laddar…" : saving ? "Sparar…" : lastSavedAt ? `Sparad ${new Date(lastSavedAt).toLocaleString()}` : "Klar"}
      </p>

      <form className="form-add" onSubmit={addTeam}>
        <div className="field">
          <span className="field__label">Nytt testlag</span>
          <input className="field__input" value={teamNameDraft} onChange={(e) => setTeamNameDraft(e.target.value)} placeholder="t.ex. Träningsmatch blå" />
        </div>
        <button type="submit" className="btn btn--primary">Skapa lag</button>
      </form>

      {state.teams.length > 0 ? (
        <div className="field" style={{ marginTop: 12 }}>
          <span className="field__label">Aktivt testlag</span>
          <select className="field__select" value={activeTeamId} onChange={(e) => setActiveTeamId(e.target.value)}>
            {state.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      ) : (
        <p className="text-muted">Skapa ett testlag för att börja.</p>
      )}

      {activeTeam ? (
        <>
          <div className="match-card__actions" style={{ marginTop: 10 }}>
            {editingTeamId === activeTeam.id ? (
              <>
                <div className="field" style={{ width: "100%" }}>
                  <span className="field__label">Redigera lagnamn</span>
                  <input className="field__input" value={teamEditDraft} onChange={(e) => setTeamEditDraft(e.target.value)} />
                </div>
                <button type="button" className="btn btn--secondary btn--block" onClick={saveEditTeam} disabled={!teamEditDraft.trim()}>
                  Spara lagnamn
                </button>
                <button type="button" className="btn btn--plain btn--block" onClick={() => { setEditingTeamId(""); setTeamEditDraft(""); }}>
                  Avbryt
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn--secondary btn--block" onClick={startEditTeam}>
                  Redigera lag
                </button>
                <button type="button" className="btn btn--plain btn--block" onClick={deleteTeam}>
                  Ta bort lag
                </button>
              </>
            )}
          </div>

          <form className="form-add" onSubmit={addPlayer} style={{ marginTop: 16 }}>
            <div className="field">
              <span className="field__label">Spelarnamn</span>
              <input className="field__input" value={playerNameDraft} onChange={(e) => setPlayerNameDraft(e.target.value)} placeholder="Namn" />
            </div>
            <div className="field">
              <span className="field__label">Nummer (valfritt)</span>
              <input className="field__input" type="number" min={1} value={playerNumberDraft} onChange={(e) => setPlayerNumberDraft(e.target.value)} />
            </div>
            <button type="submit" className="btn btn--secondary">Lägg till spelare</button>
          </form>

          {activeTeam.players.length > 0 ? (
            <>
              <p className="text-muted" style={{ margin: "10px 0 6px" }}>
                Spelare i testlaget: <strong>{activeTeam.players.length}</strong>
              </p>
              <ul className="lineup-list" aria-label="Testlag spelare">
                {[...activeTeam.players]
                  .slice()
                  .sort((a, b) => String(a.name).localeCompare(String(b.name), "nb", { sensitivity: "base" }))
                  .map((p) => (
                    <li key={`test-player-${p.id}`} className="lineup-list__row">
                      <span className="lineup-list__name">
                        {editingPlayerId === p.id ? (
                          <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                            <input
                              className="field__input"
                              style={{ width: 220, padding: "8px 10px" }}
                              value={playerEditNameDraft}
                              onChange={(e) => setPlayerEditNameDraft(e.target.value)}
                            />
                            <input
                              className="field__input"
                              style={{ width: 120, padding: "8px 10px" }}
                              type="number"
                              min={1}
                              placeholder="Nr"
                              value={playerEditNumberDraft}
                              onChange={(e) => setPlayerEditNumberDraft(e.target.value)}
                            />
                            <button type="button" className="btn btn--secondary btn--sm" onClick={saveEditPlayer} disabled={!playerEditNameDraft.trim()}>
                              Spara
                            </button>
                            <button
                              type="button"
                              className="btn btn--plain btn--sm"
                              onClick={() => {
                                setEditingPlayerId("");
                                setPlayerEditNameDraft("");
                                setPlayerEditNumberDraft("");
                              }}
                            >
                              Avbryt
                            </button>
                          </span>
                        ) : (
                          <span style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                            <span>{p.name}</span>
                            <span style={{ color: "var(--text-tertiary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                              {p.number != null ? `#${p.number}` : ""}
                            </span>
                            <button type="button" className="btn btn--plain btn--sm" onClick={() => startEditPlayer(p)}>
                              Redigera
                            </button>
                            <button type="button" className="btn btn--plain btn--sm" onClick={() => deletePlayer(p)}>
                              Ta bort
                            </button>
                          </span>
                        )}
                      </span>
                      <span className="lineup-list__year" aria-hidden>
                        {p.number ?? "—"}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <p className="text-muted" style={{ marginTop: 10 }}>Inga spelare ännu.</p>
          )}

          <form className="form-add" onSubmit={addLineup} style={{ marginTop: 10 }}>
            <div className="field">
              <span className="field__label">Ny laguppställning</span>
              <input className="field__input" value={lineupNameDraft} onChange={(e) => setLineupNameDraft(e.target.value)} placeholder="t.ex. 2-3-1 högt press" />
            </div>
            <button type="submit" className="btn btn--secondary">Skapa uppställning</button>
          </form>

          {teamLineups.length > 0 ? (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <span className="field__label">Aktiv uppställning</span>
                <select className="field__select" value={activeLineup?.id || ""} onChange={(e) => setActiveLineupId(e.target.value)}>
                  {teamLineups.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>

              {activeLineup ? (
                <div className="lineup-layout" style={{ marginTop: 12 }}>
                  <div className="lineup-layout__controls">
                    <div className="lineup-formation-grid">
                      <input
                        className="field__select"
                        type="number"
                        min={0}
                        max={6}
                        value={activeLineup.formation.defenders}
                        onChange={(e) =>
                          updateLineup({
                            formation: adjustTestLabFormation(activeLineup.formation, "defenders", e.target.value),
                          })
                        }
                      />
                      <input
                        className="field__select"
                        type="number"
                        min={0}
                        max={6}
                        value={activeLineup.formation.midfielders}
                        onChange={(e) =>
                          updateLineup({
                            formation: adjustTestLabFormation(activeLineup.formation, "midfielders", e.target.value),
                          })
                        }
                      />
                      <input
                        className="field__select"
                        type="number"
                        min={0}
                        max={6}
                        value={activeLineup.formation.attackers}
                        onChange={(e) =>
                          updateLineup({
                            formation: adjustTestLabFormation(activeLineup.formation, "attackers", e.target.value),
                          })
                        }
                      />
                    </div>
                    <p className="text-muted" style={{ marginTop: 8 }}>
                      Formation: {activeLineup.formation.defenders}-{activeLineup.formation.midfielders}-{activeLineup.formation.attackers} (6 utespelare)
                    </p>

                    <div className="lineup-player-grid">
                      {activeTeam.players.map((p) => (
                        <div key={`tlp-${p.id}`} className="field">
                          <span className="field__label">{p.name}{p.number ? ` #${p.number}` : ""}</span>
                          <select
                            className="field__select"
                            value={activeLineup.positions?.[p.id] || "bench"}
                            onChange={(e) => updatePlayerPosition(p.id, e.target.value)}
                          >
                            <option value="bench">Bänk</option>
                            <option value="gk">Målvakt</option>
                            {outfieldSlots.map((slot) => (
                              <option key={`tlos-${slot.key}`} value={slot.key}>
                                {slotLabelFromKey(slot.key, outfieldSlots)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                    {duplicateSlots.length > 0 ? (
                      <p className="text-muted">Flera spelare har samma position: {duplicateSlots.join(", ")}.</p>
                    ) : null}
                  </div>

                  <div className="lineup-layout__pitch">
                    <div className="lineup-pitch" aria-label="Testlag på fotbollsplan">
                      <div className="lineup-pitch__surface">
                        <div className="lineup-pitch__half" />
                        <div className="lineup-pitch__circle" />
                        <div className="lineup-pitch__box lineup-pitch__box--top" />
                        <div className="lineup-pitch__box lineup-pitch__box--bottom" />
                        {slotNodes.map((slotNode) => {
                          const playerId = slotToPlayerId[slotNode.key];
                          const player = activeTeam.players.find((p) => p.id === playerId);
                          return (
                            <div
                              key={`tlslot-${slotNode.key}`}
                              className={`lineup-pitch__slot lineup-pitch__slot--${slotNode.role} ${player ? "is-filled" : ""}`}
                              style={{ left: `${slotNode.lane === "vänster" ? 23 : slotNode.lane === "höger" ? 77 : 50}%`, top: `${slotNode.y}%` }}
                            >
                              {player ? (
                                <div className={`lineup-pitch__player lineup-pitch__player--${slotNode.role}`}>
                                  <span className="lineup-pitch__number">{player.number || "?"}</span>
                                  <span className="lineup-pitch__name">{player.name}</span>
                                </div>
                              ) : (
                                <span className="lineup-pitch__empty">{roleLabelSv(slotNode.role)}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-muted" style={{ marginTop: 10 }}>Skapa en uppställning för att börja visualisera.</p>
          )}
        </>
      ) : null}

      <div className="match-card__actions" style={{ marginTop: 16 }}>
        {activeTeam && teamLineups.length > 0 ? (
          <div className="group" style={{ padding: 12, width: "100%" }}>
            <p className="panel__lead" style={{ margin: "0 0 6px" }}>Export och delning</p>
            <p className="text-muted" style={{ margin: 0, fontSize: 14 }}>
              Välj vilka uppställningar som ska vara med.
            </p>
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              {teamLineups.map((l) => (
                <label key={`exp-${l.id}`} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={exportLineupIds.includes(l.id)}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setExportLineupIds((prev) => {
                        const set = new Set(prev);
                        if (on) set.add(l.id);
                        else set.delete(l.id);
                        const next = [...set];
                        return next.length ? next : [l.id];
                      });
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{l.name}</span>
                  <span className="text-muted" style={{ fontSize: 13 }}>
                    {l.formation.defenders}-{l.formation.midfielders}-{l.formation.attackers}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        <button type="button" className="btn btn--secondary btn--block" onClick={exportJson} disabled={!activeTeam}>
          Exportera testdata (JSON)
        </button>
        <button type="button" className="btn btn--secondary btn--block" onClick={() => copyLineup().catch((e) => setErr(e.message))} disabled={!activeTeam || !teamLineups.length}>
          Kopiera uppställningar
        </button>
        <button type="button" className="btn btn--secondary btn--block" onClick={() => copyShareLink().catch((e) => setErr(e.message))}>
          Kopiera delningslänk
        </button>
        <button type="button" className="btn btn--secondary btn--block" onClick={() => shareLineup().catch((e) => setErr(e.message))} disabled={!activeTeam || !teamLineups.length}>
          Dela uppställningar
        </button>
      </div>
    </section>
  );
}

function displayMatchResult(result) {
  return String(result || "")
    .trim()
    .replace(/\s*-\s*/g, "–");
}

function opponentRatingLabel(n) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x) || x < 1 || x > 5) return "";
  return `${"★".repeat(x)}${"☆".repeat(5 - x)} (${x}/5)`;
}

function matchReportHasContentForCopy(r) {
  if (!r || typeof r !== "object") return false;
  return Boolean(
    String(r.result || "").trim() ||
      String(r.positive || "").trim() ||
      String(r.negative || "").trim() ||
      r.opponentRating != null,
  );
}

function seasonYear() {
  return new Date().getFullYear();
}

/** Nästa match i kalenderordning som inte är spelad (fokus efter genomförd match). */
function pickNextUnplayedMatchId(matches, completedId) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const ordered = [...matches].sort(compareMatchesChronologically);
  const idx = ordered.findIndex((m) => m.id === completedId);
  const from = idx >= 0 ? idx + 1 : 0;
  for (let i = from; i < ordered.length; i++) {
    if (ordered[i].status !== "played") return ordered[i].id;
  }
  for (let i = 0; i < from; i++) {
    if (ordered[i].status !== "played") return ordered[i].id;
  }
  return null;
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

function fixtureOpponentLabel(m) {
  const home = String(m.fixture?.home || m.fixture?.homeTeam || "").trim();
  const away = String(m.fixture?.away || m.fixture?.awayTeam || "").trim();
  if (!home && !away) return "Motståndare saknas";
  if (/ifk\s*ölme/i.test(home) || /ifk\s*olme/i.test(home)) return away || home;
  if (/ifk\s*ölme/i.test(away) || /ifk\s*olme/i.test(away)) return home || away;
  return away || home;
}

function participationKindLabelSv(kind) {
  switch (kind) {
    case "played":
      return "Spelade";
    case "declined":
      return "Tackade nej";
    case "not_in_squad":
      return "Inte i truppen";
    case "squad_pending":
      return "Vald i truppen";
    case "squad_unavailable_played":
      return "Otillgänglig (i trupp)";
    case "squad_not_counted":
      return "I trupp, räknas inte";
    default:
      return "—";
  }
}

function participationKindStatusClass(kind) {
  if (kind === "played") return "player-history-modal__status player-history-modal__status--played";
  if (kind === "declined") return "player-history-modal__status player-history-modal__status--declined";
  if (kind === "squad_pending") return "player-history-modal__status player-history-modal__status--pending";
  return "player-history-modal__status player-history-modal__status--neutral";
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
function MatchLineupNames({
  playerIds,
  players,
  declinedPlayerIds = [],
  canToggleAvailability = false,
  onAttendanceAction,
}) {
  const declinedSet = useMemo(() => new Set(declinedPlayerIds || []), [declinedPlayerIds]);
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
            {p.available === false ? (
              <span className="lineup-list__status" title="Global frånvaro">
                {p.unavailableReason === "other" ? "Ej tillgänglig" : "Sjuk / frånvaro"}
              </span>
            ) : null}
            {declinedSet.has(p.id) && p.available !== false ? (
              <span className="lineup-list__status" title="Endast denna match">
                Tackar nej
              </span>
            ) : null}
          </span>
          <span className="lineup-list__year">{p.birthYear}</span>
          {canToggleAvailability ? (
            <span className="lineup-list__actions lineup-list__availability-btn">
              {p.available === false ? (
                <button
                  type="button"
                  className="btn btn--sm btn--secondary"
                  onClick={() => onAttendanceAction?.(p, "clear_sick")}
                >
                  Kryssa tillgänglig
                </button>
              ) : declinedSet.has(p.id) ? (
                <button
                  type="button"
                  className="btn btn--sm btn--secondary"
                  onClick={() => onAttendanceAction?.(p, "clear_declined")}
                >
                  Ångra tack nej
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn--sm btn--plain" onClick={() => onAttendanceAction?.(p, "sick")}>
                    Sjuk / frånvaro
                  </button>
                  <button type="button" className="btn btn--sm btn--plain" onClick={() => onAttendanceAction?.(p, "declined")}>
                    Tackar nej
                  </button>
                </>
              )}
            </span>
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
  const venue = String(fixture.venue || "").trim();
  const dateLabel = formatFixtureDateSv(fixture.date);
  const timeIsPlaceholder = fixture.time === "00:00";
  const homeLogo = fixture.homeLogo || fixture.home_logo || getStoredTeamLogo?.(homeTeam);
  const awayLogo = fixture.awayLogo || fixture.away_logo || getStoredTeamLogo?.(awayTeam);
  const mapsUrl = venue ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue)}` : "";
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
          {venue ? (
            <a
              className="fixture-block__venue fixture-block__venue-link"
              href={mapsUrl}
              target="_blank"
              rel="noreferrer"
              title="Öppna i Google Maps"
            >
              {venue}
              <span className="fixture-block__venue-hint">Tryck för vägbeskrivning</span>
            </a>
          ) : null}
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
    const n = players2015.length;
    return (
      <div className="callout callout--muted" role="status">
        <p style={{ margin: 0, fontWeight: 600 }}>2015-grupperna visas när spelarlistan stämmer</p>
        <p className="text-muted" style={{ margin: "8px 0 0" }}>
          För att redigera rotationen A/B/C behövs <strong>exakt nio</strong> spelare födda 2015 (tre per grupp).
          Antal födda 2015 just nu: <strong>{n}</strong>.
        </p>
        <p className="text-muted" style={{ margin: "8px 0 0", fontSize: 14 }}>
          Gå till fliken <strong>Spelare</strong>, lägg till eller ta bort spelare med födelseår 2015 tills antalet är nio — då visas gruppeditorn här.
        </p>
      </div>
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
  onMatchCompleted,
  cardTitle = "Match",
  displayNumber,
  getStoredTeamLogo,
}) {
  const squadMode = matchSquadMode(m);
  const series = typeof m.fixture?.series === "string" ? m.fixture.series : "";
  const isP11Series = series.includes("P 11");
  const isP11Branch = (m.branch || "p10") === "p11";
  const assist2016Target = isP11Series ? p11Assist2016Count(m, state) : 0;
  const n15 = m.selectedPlayerIds.filter((id) => players2015.some((p) => p.id === id)).length;
  const n16 = m.selectedPlayerIds.filter((id) => players2016.some((p) => p.id === id)).length;
  const n14 = m.selectedPlayerIds.filter((id) => birthYearNum(state.players.find((p) => p.id === id)) === 2014).length;
  const [showManual, setShowManual] = useState(false);
  const [manualIds, setManualIds] = useState([]);
  const [showManual2016, setShowManual2016] = useState(false);
  const [manual2016Ids, setManual2016Ids] = useState([]);
  const [assistDraft, setAssistDraft] = useState(() => String(m.fixture?.p11Assist2016 ?? 0));
  const [commentName, setCommentName] = useState(() => coachNames[0] || "Jonas");
  const [commentText, setCommentText] = useState("");
  const [editingCommentId, setEditingCommentId] = useState("");
  const [editingCommentText, setEditingCommentText] = useState("");
  const [formationDraft, setFormationDraft] = useState(() => ({
    defenders: Number(m.lineup?.formation?.defenders || 2),
    midfielders: Number(m.lineup?.formation?.midfielders || 2),
    attackers: Number(m.lineup?.formation?.attackers || 2),
  }));
  const sideDraft = "vänster";
  const [matchSubTab, setMatchSubTab] = useState("squad");
  const [positionDraftByPlayer, setPositionDraftByPlayer] = useState({});
  const [substitutionDraftByInPlayer, setSubstitutionDraftByInPlayer] = useState({});
  const lineupDraftSignatureRef = useRef("");
  const [matchDialog, setMatchDialog] = useState(null);
  const [reportForm, setReportForm] = useState({
    result: "",
    positive: "",
    negative: "",
    opponentRating: "",
  });
  const [reportBusy, setReportBusy] = useState(false);

  useEffect(() => {
    setAssistDraft(String(m.fixture?.p11Assist2016 ?? 0));
  }, [m.fixture?.p11Assist2016, m.id]);
  useEffect(() => {
    const lineupSig = JSON.stringify({
      id: m.id,
      selected: (m.selectedPlayerIds || []).slice().sort(),
      formation: {
        defenders: Number(m.lineup?.formation?.defenders || 2),
        midfielders: Number(m.lineup?.formation?.midfielders || 2),
        attackers: Number(m.lineup?.formation?.attackers || 2),
      },
      starters: (m.lineup?.starters || [])
        .map((row) => ({
          playerId: row?.playerId || "",
          role: row?.role || "",
          order: Number(row?.order || 0),
        }))
        .sort((a, b) => (a.order - b.order) || a.playerId.localeCompare(b.playerId)),
    });
    if (lineupDraftSignatureRef.current === lineupSig) return;
    lineupDraftSignatureRef.current = lineupSig;

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
    const nextSubs = {};
    for (const row of m.lineup?.substitutions || []) {
      const inId = String(row?.inPlayerId || "");
      const outId = String(row?.outPlayerId || "");
      if (inId && outId) nextSubs[inId] = outId;
    }
    setSubstitutionDraftByInPlayer(nextSubs);
  }, [m.id, m.lineup, m.selectedPlayerIds, state.players]);
  useEffect(() => {
    setMatchSubTab("squad");
  }, [m.id]);
  useEffect(() => {
    if (m.status === "played" && matchSubTab === "notes") setMatchSubTab("squad");
  }, [m.status, matchSubTab, m.id]);
  useEffect(() => {
    if (coachNames.length && !coachNames.includes(commentName)) {
      setCommentName(coachNames[0]);
    }
  }, [coachNames, commentName]);
  useEffect(() => {
    setEditingCommentId("");
    setEditingCommentText("");
  }, [m.id]);

  useEffect(() => {
    setMatchDialog(null);
    setReportForm({ result: "", positive: "", negative: "", opponentRating: "" });
    setReportBusy(false);
  }, [m.id]);

  useEffect(() => {
    if (!matchDialog) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setMatchDialog(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matchDialog]);

  const buildMatchReportPayload = () => {
    let rating = null;
    if (reportForm.opponentRating !== "" && reportForm.opponentRating != null) {
      const n = Math.round(Number(reportForm.opponentRating));
      if (Number.isFinite(n)) rating = Math.min(5, Math.max(1, n));
    }
    return {
      matchReport: {
        result: reportForm.result.trim(),
        positive: reportForm.positive.trim(),
        negative: reportForm.negative.trim(),
        opponentRating: rating,
      },
    };
  };

  const openCompleteDialog = () => {
    const r = m.matchReport;
    setReportForm({
      result: String(r?.result || ""),
      positive: String(r?.positive || ""),
      negative: String(r?.negative || ""),
      opponentRating: r?.opponentRating != null ? String(r.opponentRating) : "",
    });
    setMatchDialog("complete");
  };

  const openReportDialog = () => {
    const r = m.matchReport;
    setReportForm({
      result: String(r?.result || ""),
      positive: String(r?.positive || ""),
      negative: String(r?.negative || ""),
      opponentRating: r?.opponentRating != null ? String(r.opponentRating) : "",
    });
    setMatchDialog("report");
  };

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
  const declinedPlayerIds = Array.isArray(m.declinedPlayerIds) ? m.declinedPlayerIds : [];
  const declinedSet = new Set(declinedPlayerIds);
  const selectedRowsAll = m.selectedPlayerIds
    .map((id) => state.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.birthYear !== b.birthYear) return a.birthYear - b.birthYear;
      return a.name.localeCompare(b.name, "sv");
    });
  const selectedRows = selectedRowsAll.filter((p) => p.available !== false);
  const sickInSquadRows = selectedRowsAll.filter((p) => p.available === false);
  const declinedRows = declinedPlayerIds
    .map((id) => state.players.find((p) => p.id === id))
    .filter(Boolean)
    .filter((p) => (m.selectedPlayerIds || []).includes(p.id) && p.available !== false)
    .sort((a, b) => {
      if (a.birthYear !== b.birthYear) return a.birthYear - b.birthYear;
      return a.name.localeCompare(b.name, "sv");
    });
  const outfieldSlots = useMemo(() => buildOutfieldSlots(formationDraft), [formationDraft]);
  const selectedLineupIds = useMemo(() => new Set(selectedRows.map((p) => p.id)), [selectedRows]);
  const formationTotal = Number(formationDraft.defenders || 0) + Number(formationDraft.midfielders || 0) + Number(formationDraft.attackers || 0);
  const slotToPlayer = useMemo(() => {
    const map = {};
    for (const [playerId, slotKey] of Object.entries(positionDraftByPlayer || {})) {
      if (!selectedLineupIds.has(playerId)) continue;
      if (!slotKey || slotKey === "bench") continue;
      if (!map[slotKey]) map[slotKey] = playerId;
    }
    return map;
  }, [positionDraftByPlayer, selectedLineupIds]);
  const starterIds = Object.values(slotToPlayer).filter(Boolean);
  const startersUnique = new Set(starterIds).size === starterIds.length;
  const startersReady = Boolean(slotToPlayer.gk) && outfieldSlots.every((slot) => Boolean(slotToPlayer[slot.key])) && startersUnique;
  const savedLineupCount = Math.min(
    7,
    new Set((m.lineup?.starters || []).map((row) => String(row?.playerId || "")).filter(Boolean)).size,
  );
  const selectedById = useMemo(() => {
    const map = new Map();
    for (const p of selectedRows) map.set(p.id, p);
    return map;
  }, [selectedRows]);
  const benchPlayers = useMemo(
    () => selectedRows.filter((p) => (positionDraftByPlayer[p.id] || "bench") === "bench"),
    [selectedRows, positionDraftByPlayer],
  );
  const starterPlayers = useMemo(() => {
    const ids = [slotToPlayer.gk, ...outfieldSlots.map((slot) => slotToPlayer[slot.key])].filter(Boolean);
    return ids.map((id) => selectedById.get(id)).filter(Boolean);
  }, [slotToPlayer, outfieldSlots, selectedById]);
  const substitutionOutIds = benchPlayers
    .map((p) => String(substitutionDraftByInPlayer[p.id] || ""))
    .filter(Boolean);
  const substitutionsUnique = new Set(substitutionOutIds).size === substitutionOutIds.length;
  const plannedBenchByInId = useMemo(() => {
    const map = new Map();
    for (const bench of benchPlayers) {
      const outId = String(substitutionDraftByInPlayer[bench.id] || "");
      if (!outId) continue;
      map.set(bench.id, outId);
    }
    return map;
  }, [benchPlayers, substitutionDraftByInPlayer]);
  const plannedBenchPlayers = benchPlayers.filter((p) => plannedBenchByInId.has(p.id));
  const unassignedBenchPlayers = benchPlayers.filter((p) => !plannedBenchByInId.has(p.id));

  const names2015 = selectedRowsAll.filter((p) => birthYearNum(p) === 2015).map((p) => p.name);
  const names2016 = selectedRowsAll.filter((p) => birthYearNum(p) === 2016).map((p) => p.name);
  const names2014 = selectedRowsAll.filter((p) => birthYearNum(p) === 2014).map((p) => p.name);

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
    if (isP11Branch) {
      lines.push("");
      lines.push("2014 (med i P11-trupp):");
      if (names2014.length) lines.push(...names2014);
      else lines.push("—");
    }
    if (Array.isArray(m.comments) && m.comments.length) {
      lines.push("");
      lines.push("Kommentarer:");
      for (const c of m.comments) lines.push(`- ${c.name} (${formatTimestampSv(c.timestamp)}): ${c.text}`);
    }
    if (m.lineup?.starters?.length) {
      lines.push("");
      lines.push(`Startuppställning (${m.lineup.formation?.defenders || 0}-${m.lineup.formation?.midfielders || 0}-${m.lineup.formation?.attackers || 0})`);
      const starters = [...(m.lineup.starters || [])].sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      for (const s of starters) {
        lines.push(`- ${roleLabelSv(s.role)} ${s.lane || "central"}: ${playerName(s.playerId)}`);
      }
    }
    if (m.status === "played" && m.matchReport && matchReportHasContentForCopy(m.matchReport)) {
      lines.push("");
      lines.push("Matchrapport:");
      if (m.matchReport.result) lines.push(`Resultat: ${m.matchReport.result}`);
      if (m.matchReport.positive) lines.push(`Positivt: ${m.matchReport.positive}`);
      if (m.matchReport.negative) lines.push(`Minus / förbättring: ${m.matchReport.negative}`);
      if (m.matchReport.opponentRating != null) lines.push(`Motståndare: ${m.matchReport.opponentRating}/5`);
    }
    await navigator.clipboard.writeText(lines.join("\n"));
    setErr("");
    if (typeof onCopied === "function") onCopied("Lag kopierat till urklipp.");
  };

  const handleAttendanceAction = async (player, kind) => {
    setErr("");
    try {
      if (kind === "sick") {
        await api(`/api/players/${player.id}`, {
          method: "PUT",
          body: { available: false, unavailableReason: "sick" },
        });
        if (
          m.status !== "played" &&
          Array.isArray(m.selectedPlayerIds) &&
          m.selectedPlayerIds.includes(player.id)
        ) {
          const wantsReplacement = confirm(
            `${player.name} markerades som sjuk/frånvarande. Vill du uppdatera laget automatiskt med nästa i kön nu?`,
          );
          if (wantsReplacement) {
            await api(`/api/matches/${m.id}/select`, { method: "POST" });
            if (typeof onCopied === "function") onCopied("Laget uppdaterat med nästa i kön.");
          }
        }
      } else if (kind === "declined") {
        await api(`/api/matches/${m.id}/decline`, {
          method: "PUT",
          body: { playerId: player.id, declined: true },
        });
      } else if (kind === "clear_sick") {
        await api(`/api/players/${player.id}`, {
          method: "PUT",
          body: { available: true },
        });
        if (declinedSet.has(player.id)) {
          await api(`/api/matches/${m.id}/decline`, {
            method: "PUT",
            body: { playerId: player.id, declined: false },
          });
        }
      } else if (kind === "clear_declined") {
        await api(`/api/matches/${m.id}/decline`, {
          method: "PUT",
          body: { playerId: player.id, declined: false },
        });
      }
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
          {m.status === "played" && m.matchReport?.result ? (
            <span className="match-card__result-badge" title="Resultat">
              {displayMatchResult(m.matchReport.result)}
            </span>
          ) : m.status === "played" && m.matchReport?.opponentRating != null ? (
            <span className="match-card__rating-compact" title="Motståndare">
              {m.matchReport.opponentRating}/5
            </span>
          ) : m.status === "played" && m.matchReport && matchReportHasContentForCopy(m.matchReport) ? (
            <span className="badge badge--muted" title="Matchrapport sparad">
              Rapport
            </span>
          ) : null}
          {m.selectedPlayerIds?.length ? (
            <span className="match-card__lineup-progress" title="Sparad startuppställning">
              Startuppställning: {savedLineupCount}/7 fyllda
            </span>
          ) : null}
          {m.status === "played" && (
            <button type="button" className="btn btn--secondary btn--sm match-card__report-btn" onClick={openReportDialog}>
              Rapport
            </button>
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

      {(m.branch || "p10") !== "p11" && rotationView ? (
        <p className="match-card__next-group">
          Nästa grupp i tur: <strong>{rotationView.nextGroupLabel ?? "Grupp A"}</strong>
        </p>
      ) : null}

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
        {m.status !== "played" ? (
          <button
            type="button"
            role="tab"
            className="segmented__btn"
            aria-selected={matchSubTab === "notes"}
            onClick={() => setMatchSubTab("notes")}
          >
            Meddelanden
          </button>
        ) : null}
      </div>

      {matchSubTab === "squad" && <div className="match-card__body">
        {m.selectedPlayerIds.length > 0 ? (
          <>
            <p className="match-card__lineup-meta">
              <strong>{m.selectedPlayerIds.length}</strong> spelare
              {(n15 > 0 || n16 > 0 || (isP11Branch && n14 > 0)) && (
                <span className="match-card__lineup-breakdown">
                  {" "}
                  ·{" "}
                  {[
                    n15 > 0 ? `${n15} födda 2015` : null,
                    n16 > 0 ? `${n16} födda 2016` : null,
                    isP11Branch && n14 > 0 ? `${n14} födda 2014` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )}
            </p>
            <MatchLineupNames
              playerIds={m.selectedPlayerIds}
              players={state.players}
              declinedPlayerIds={declinedPlayerIds}
              canToggleAvailability={m.status !== "played"}
              onAttendanceAction={(p, kind) => {
                handleAttendanceAction(p, kind).catch(() => null);
              }}
            />
            {sickInSquadRows.length > 0 ? (
              <p className="text-muted" style={{ marginTop: 8 }}>
                Sjuk / frånvaro i truppen:{" "}
                {sickInSquadRows.map((p) => `${p.name} (${p.birthYear})`).join(", ")}
              </p>
            ) : null}
            {declinedRows.length > 0 ? (
              <p className="text-muted" style={{ marginTop: 8 }}>
                Tackar nej till matchen: {declinedRows.map((p) => `${p.name} (${p.birthYear})`).join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-muted">Inget uttag</p>
        )}
      </div>}

      {matchSubTab === "lineup" && m.selectedPlayerIds.length > 0 && selectedRows.length > 0 && (
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
            <div className="lineup-layout">
              <div className="lineup-layout__controls">
                <div className="lineup-dnd-help">Välj position för varje spelare.</div>
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
                {startersUnique && !startersReady ? (
                  <p className="text-muted">Varning: inte alla positioner är fyllda än. Du kan ändå spara utkastet.</p>
                ) : null}
                {benchPlayers.length > 0 ? (
                  <div className="lineup-substitutions">
                    <p className="text-muted" style={{ marginBottom: 6 }}>
                      Byten (valfritt): välj vem varje bänkspelare ska byta med.
                    </p>
                    {benchPlayers.map((bench) => (
                      <div key={`sub-${bench.id}`} className="field">
                        <span className="field__label">
                          {bench.name} {bench.jerseyNumber ? `#${bench.jerseyNumber}` : ""}
                        </span>
                        <select
                          className="field__select"
                          value={substitutionDraftByInPlayer[bench.id] || ""}
                          onChange={(e) =>
                            setSubstitutionDraftByInPlayer((prev) => ({
                              ...prev,
                              [bench.id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">Ingen planerad ersättning</option>
                          {starterPlayers.map((starter) => (
                            <option key={`sub-opt-${bench.id}-${starter.id}`} value={starter.id}>
                              {starter.name} {starter.jerseyNumber ? `#${starter.jerseyNumber}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {!substitutionsUnique ? (
                      <p className="text-muted">En startspelare kan bara väljas för ett planerat byte.</p>
                    ) : null}
                  </div>
                ) : null}
                <div className="btn-row" style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={formationTotal !== 6 || !startersUnique || !substitutionsUnique}
                    onClick={async () => {
                      setErr("");
                      try {
                        const starters = [
                          slotToPlayer.gk
                            ? { playerId: slotToPlayer.gk, role: "goalkeeper", lane: "central", order: 0 }
                            : null,
                          ...outfieldSlots.map((slot) =>
                            slotToPlayer[slot.key]
                              ? {
                                  playerId: slotToPlayer[slot.key],
                                  role: slot.role,
                                  lane: slot.lane,
                                  order: slot.order,
                                }
                              : null,
                          ),
                        ].filter(Boolean);
                        const substitutions = benchPlayers
                          .map((bench, idx) => ({
                            order: idx + 1,
                            outPlayerId: String(substitutionDraftByInPlayer[bench.id] || ""),
                            inPlayerId: bench.id,
                            note: "",
                          }))
                          .filter((row) => row.outPlayerId && row.inPlayerId);
                        await api(`/api/matches/${m.id}/lineup`, {
                          method: "PUT",
                          body: {
                            formation: formationDraft,
                            side: sideDraft,
                            starters,
                            substitutions,
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
              </div>
              <div className="lineup-layout__pitch">
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
                <div className="lineup-bench-under-pitch">
                  {plannedBenchPlayers.length > 0 ? (
                    <div className="match-card__planned-subs">
                      <p className="match-card__planned-subs-title">Planerade byten</p>
                      {plannedBenchPlayers.map((bench, idx) => (
                        <p key={`${bench.id}-${idx}`} className="match-card__planned-subs-item">
                          {bench.name} in för {playerName(plannedBenchByInId.get(bench.id))}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {unassignedBenchPlayers.length > 0 ? (
                    <p className="text-muted">
                      Bänk (ej planerat byte): {unassignedBenchPlayers.map((p) => p.name).join(", ")}
                    </p>
                  ) : benchPlayers.length > 0 ? (
                    <p className="text-muted">Alla bänkspelare har planerade byten.</p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {matchSubTab === "lineup" && m.selectedPlayerIds.length === 0 && <p className="text-muted">Välj lag först för att sätta laguppställning.</p>}
      {matchSubTab === "lineup" && m.selectedPlayerIds.length > 0 && selectedRows.length === 0 && (
        <p className="text-muted">Ingen tillgänglig spelare i truppen för laguppställning just nu.</p>
      )}

      {matchSubTab === "notes" && m.status !== "played" && (
        <div className="match-comments" aria-label="Meddelanden">
        <h4 className="panel__title" style={{ fontSize: 15, margin: "0 0 8px" }}>
          Meddelanden
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
            placeholder="Skriv meddelande (t.ex. sjukdom, transport, byten)"
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
            Lägg till meddelande
          </button>
        </div>
        <div className="match-comments__list">
          {(m.comments || []).length === 0 ? (
            <p className="text-muted">Inga meddelanden.</p>
          ) : (
            [...(m.comments || [])].reverse().map((c, i) => (
              <div key={c.id || `${c.timestamp}-${i}`} className="match-comments__item">
                <p style={{ margin: 0 }}>
                  <strong>{c.name}</strong> ({formatTimestampSv(c.timestamp)}):{" "}
                  {editingCommentId === (c.id || "") ? (
                    <textarea
                      className="field__input"
                      rows={2}
                      value={editingCommentText}
                      onChange={(e) => setEditingCommentText(e.target.value)}
                      style={{ marginTop: 6 }}
                    />
                  ) : (
                    c.text
                  )}
                </p>
                <div className="btn-row" style={{ marginTop: 6 }}>
                  {editingCommentId === (c.id || "") ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => {
                          setEditingCommentId("");
                          setEditingCommentText("");
                        }}
                      >
                        Avbryt
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={async () => {
                          const t = editingCommentText.trim();
                          if (!t) return;
                          setErr("");
                          try {
                            await api(`/api/matches/${m.id}/comments/${c.id}`, {
                              method: "PUT",
                              body: { text: t },
                            });
                            setEditingCommentId("");
                            setEditingCommentText("");
                            await load();
                          } catch (x) {
                            setErr(x.message);
                          }
                        }}
                      >
                        Spara
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => {
                          setEditingCommentId(String(c.id || ""));
                          setEditingCommentText(String(c.text || ""));
                        }}
                      >
                        Redigera
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={async () => {
                          if (!confirm("Ta bort detta meddelande?")) return;
                          setErr("");
                          try {
                            await api(`/api/matches/${m.id}/comments/${c.id}`, { method: "DELETE" });
                            if (editingCommentId === c.id) {
                              setEditingCommentId("");
                              setEditingCommentText("");
                            }
                            await load();
                          } catch (x) {
                            setErr(x.message);
                          }
                        }}
                      >
                        Ta bort
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      )}

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
          onClick={openCompleteDialog}
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

      {matchDialog ? (
        <div
          className="modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !reportBusy) setMatchDialog(null);
          }}
        >
          <div
            className="modal-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`match-dialog-title-${m.id}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h4 className="modal-sheet__title" id={`match-dialog-title-${m.id}`}>
              {matchDialog === "complete" ? "Genomför match" : "Matchrapport"}
            </h4>

            <div className="modal-sheet__field">
              <label className="field__label" htmlFor={`mr-result-${m.id}`}>
                Resultat
              </label>
              <input
                id={`mr-result-${m.id}`}
                className="field__input"
                type="text"
                inputMode="text"
                placeholder="t.ex. 3–1"
                value={reportForm.result}
                onChange={(e) => setReportForm((f) => ({ ...f, result: e.target.value }))}
                maxLength={40}
              />
            </div>
            <div className="modal-sheet__field">
              <label className="field__label" htmlFor={`mr-pos-${m.id}`}>
                Positivt att ta med
              </label>
              <textarea
                id={`mr-pos-${m.id}`}
                className="field__input"
                rows={3}
                value={reportForm.positive}
                onChange={(e) => setReportForm((f) => ({ ...f, positive: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div className="modal-sheet__field">
              <label className="field__label" htmlFor={`mr-neg-${m.id}`}>
                Förbättring / minus
              </label>
              <textarea
                id={`mr-neg-${m.id}`}
                className="field__input"
                rows={3}
                value={reportForm.negative}
                onChange={(e) => setReportForm((f) => ({ ...f, negative: e.target.value }))}
                maxLength={4000}
              />
            </div>
            <div className="modal-sheet__field">
              <label className="field__label" htmlFor={`mr-rate-${m.id}`}>
                Motståndare (1–5)
              </label>
              <select
                id={`mr-rate-${m.id}`}
                className="field__select"
                value={reportForm.opponentRating}
                onChange={(e) => setReportForm((f) => ({ ...f, opponentRating: e.target.value }))}
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={String(n)}>
                    {n} av 5
                  </option>
                ))}
              </select>
              {reportForm.opponentRating ? (
                <p className="modal-sheet__rating-preview">{opponentRatingLabel(Number(reportForm.opponentRating))}</p>
              ) : null}
            </div>

            <div className="modal-sheet__actions">
              <button type="button" className="btn btn--secondary" disabled={reportBusy} onClick={() => setMatchDialog(null)}>
                Avbryt
              </button>
              {matchDialog === "complete" ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={reportBusy}
                  onClick={async () => {
                    setErr("");
                    setReportBusy(true);
                    try {
                      await api(`/api/matches/${m.id}/complete`, {
                        method: "POST",
                        body: buildMatchReportPayload(),
                      });
                      setMatchDialog(null);
                      const nextState = await load({ silent: true });
                      onMatchCompleted?.(m.id, nextState);
                    } catch (x) {
                      setErr(x.message);
                    } finally {
                      setReportBusy(false);
                    }
                  }}
                >
                  {reportBusy ? "Sparar…" : "Markera som genomförd"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={reportBusy}
                  onClick={async () => {
                    setErr("");
                    setReportBusy(true);
                    try {
                      await api(`/api/matches/${m.id}/report`, {
                        method: "PUT",
                        body: buildMatchReportPayload(),
                      });
                      setMatchDialog(null);
                      await load();
                    } catch (x) {
                      setErr(x.message);
                    } finally {
                      setReportBusy(false);
                    }
                  }}
                >
                  {reportBusy ? "Sparar…" : "Spara rapport"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
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
  /** Statistik: vilket lags matcher som räknas (P10 / P11 / båda). */
  const [overviewTeam, setOverviewTeam] = useState("p10");
  /** Statistik: spelarfilter — «2015» betyder födda 2014 eller 2015 (en gemensam flik). */
  const [overviewPlayerYear, setOverviewPlayerYear] = useState("all");
  /** Statistik: spelare vars matchlista visas i modal */
  const [overviewHistoryPlayerId, setOverviewHistoryPlayerId] = useState(null);
  /** Underflikar inom Spelargrupp: spelarlista, grupper eller tränare */
  const [playerSubTab, setPlayerSubTab] = useState("players");
  /** Underflikar inom Matcher: P10 / P11 */
  const [activeMatchId, setActiveMatchId] = useState(null);
  /** Matcher-flik: lista kommande, spelade eller alla (med datum i kalender). */
  const [matchListScope, setMatchListScope] = useState("upcoming");
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
  const [bottomNavHidden, setBottomNavHidden] = useState(false);
  const cachedSnapshotRef = useRef(null);
  const restoringSettingsRef = useRef(false);
  const restoredSettingsRef = useRef(false);
  const lastScrollYRef = useRef(0);
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
    setBottomNavHidden(false);
  }, [tab]);

  useEffect(() => {
    const mm = window.matchMedia("(max-width: 720px)");
    let raf = 0;

    const isMobileNav = () => mm.matches;

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!isMobileNav()) {
          setBottomNavHidden(false);
          return;
        }
        const y = window.scrollY || document.documentElement.scrollTop || 0;
        const last = lastScrollYRef.current;
        const delta = y - last;
        lastScrollYRef.current = y;

        if (y < 36) {
          setBottomNavHidden(false);
          return;
        }

        if (delta > 8) setBottomNavHidden(true);
        else if (delta < -8) setBottomNavHidden(false);
      });
    };

    const onMq = () => {
      if (!mm.matches) setBottomNavHidden(false);
    };

    lastScrollYRef.current = window.scrollY || document.documentElement.scrollTop || 0;
    window.addEventListener("scroll", onScroll, { passive: true });
    mm.addEventListener("change", onMq);
    window.addEventListener("resize", onMq);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      mm.removeEventListener("change", onMq);
      window.removeEventListener("resize", onMq);
    };
  }, []);

  useEffect(() => {
    let cachedSnapshot = null;
    try {
      const cached = localStorage.getItem(LS_STATE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.matches && parsed.players) {
          cachedSnapshotRef.current = parsed;
          cachedSnapshot = parsed;
        }
      }
      const ui = localStorage.getItem(LS_UI_KEY);
      if (ui) {
        const parsedUi = JSON.parse(ui);
        if (parsedUi?.playerSubTab) setPlayerSubTab(parsedUi.playerSubTab);
        if (parsedUi?.overviewTeam && ["p10", "p11", "both"].includes(parsedUi.overviewTeam)) {
          setOverviewTeam(parsedUi.overviewTeam);
        } else if (parsedUi?.overviewBirth) {
          let ob = parsedUi.overviewBirth;
          if (ob === "all") ob = "p10";
          if (!["p10", "club", "2014", "2015", "2016"].includes(ob)) ob = "p10";
          setOverviewTeam(ob === "club" ? "both" : "p10");
        }
        if (parsedUi?.overviewPlayerYear && ["all", "2015", "2016"].includes(parsedUi.overviewPlayerYear)) {
          setOverviewPlayerYear(parsedUi.overviewPlayerYear);
        } else if (parsedUi?.overviewPlayerYear === "2014") {
          setOverviewPlayerYear("2015");
        } else if (parsedUi?.overviewBirth && ["2015", "2016"].includes(parsedUi.overviewBirth)) {
          setOverviewPlayerYear(parsedUi.overviewBirth);
        } else if (parsedUi?.overviewBirth === "2014") {
          setOverviewPlayerYear("2015");
        }
        if (parsedUi?.activeMatchId) setActiveMatchId(parsedUi.activeMatchId);
        if (parsedUi?.matchListScope && ["upcoming", "played", "all"].includes(parsedUi.matchListScope)) {
          setMatchListScope(parsedUi.matchListScope);
        }
        if (parsedUi?.icsUrl) setIcsUrl(parsedUi.icsUrl);
      }
    } catch {
      // Ignorera trasig localStorage och fortsätt med API.
    }
    load()
      .catch((e) => {
        if (cachedSnapshot) {
          setState(cachedSnapshot);
          setErr("");
        } else {
          setErr(e.message);
        }
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
        JSON.stringify({
          playerSubTab,
          overviewTeam,
          overviewPlayerYear,
          activeMatchId,
          matchListScope,
          icsUrl,
        }),
      );
    } catch {
      // Ignorera localStorage-fel.
    }
  }, [playerSubTab, overviewTeam, overviewPlayerYear, activeMatchId, matchListScope, icsUrl]);

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

  const overviewScopeStats = useMemo(() => {
    if (!state?.players || !state?.matches) {
      return {
        matchesTotal: 0,
        matchesPlayed: 0,
        byPlayer: new Map(),
        declines: new Map(),
      };
    }
    const scopedMatches = state.matches.filter((m) => {
      const br = m.branch === "p11" ? "p11" : "p10";
      if (overviewTeam === "both") return true;
      return overviewTeam === br;
    });
    const playedScope = scopedMatches.filter((m) => m.status === "played");
    const byPlayer = new Map();
    for (const p of state.players) {
      let n = 0;
      for (const m of playedScope) {
        if (playerCountsAsPlayedInMatchForTeamScope(m, p.id, state, overviewTeam)) {
          n++;
        }
      }
      byPlayer.set(p.id, { n });
    }
    const declines = new Map();
    for (const m of scopedMatches) {
      for (const id of m.declinedPlayerIds || []) {
        declines.set(id, (declines.get(id) || 0) + 1);
      }
    }
    return {
      matchesTotal: scopedMatches.length,
      matchesPlayed: playedScope.length,
      byPlayer,
      declines,
    };
  }, [state, overviewTeam]);

  const playersSortedForOverview = useMemo(() => {
    if (!state?.players) return [];
    const { byPlayer } = overviewScopeStats;
    return [...state.players].sort((a, b) => {
      const na = byPlayer.get(a.id)?.n ?? 0;
      const nb = byPlayer.get(b.id)?.n ?? 0;
      if (nb !== na) return nb - na;
      return a.name.localeCompare(b.name, "sv");
    });
  }, [state?.players, overviewScopeStats]);

  const playersAfterBirthFilter = useMemo(() => {
    return playersSortedForOverview.filter((p) => {
      const y = birthYearNum(p);
      if (overviewPlayerYear === "all") return true;
      if (overviewPlayerYear === "2015") return y === 2014 || y === 2015;
      return y === 2016;
    });
  }, [playersSortedForOverview, overviewPlayerYear]);

  const playersOverview = playersAfterBirthFilter;

  const overviewPlayerHistoryRows = useMemo(() => {
    if (!state?.matches || !overviewHistoryPlayerId) return [];
    const pid = overviewHistoryPlayerId;
    return [...state.matches].sort(compareMatchesChronologically).map((m) => ({
      match: m,
      kind: playerMatchParticipationKind(m, pid, state),
      dateLabel: formatFixtureDateSv(m.fixture?.date),
      opponent: fixtureOpponentLabel(m),
      branchLabel: matchBranchKey(m) === "p11" ? "P 11" : "P 10",
      matchNo: m.number != null ? String(m.number) : "—",
    }));
  }, [state, overviewHistoryPlayerId]);

  useEffect(() => {
    if (!overviewHistoryPlayerId) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOverviewHistoryPlayerId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overviewHistoryPlayerId]);

  const rotationView = state?.rotationView;

  const matchesCalendar = useMemo(() => {
    const arr = (state?.matches || []).filter((m) => parseIsoDateLocal(m.fixture?.date));
    return [...arr].sort(compareMatchesChronologically);
  }, [state?.matches]);

  const matchesForScheduleView = useMemo(() => {
    let arr = matchesCalendar;
    if (matchListScope === "upcoming") arr = arr.filter((m) => m.status !== "played");
    else if (matchListScope === "played") arr = arr.filter((m) => m.status === "played");
    return [...arr].sort(compareMatchesChronologically);
  }, [matchesCalendar, matchListScope]);

  const handleMatchCompleted = useCallback((completedId, nextState) => {
    setMatchListScope("upcoming");
    const matches = nextState?.matches || [];
    const nextId = pickNextUnplayedMatchId(matches, completedId);
    if (nextId) {
      setActiveMatchId(nextId);
      const nm = matches.find((x) => x.id === nextId);
      const dt = nm?.fixture?.date ? parseIsoDateLocal(nm.fixture.date) : null;
      if (dt) setCalendarMonthKey(monthKeyOf(new Date(dt.getFullYear(), dt.getMonth(), 1)));
    }
  }, []);
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
    const monthMatches = matchesForScheduleView.filter((m) => {
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
  }, [matchesForScheduleView, visibleCalendarMonth]);

  /** Kronologisk liste for mobil (månedsrute er for smal). */
  const calendarMonthAgenda = useMemo(() => {
    const { year, month } = visibleCalendarMonth;
    return matchesForScheduleView
      .filter((m) => {
        const dt = parseIsoDateLocal(m.fixture?.date);
        return dt && dt.getFullYear() === year && dt.getMonth() === month;
      })
      .sort(compareMatchesChronologically);
  }, [matchesForScheduleView, visibleCalendarMonth]);

  const players2015 = useMemo(
    () => (state?.players ? state.players.filter((p) => birthYearNum(p) === 2015) : []),
    [state?.players]
  );
  const players2016 = useMemo(
    () => (state?.players ? state.players.filter((p) => birthYearNum(p) === 2016) : []),
    [state?.players]
  );
  const sortedPlayersTable = useMemo(() => {
    const rows = [...(state?.players || [])];
    const dirMul = playersSort.dir === "desc" ? -1 : 1;
    const valueOf = (p, key) => {
      if (key === "name") return p.name || "";
      if (key === "jerseyNumber") return Number(p.jerseyNumber || 0);
      if (key === "preferredPosition") return p.preferredPosition || "";
      if (key === "birthYear") return birthYearNum(p) || 0;
      if (key === "group") return birthYearNum(p) === 2015 ? groupLetterFor2015Player(p.id, state?.groups2015) || "" : "";
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

  const [seasonSimulation, setSeasonSimulation] = useState(null);
  const [seasonSimBusy, setSeasonSimBusy] = useState(false);
  const runSeasonSimulation = useCallback(async () => {
    setErr("");
    setSeasonSimBusy(true);
    try {
      const data = await api("/api/simulate-season");
      setSeasonSimulation(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSeasonSimBusy(false);
    }
  }, []);
  const coachNames = useMemo(() => {
    if (Array.isArray(state?.coaches) && state.coaches.length) {
      return state.coaches.map((c) => c.name).filter(Boolean);
    }
    return state?.coachNames || ["Jonas", "Per", "Anders", "Kim"];
  }, [state?.coaches, state?.coachNames]);
  const teamNames = useMemo(() => {
    const byNorm = new Map();
    const addName = (raw) => {
      const value = String(raw || "").trim();
      if (!value) return;
      const normalized = normalizeTeamKey(value);
      if (!normalized) return;
      if (!byNorm.has(normalized)) byNorm.set(normalized, value);
    };
    for (const m of state?.matches || []) {
      addName(m.fixture?.home);
      addName(m.fixture?.away);
      addName(m.fixture?.homeTeam);
      addName(m.fixture?.awayTeam);
    }
    for (const key of Object.keys(state?.teamLogos || {})) {
      addName(key);
    }
    return [...byNorm.values()].sort((a, b) => a.localeCompare(b, "sv"));
  }, [state?.matches, state?.teamLogos]);
  const getStoredTeamLogo = useCallback(
    (teamName) => {
      if (!teamName) return "";
      const direct = state?.teamLogos?.[teamName];
      if (direct) return direct;
      const norm = normalizeTeamKey(teamName);
      const normalizedClub = normalizeClubName(teamName);
      const normalizedClubKey = normalizeTeamKey(normalizedClub);
      return (
        state?.teamLogos?.[norm] ||
        state?.teamLogos?.[normalizedClub] ||
        state?.teamLogos?.[normalizedClubKey] ||
        ""
      );
    },
    [state?.teamLogos],
  );

  useEffect(() => {
    const pool = state?.matches || [];
    if (!pool.length) return;
    if (activeMatchId && pool.some((m) => m.id === activeMatchId)) return;
    if (!matchesCalendar.length) {
      const pick = [...pool].sort(compareMatchesChronologically)[0];
      if (pick?.id) setActiveMatchId(pick.id);
      return;
    }
    const firstInVisibleMonth = matchesCalendar.find((m) => {
      const dt = parseIsoDateLocal(m.fixture?.date);
      return (
        dt &&
        dt.getFullYear() === visibleCalendarMonth.year &&
        dt.getMonth() === visibleCalendarMonth.month
      );
    });
    const pick = firstInVisibleMonth || matchesCalendar[0];
    if (pick?.id) setActiveMatchId(pick.id);
  }, [state?.matches, matchesCalendar, activeMatchId, visibleCalendarMonth.year, visibleCalendarMonth.month]);

  useEffect(() => {
    if (!activeMatchId || !matchesForScheduleView.length) return;
    if (matchesForScheduleView.some((m) => m.id === activeMatchId)) return;
    setActiveMatchId(matchesForScheduleView[0].id);
  }, [matchListScope, matchesForScheduleView, activeMatchId]);

  const activeMatch = useMemo(
    () => (state?.matches || []).find((x) => x.id === activeMatchId) || null,
    [state?.matches, activeMatchId],
  );
  const matchBoardItems = useMemo(
    () =>
      matchesCalendar
        .filter((m) => (m.comments || []).length > 0 && m.status !== "played")
        .map((m) => ({
          id: m.id,
          number: m.number,
          branch: (m.branch || "p10") === "p11" ? "P11" : "P10",
          opponent: calendarOpponentName(m),
          commentsCount: (m.comments || []).length,
          latestText: String((m.comments || [])[m.comments.length - 1]?.text || "").trim(),
          latestAuthor: String((m.comments || [])[m.comments.length - 1]?.name || "").trim(),
          updatedAt: (m.comments || [])[m.comments.length - 1]?.timestamp || m.fixture?.date || "",
        }))
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))),
    [matchesCalendar],
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
        Resultat: m.matchReport?.result ?? "—",
        "Motståndare (1–5)": m.matchReport?.opponentRating ?? "—",
        "Rapport positivt": m.matchReport?.positive ?? "—",
        "Rapport minus": m.matchReport?.negative ?? "—",
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
    XLSX.utils.book_append_sheet(wb, wsComments, "Meddelanden");
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
    <div className={`app${bottomNavHidden ? " app--bottom-nav-hidden" : ""}`}>
      <header className="app-header">
        <div className="app-header__brand">
          <img className="app-header__logo" src="/logos/ifk-olme.png" alt="IFK Ölme" />
          <div>
            <h1 className="app-title">Lagval</h1>
            <p className="app-footnote">IFK Ölme - 2015/2016</p>
          </div>
        </div>
        <div className="app-header__actions">
          <button
            type="button"
            className="app-install-btn"
            onClick={() => installApp().catch(() => null)}
            title="Installera som app på enheten"
            aria-label="Installera app"
          >
            Installera
          </button>
          {installHint ? (
            <p className="app-install-hint" role="status">
              {installHint}
            </p>
          ) : null}
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

      <div
        className={`segmented app-bottom-nav${bottomNavHidden ? " app-bottom-nav--hidden" : ""}`}
        role="tablist"
        aria-label="Huvudnavigering"
        aria-hidden={bottomNavHidden ? true : undefined}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            className="segmented__btn"
            tabIndex={bottomNavHidden ? -1 : undefined}
            onClick={() => {
              setBottomNavHidden(false);
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "players" && (
        <section className="panel" role="tabpanel" id="panel-players" aria-labelledby="tab-players">
          <h2 className="panel__title">Spelargrupp</h2>
          <p className="panel__lead">
            Spelare, grupper A/B/C för födda 2015 och 2016 (rotation). Födda 2014 följer automatiskt med i P 11-trupp;
            de ingår inte i P 10-matchtrupp. P 10: tre 2015 + alla tillgängliga 2016. Frånvaro: markera ej tillgänglig.
          </p>

          {rotationView && rotationView.groupsValid === false && (
            <div className="callout callout--muted" role="status">
              <strong>Ogiltiga 2015-grupper.</strong> Välj fliken <strong>Grupper</strong>: om det finns{" "}
              <strong>exakt nio</strong> spelare födda 2015 kan du fördela tre i A, B och C och spara. Annars
              justerar du först antalet 2015-spelare under <strong>Spelare</strong>.
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
                    <option value="2014">2014 (P11-trupp, ej P10)</option>
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
                        const gLet = birthYearNum(p) === 2015 ? groupLetterFor2015Player(p.id, state.groups2015) : null;
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
                                      <option value="2014">2014 (P11-trupp, ej P10)</option>
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
                            <td data-label="Grupp">
                              {birthYearNum(p) === 2015 ? (
                                gLet ? gLet : "—"
                              ) : birthYearNum(p) === 2014 ? (
                                <span className="text-muted" title="Födda 2014 läggs automatiskt till i P 11-trupp, inte i P 10">
                                  P11
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
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
                                          body: !cur ? { available: false, unavailableReason: "sick" } : { available: true },
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
          {matchBoardItems.length > 0 ? (
            <div className="group" style={{ padding: 12, marginBottom: 12 }}>
              <p className="panel__lead" style={{ margin: "0 0 8px" }}>
                Meddelanden: viktiga besked
              </p>
              <div className="match-board">
                {matchBoardItems.map((item) => (
                  <button key={item.id} type="button" className="match-board__item" onClick={() => openMatchDetail(item.id)}>
                    <div className="match-board__head">
                      <strong>
                        Match {item.number} · {item.branch}
                      </strong>
                      {item.commentsCount > 0 ? <span>{item.commentsCount} kommentar{item.commentsCount > 1 ? "er" : ""}</span> : null}
                    </div>
                    <div className="match-board__opponent">{item.opponent}</div>
                    <p className="match-board__note">
                      {item.latestAuthor ? <strong>{item.latestAuthor}: </strong> : null}
                      {item.latestText || "Inget meddelande."}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {rotationView && rotationView.groupsValid === false && (
            <div className="banner banner--error" role="status">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 12,
                  justifyContent: "space-between",
                }}
              >
                <span>
                  Ogiltiga 2015-grupper — öppna <strong>Spelargrupp → Grupper</strong> och spara A/B/C.
                </span>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setTab("players");
                    setPlayerSubTab("groups");
                  }}
                >
                  Öppna Grupper
                </button>
              </div>
            </div>
          )}
          {rotationView && rotationView.groups2016Valid === false && (
            <div className="banner banner--error" role="status">
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 12,
                  justifyContent: "space-between",
                }}
              >
                <span>
                  Ogiltiga 2016-grupper — öppna <strong>Spelargrupp → Grupper</strong> och spara A/B/C/Extra.
                </span>
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => {
                    setTab("players");
                    setPlayerSubTab("groups");
                  }}
                >
                  Öppna Grupper
                </button>
              </div>
            </div>
          )}

          <div className="matches-layout">
            <div className="matches-layout__toolbar matches-layout__toolbar--wrap">
              <div
                className="segmented segmented--filter segmented--scroll"
                role="group"
                aria-label="Vilka matcher som listas"
              >
                <button
                  type="button"
                  className="segmented__btn"
                  aria-selected={matchListScope === "upcoming"}
                  onClick={() => setMatchListScope("upcoming")}
                >
                  Kommande
                </button>
                <button
                  type="button"
                  className="segmented__btn"
                  aria-selected={matchListScope === "played"}
                  onClick={() => setMatchListScope("played")}
                >
                  Spelade
                </button>
                <button
                  type="button"
                  className="segmented__btn"
                  aria-selected={matchListScope === "all"}
                  onClick={() => setMatchListScope("all")}
                >
                  Alla
                </button>
              </div>
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
                  <ul className="calendar-month__agenda" aria-label="Matcher denna månad">
                    {calendarMonthAgenda.length === 0 ? (
                      <li className="calendar-agenda__empty">
                        {matchListScope === "upcoming"
                          ? "Inga kommande matcher den här månaden."
                          : matchListScope === "played"
                            ? "Inga spelade matcher den här månaden."
                            : "Inga matcher den här månaden."}
                      </li>
                    ) : (
                      calendarMonthAgenda.map((m) => {
                        const st = calendarStatus(m);
                        const branchLabel = (m.branch || "p10") === "p11" ? "P11" : "P10";
                        const opponent = calendarOpponentName(m);
                        const oppLogo = calendarOpponentLogo(m);
                        const hasUpdate = (m.comments || []).length > 0 && m.status !== "played";
                        const dt = parseIsoDateLocal(m.fixture?.date);
                        const dayNum = dt ? dt.getDate() : "";
                        const dow = dt
                          ? dt.toLocaleDateString("sv-SE", { weekday: "short" }).replace(/\.$/, "")
                          : "";
                        const monthShort = dt
                          ? dt.toLocaleDateString("sv-SE", { month: "short" }).replace(/\.$/, "")
                          : "";
                        return (
                          <li key={`agenda-${m.id}`}>
                            <button
                              type="button"
                              className={`calendar-agenda__row calendar-agenda__row--${branchLabel.toLowerCase()}${activeMatchId === m.id ? " calendar-agenda__row--active" : ""}`}
                              onClick={() => openMatchDetail(m.id)}
                              aria-label={`Match ${m.number}, ${branchLabel}, mot ${opponent}, ${calendarTimeLabel(m)}, ${st.label}`}
                            >
                              <div className="calendar-agenda__date" aria-hidden>
                                <span className="calendar-agenda__date-num">{dayNum}</span>
                                <span className="calendar-agenda__date-meta">
                                  {dow} {monthShort}
                                </span>
                              </div>
                              <div className="calendar-agenda__body">
                                <div className="calendar-agenda__top">
                                  <span className={`calendar-match__dot ${st.cls}`} aria-hidden />
                                  <strong>{branchLabel}</strong>
                                  <span className="calendar-agenda__matchnr">#{m.number}</span>
                                  {hasUpdate ? <span className="calendar-event__update">Medd.</span> : null}
                                </div>
                                <div className="calendar-agenda__opponent">
                                  <CalendarEventCrest name={oppLogo.name} logoUrl={oppLogo.logoUrl} />
                                  <span>{opponent}</span>
                                </div>
                              </div>
                              <div className="calendar-agenda__time">{calendarTimeLabel(m)}</div>
                            </button>
                          </li>
                        );
                      })
                    )}
                  </ul>
                  <div className="calendar-month__desktop">
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
                              {dayMatches.map((match) => {
                                const st = calendarStatus(match);
                                const branchLabel = (match.branch || "p10") === "p11" ? "P11" : "P10";
                                const opponent = calendarOpponentName(match);
                                const oppLogo = calendarOpponentLogo(match);
                                const hasUpdate = (match.comments || []).length > 0 && match.status !== "played";
                                return (
                                  <button
                                    key={match.id}
                                    type="button"
                                    className={`calendar-event calendar-event--${branchLabel.toLowerCase()}${activeMatchId === match.id ? " calendar-event--active" : ""}`}
                                    onClick={() => openMatchDetail(match.id)}
                                    title={`Match ${match.number} · ${branchLabel} · ${opponent} · ${calendarTimeLabel(match)} · ${st.label}`}
                                  >
                                    <div className="calendar-event__top">
                                      <span className={`calendar-match__dot ${st.cls}`} aria-hidden />
                                      <strong>{branchLabel}</strong>
                                      {hasUpdate ? <span className="calendar-event__update">Medd.</span> : null}
                                    </div>
                                    <div className="calendar-event__opponent">
                                      <CalendarEventCrest name={oppLogo.name} logoUrl={oppLogo.logoUrl} />
                                      <span>{opponent}</span>
                                    </div>
                                    <div className="calendar-event__time">
                                      {calendarTimeLabel(match)}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
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
                    onMatchCompleted={handleMatchCompleted}
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

          <p className="overview-meta">
            <span>
              Genomförda matcher
              {overviewTeam === "both"
                ? " (båda lagen)"
                : overviewTeam === "p11"
                  ? " (P 11)"
                  : " (P 10)"}
              : <strong>{overviewScopeStats.matchesPlayed}</strong> / {overviewScopeStats.matchesTotal}
            </span>
            <span>
              Visar <strong>{playersOverview.length}</strong> av <strong>{playersAfterBirthFilter.length}</strong> spelare
              {overviewPlayerYear === "2015"
                ? " födda 2014 eller 2015"
                : overviewPlayerYear === "2016"
                  ? " födda 2016"
                  : ""}
            </span>
          </p>

          <div className="filter-block">
            <span className="filter-block__label">Lag / matcher</span>
            <div className="segmented segmented--filter" role="group" aria-label="Vilket lags matcher som räknas">
              {[
                { id: "p10", label: "P 10" },
                { id: "p11", label: "P 11" },
                { id: "both", label: "Båda lagen" },
              ].map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="segmented__btn"
                  aria-selected={overviewTeam === o.id}
                  onClick={() => setOverviewTeam(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
              Siffrorna gäller valt lag. <strong>Båda lagen</strong> summerar P 10- och P 11-matcher (födda 2014 räknas
              bara som deltagare i P 11, samma regler som i truppen).
            </p>
          </div>

          <div className="filter-block">
            <span className="filter-block__label">Vilka spelare som visas</span>
            <div
              className="segmented segmented--filter segmented--scroll"
              role="group"
              aria-label="Filtrera spelare efter födelseår"
            >
              {[
                { id: "all", label: "Alle" },
                { id: "2015", label: "2014–2015" },
                { id: "2016", label: "2016" },
              ].map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className="segmented__btn"
                  aria-selected={overviewPlayerYear === o.id}
                  onClick={() => setOverviewPlayerYear(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <p className="text-muted" style={{ margin: "8px 0 0", fontSize: 13 }}>
              <strong>2014–2015</strong> visar alla födda 2014 och 2015 tillsammans (ingen egen knapp för bara 2014).
            </p>
          </div>

          <p className="text-muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
            Tryck på en spelare för alla matcher i ordning — du ser om spelaren deltog, inte var med i truppen eller
            tackade nej.
          </p>

          {playersOverview.length === 0 ? (
            <p className="empty-hint">Inga spelare matchar filtret.</p>
          ) : (
            <div className="stat-list stat-list--overview">
              <div className="stat-head" aria-hidden>
                <span>Namn</span>
                <span title="Födelseår">År</span>
                <span title="Genomförda matcher där spelaren räknas som deltagare (inom valt lag)">Matcher</span>
                <span title="Antal gånger spelaren tackat nej till match (inom valt lag)">Tackade nej</span>
              </div>
              {playersOverview.map((p) => {
                const sp = overviewScopeStats.byPlayer.get(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="stat-row--clickable"
                    onClick={() => setOverviewHistoryPlayerId(p.id)}
                  >
                    <p className="stat-row__name">
                      {p.name}
                      <span style={{ fontWeight: 400, color: "var(--text-secondary)", fontSize: 14 }}>
                        {" "}
                        · {playerAge(birthYearNum(p))} år
                      </span>
                    </p>
                    <span className="stat-row__year">
                      {Number.isFinite(birthYearNum(p)) ? birthYearNum(p) : "—"}
                    </span>
                    <span className="stat-row__value">{sp?.n ?? 0}</span>
                    <span className="stat-row__declined">{overviewScopeStats.declines.get(p.id) || 0}</span>
                  </button>
                );
              })}
            </div>
          )}

          {overviewHistoryPlayerId && state ? (
            <div
              className="modal-overlay"
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) setOverviewHistoryPlayerId(null);
              }}
            >
              <div
                className="modal-sheet modal-sheet--wide"
                role="dialog"
                aria-modal="true"
                aria-labelledby="player-history-title"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <h4 className="modal-sheet__title" id="player-history-title">
                  Matcher — {state.players.find((x) => x.id === overviewHistoryPlayerId)?.name ?? "Spelare"}
                </h4>
                <p className="player-history-modal__hint">
                  Alla matcher i kalenderordning för den här spelaren. «Spelade» = räknas som deltagare i genomförd
                  match (samma regler som i översikten). «Vald i truppen» = matchen är inte markerad som spelad än.
                </p>
                <ul className="player-history-modal__list">
                  {overviewPlayerHistoryRows.map((row) => (
                    <li key={row.match.id} className="player-history-modal__item">
                      <div>
                        <div className="player-history-modal__meta">
                          Match {row.matchNo} · {row.branchLabel}
                        </div>
                        <p className="player-history-modal__line">
                          {row.dateLabel} · {row.opponent}
                        </p>
                      </div>
                      <span className={participationKindStatusClass(row.kind)}>
                        {participationKindLabelSv(row.kind)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="modal-sheet__actions">
                  <button type="button" className="btn btn--secondary" onClick={() => setOverviewHistoryPlayerId(null)}>
                    Stäng
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="group" style={{ padding: 12, marginTop: 20 }}>
            <p className="panel__lead" style={{ margin: "0 0 6px" }}>
              Säsongssimulering
            </p>
            <p className="text-muted" style={{ margin: "0 0 10px", fontSize: 14 }}>
              Kör urvalsreglerna för alla matcher i datumordning (fast frö). Sparad data och riktiga matcher ändras inte.
            </p>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={seasonSimBusy}
              onClick={() => runSeasonSimulation().catch(() => null)}
            >
              {seasonSimBusy ? "Kör simulering…" : "Simulera hela säsongen"}
            </button>
            {seasonSimulation ? (
              <>
                <ul className="season-sim-messages">
                  {(seasonSimulation.validation?.messages || []).map((msg, i) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
                <details className="season-sim-details">
                  <summary>Matcher i simuleringen</summary>
                  <ol>
                    {(seasonSimulation.steps || []).map((s, i) => (
                      <li key={i}>
                        Match {s.match}: 2015-grupp {s.group ?? "—"}, 2016-grupp {s.group2016 ?? "—"}
                      </li>
                    ))}
                  </ol>
                </details>
                <div className="stat-list" style={{ marginTop: 12 }}>
                  <div className="stat-head" aria-hidden>
                    <span>Namn</span>
                    <span>År</span>
                    <span>Matcher (sim)</span>
                  </div>
                  {[...(seasonSimulation.perPlayer || [])]
                    .sort(
                      (a, b) =>
                        (Number(b.matchesPlayed) || 0) - (Number(a.matchesPlayed) || 0) ||
                        String(a.name).localeCompare(String(b.name), "sv"),
                    )
                    .map((p) => (
                      <div key={p.id} className="stat-row">
                        <p className="stat-row__name">{p.name}</p>
                        <span className="stat-row__year">{p.birthYear}</span>
                        <span className="stat-row__value">{p.matchesPlayed}</span>
                      </div>
                    ))}
                </div>
              </>
            ) : null}
          </div>

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

      {tab === "test" && <TestLabPanel setErr={setErr} setOkMsg={setOkMsg} />}

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
