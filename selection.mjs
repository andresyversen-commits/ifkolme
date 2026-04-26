/**
 * Urvalslogik — separerad från API/UI.
 *
 * ROTATION 2015
 * ---------------
 * Nio spelare födda 2015 ligger i tre fasta listor groups2015.A/B/C (tre id vardera).
 * Ordningen A → B → C → A … styrs av senast *genomförda* match (status "played")
 * och fältet intendedGroup2015 på den matchen. När en ny match väljs lag sätts
 * intendedGroup2015 till nästa bokstav oavsett manuella ersättare i spelarlistan.
 *
 * MIXAT LÄGE (utan P10/P11 i fixture)
 * ------------------------------------
 * Tre födda 2015 enligt rotation + alla tillgängliga födda 2016.
 * Endast spelare med available !== false kan väljas.
 *
 * TILLGÄNGLIGHET
 * ---------------
 * Spelare med available === false tas aldrig med i automatisk 2015- eller 2016-urval.
 * Saknas tillräckligt många tillgängliga 2015-spelare kastas fel (tränaren måste
 * justera tillgänglighet eller grupper).
 *
 * SERIETYP (fixture.series)
 * -------------------------
 * "P 10 …" → samma som blandat läge: tre födda 2015 (rotation A/B/C) + alla tillgängliga 2016.
 * "P 11 …" utan assist → alla tillgängliga födda 2015; inga 2016.
 * "P 11 …" med fixture.p11Assist2016 = N (N>0) → alla 2015 + N stycken 2016 enligt kö
 * (schemalagd 2016-grupp A/B/C, se groups2016) med manuellt alternativ.
 * Annat / saknas → tre 2015 + alla 2016.
 *
 * GRUPPER 2016
 * ------------
 * Första nio födda 2016 (namnordning) i groups2016 A/B/C (tre per grupp), övriga i groups2016Extra.
 */

export const GROUP_ORDER = ["A", "B", "C"];
export const MAX_2015_ON_FIELD = 3;

export function isPlayerAvailable(p) {
  return p && p.available !== false;
}

/** PRNG med fast frö — reproducerbar säsongssimulering. */
export function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function groupLabel(g) {
  if (g === "A" || g === "B" || g === "C") return `Grupp ${g}`;
  return String(g);
}

/** Bygg A/B/C från första nio 2015-spelarna (namnordning). Övriga 2015 ignoreras här. */
export function buildGroups2015FromPlayers(players) {
  const p2015 = players.filter((p) => p.birthYear === 2015).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const ids = p2015.map((p) => p.id).slice(0, 9);
  return {
    A: ids.slice(0, 3),
    B: ids.slice(3, 6),
    C: ids.slice(6, 9),
  };
}

/** Första nio födda 2016 → A/B/C (tre vardera), övriga i `groups2016Extra`. */
export function buildGroups2016FromPlayers(players) {
  const p2016 = players.filter((p) => p.birthYear === 2016).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const ids = p2016.map((p) => p.id);
  if (ids.length < 9) {
    return {
      groups2016: { A: [], B: [], C: [] },
      groups2016Extra: [...ids],
    };
  }
  return {
    groups2016: {
      A: ids.slice(0, 3),
      B: ids.slice(3, 6),
      C: ids.slice(6, 9),
    },
    groups2016Extra: ids.slice(9),
  };
}

/**
 * Sant om groups2015 är en partition av alla 2015-spelare med exakt tre per grupp
 * (kräver nio spelare födda 2015 totalt).
 */
export function validateGroups2015(state) {
  const p2015 = state.players.filter((p) => p.birthYear === 2015);
  if (p2015.length !== 9) return false;
  const g = state.groups2015;
  if (!g || !Array.isArray(g.A) || !Array.isArray(g.B) || !Array.isArray(g.C)) return false;
  if (g.A.length !== 3 || g.B.length !== 3 || g.C.length !== 3) return false;
  const all = [...g.A, ...g.B, ...g.C];
  if (new Set(all).size !== 9) return false;
  const set2015 = new Set(p2015.map((p) => p.id));
  for (const id of all) {
    if (!set2015.has(id)) return false;
  }
  for (const id of set2015) {
    if (!all.includes(id)) return false;
  }
  return true;
}

/** Om grupperna är ogiltiga: återskapa från nuvarande spelarlista. Returnerar om state ändrats. */
export function repairGroups2015IfNeeded(state) {
  if (validateGroups2015(state)) return false;
  state.groups2015 = buildGroups2015FromPlayers(state.players);
  return true;
}

/** Bakåtkompatibilitet: anrop som tidigare ensureGroups2015 → reparation vid behov. */
export function ensureGroups2015(state) {
  repairGroups2015IfNeeded(state);
}

export function validateGroups2016(state) {
  const g = state.groups2016;
  const extra = state.groups2016Extra;
  if (!g || !Array.isArray(g.A) || !Array.isArray(g.B) || !Array.isArray(g.C)) return false;
  if (!Array.isArray(extra)) return false;
  const p2016 = state.players.filter((p) => p.birthYear === 2016);
  const set2016 = new Set(p2016.map((p) => p.id));
  const inGroups = [...g.A, ...g.B, ...g.C];
  if (p2016.length < 9) {
    if (inGroups.length !== 0) return false;
    const exS = new Set(extra);
    if (exS.size !== extra.length) return false;
    for (const id of extra) {
      if (!set2016.has(id)) return false;
    }
    for (const id of set2016) {
      if (!exS.has(id)) return false;
    }
    return true;
  }
  if (g.A.length !== 3 || g.B.length !== 3 || g.C.length !== 3) return false;
  const all = [...inGroups, ...extra];
  if (new Set(all).size !== all.length) return false;
  for (const id of all) {
    if (!set2016.has(id)) return false;
  }
  for (const id of set2016) {
    if (!all.includes(id)) return false;
  }
  return true;
}

/** Om 2016-grupperna är ogiltiga: återskapa från spelarlista. */
export function repairGroups2016IfNeeded(state) {
  if (validateGroups2016(state)) return false;
  const built = buildGroups2016FromPlayers(state.players);
  state.groups2016 = built.groups2016;
  state.groups2016Extra = built.groups2016Extra;
  return true;
}

/** Sortering efter datum/tid (flera serier / P10+P11 i samma state). */
export function matchChronologicalKey(m) {
  const d = m.fixture?.date || "0000-01-01";
  const t = m.fixture?.time || "00:00";
  return `${d} ${t} ${m.id || ""}`;
}

export function compareMatchesChronologically(a, b) {
  return matchChronologicalKey(a).localeCompare(matchChronologicalKey(b));
}

export function lastCompletedMatch(state) {
  // 2015-rotationen A/B/C ska drivas av matcher där 3-mannagruppen faktiskt används.
  const played = state.matches
    .filter((m) => m.status === "played")
    .filter((m) => matchSquadMode(m) === "mixed");
  if (!played.length) return null;
  return played.reduce((a, b) => (compareMatchesChronologically(a, b) > 0 ? a : b));
}

export function computeNextGroup2015(state) {
  const last = lastCompletedMatch(state);
  if (!last) return "A";
  const g = last.intendedGroup2015;
  if (!g || !GROUP_ORDER.includes(g)) return "A";
  const i = GROUP_ORDER.indexOf(g);
  return GROUP_ORDER[(i + 1) % 3];
}

export function getLastPlayedSelectionIds(matches) {
  const last = lastCompletedMatch({ matches });
  return last?.selectedPlayerIds?.length ? [...last.selectedPlayerIds] : [];
}

export function getLastPlayed2015Ids(matches, players) {
  const ids = getLastPlayedSelectionIds(matches);
  return ids.filter((id) => players.find((p) => p.id === id && p.birthYear === 2015));
}

export function getLastPlayed2016Ids(matches, players) {
  const ids = getLastPlayedSelectionIds(matches);
  return ids.filter((id) => players.find((p) => p.id === id && p.birthYear === 2016));
}

export function lastCompletedMatchWith2016Group(state) {
  const played = state.matches.filter((m) => m.status === "played" && m.intendedGroup2016);
  if (!played.length) return null;
  return played.reduce((a, b) => (compareMatchesChronologically(a, b) > 0 ? a : b));
}

export function computeNextGroup2016(state) {
  const last = lastCompletedMatchWith2016Group(state);
  if (!last) return "A";
  const g = last.intendedGroup2016;
  if (!g || !GROUP_ORDER.includes(g)) return "A";
  const i = GROUP_ORDER.indexOf(g);
  return GROUP_ORDER[(i + 1) % 3];
}

export function inferIntendedGroup2016(groups2016, ids2016) {
  const ids = [...new Set(ids2016)].filter(Boolean);
  if (!ids.length) return "A";
  let best = "A";
  let bestScore = -1;
  for (const g of GROUP_ORDER) {
    const set = new Set(groups2016[g] || []);
    const score = ids.filter((id) => set.has(id)).length;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

export function inferIntendedGroup2015(groups2015, ids2015) {
  const ids = [...new Set(ids2015)].filter(Boolean);
  if (!ids.length) return "A";
  let best = "A";
  let bestScore = -1;
  for (const g of GROUP_ORDER) {
    const set = new Set(groups2015[g] || []);
    const score = ids.filter((id) => set.has(id)).length;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

export function backfillIntendedGroups2015(state) {
  repairGroups2015IfNeeded(state);
  const g = state.groups2015;
  let dirty = false;
  const played = [...state.matches]
    .filter((m) => m.status === "played")
    .sort(compareMatchesChronologically);
  for (const m of played) {
    const ids2015 = (m.selectedPlayerIds || []).filter((id) => {
      const pl = state.players.find((p) => p.id === id);
      return pl?.birthYear === 2015;
    });
    if (!m.intendedGroup2015 && ids2015.length) {
      m.intendedGroup2015 = inferIntendedGroup2015(g, ids2015);
      dirty = true;
    }
  }
  return dirty;
}

function attachRandomTieKeys(players, rng) {
  return players.map((p) => ({ ...p, _tie: rng() }));
}

/**
 * Fyller på 2015-platser upp till tre: först schemalagd grupp (tillgängliga),
 * därefter övriga tillgängliga 2015 sorterade efter minst matcher, slump vid lika,
 * undvik senast spelade 2015 om möjligt.
 */
export function fill2015Lineup(state, seedIds, rng) {
  repairGroups2015IfNeeded(state);
  const chosen = [...new Set(seedIds)].filter(Boolean);
  for (const id of chosen) {
    const pl = state.players.find((p) => p.id === id);
    if (!pl || pl.birthYear !== 2015 || !isPlayerAvailable(pl)) throw new Error("invalid_2015_pick");
  }
  if (chosen.length > MAX_2015_ON_FIELD) throw new Error("max_2015_exceeded");

  let out = [...chosen];
  const prev2015 = getLastPlayed2015Ids(state.matches, state.players);
  while (out.length < MAX_2015_ON_FIELD) {
    const pool = state.players.filter(
      (p) => p.birthYear === 2015 && isPlayerAvailable(p) && !out.includes(p.id)
    );
    if (!pool.length) throw new Error("cannot_field_three_2015");
    const withTie = attachRandomTieKeys(pool, rng);
    withTie.sort((a, b) => {
      if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
      const aPrev = prev2015.includes(a.id);
      const bPrev = prev2015.includes(b.id);
      if (aPrev !== bPrev) return aPrev ? 1 : -1;
      return a._tie - b._tie;
    });
    out.push(withTie[0].id);
  }
  return out.slice(0, MAX_2015_ON_FIELD);
}

/**
 * Fyller upp till `targetCount` platser med födda 2016: först seed, sedan kö
 * (minst matcher spelade, undvik senast spelade 2016 om möjligt, slump vid lika).
 */
export function fill2016Lineup(state, seedIds, targetCount, rng) {
  repairGroups2016IfNeeded(state);
  const chosen = [...new Set(seedIds)].filter(Boolean);
  for (const id of chosen) {
    const pl = state.players.find((p) => p.id === id);
    if (!pl || pl.birthYear !== 2016 || !isPlayerAvailable(pl)) throw new Error("invalid_2016_pick");
  }
  if (chosen.length > targetCount) throw new Error("max_2016_exceeded");

  let out = [...chosen];
  const prev2016 = getLastPlayed2016Ids(state.matches, state.players);
  while (out.length < targetCount) {
    const pool = state.players.filter(
      (p) => p.birthYear === 2016 && isPlayerAvailable(p) && !out.includes(p.id),
    );
    if (!pool.length) throw new Error("cannot_field_2016_assist");
    const withTie = attachRandomTieKeys(pool, rng);
    withTie.sort((a, b) => {
      if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
      const aPrev = prev2016.includes(a.id);
      const bPrev = prev2016.includes(b.id);
      if (aPrev !== bPrev) return aPrev ? 1 : -1;
      return a._tie - b._tie;
    });
    out.push(withTie[0].id);
  }
  return out.slice(0, targetCount);
}

function randomPickIds(ids, count, rng) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.max(0, count));
}

/**
 * Dynamisk kö för 2016-assist i P11:
 * - Räknar historik från genomförda p11Mixed-matcher.
 * - Minst antal assist först.
 * - Vid lika: den som spelade längst sedan (eller aldrig spelat) först.
 * - Därefter minst totala matcher, sedan slump vid exakt lika.
 */
function pickNext2016AssistIds(state, nAssist, rng) {
  const eligible = state.players.filter((p) => p.birthYear === 2016 && isPlayerAvailable(p));
  if (eligible.length < nAssist) throw new Error("cannot_field_2016_assist");

  const assistCount = new Map();
  const lastAssistOrder = new Map();
  const playedAssist = state.matches
    .filter((m) => m.status === "played")
    .filter((m) => matchSquadMode(m) === "p11Mixed")
    .sort(compareMatchesChronologically);

  for (let i = 0; i < playedAssist.length; i++) {
    const m = playedAssist[i];
    for (const id of m.selectedPlayerIds || []) {
      const pl = state.players.find((p) => p.id === id);
      if (pl?.birthYear !== 2016) continue;
      assistCount.set(id, (assistCount.get(id) || 0) + 1);
      lastAssistOrder.set(id, i);
    }
  }

  const withTie = attachRandomTieKeys(eligible, rng);
  withTie.sort((a, b) => {
    const aCount = assistCount.get(a.id) || 0;
    const bCount = assistCount.get(b.id) || 0;
    if (aCount !== bCount) return aCount - bCount;
    const aLast = lastAssistOrder.has(a.id) ? lastAssistOrder.get(a.id) : -1;
    const bLast = lastAssistOrder.has(b.id) ? lastAssistOrder.get(b.id) : -1;
    if (aLast !== bLast) return aLast - bLast;
    if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
    return a._tie - b._tie;
  });
  return withTie.slice(0, nAssist).map((p) => p.id);
}

export function validateOverride2016(state, overrideIds, exactCount) {
  if (!overrideIds?.length) return null;
  const uniq = [...new Set(overrideIds)];
  if (exactCount != null && uniq.length !== exactCount) throw new Error("override_2016_wrong_count");
  for (const id of uniq) {
    const pl = state.players.find((p) => p.id === id);
    if (!pl || pl.birthYear !== 2016) throw new Error("override_invalid_2016");
    if (!isPlayerAvailable(pl)) throw new Error("player_unavailable");
  }
  return uniq;
}

export function validateOverride2015(state, overrideIds, max = MAX_2015_ON_FIELD) {
  if (!overrideIds?.length) return null;
  const uniq = [...new Set(overrideIds)];
  if (uniq.length > max) throw new Error("override_too_many_2015");
  for (const id of uniq) {
    const pl = state.players.find((p) => p.id === id);
    if (!pl || pl.birthYear !== 2015) throw new Error("override_invalid_2015");
    if (!isPlayerAvailable(pl)) throw new Error("player_unavailable");
  }
  return uniq;
}

/** Antal födda 2016 som ska följa med i en P 11-match (kö/rotation). */
export function p11Assist2016Count(match, state) {
  const raw = Math.floor(Number(match?.fixture?.p11Assist2016 ?? 0));
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const cap = state.players.filter((p) => p.birthYear === 2016 && isPlayerAvailable(p)).length;
  return Math.min(raw, cap);
}

/**
 * P 10 ska numera alltid inkludera tre 2015-spelare (mixed). Äldre sparade trupper
 * med bara 2016 är ogiltiga — rensa så "Välj lag" kan köras om.
 */
export function stripLegacyP10SquadsIfNeeded(state) {
  let dirty = false;
  for (const m of state.matches || []) {
    if (m.status === "played") continue;
    if (m.branch === "p11") continue;
    const s = m.fixture?.series;
    if (typeof s !== "string" || !s.includes("P 10")) continue;
    const ids = m.selectedPlayerIds || [];
    if (!ids.length) continue;
    const has2015 = ids.some((id) => {
      const pl = state.players.find((p) => p.id === id);
      return pl?.birthYear === 2015;
    });
    if (!has2015) {
      m.selectedPlayerIds = [];
      m.intendedGroup2015 = null;
      m.intendedGroup2016 = null;
      m.selectionExplanation = null;
      dirty = true;
    }
  }
  return dirty;
}

/** Urvalsläge utifrån serierubrik (Min Fotboll / serieschema). */
export function matchSquadMode(match) {
  const s = match?.fixture?.series;
  if (typeof s !== "string") return "mixed";
  if (s.includes("P 11")) {
    const raw = Math.floor(Number(match?.fixture?.p11Assist2016 ?? 0));
    return Number.isFinite(raw) && raw > 0 ? "p11Mixed" : "all2015";
  }
  if (s.includes("P 10")) return "mixed";
  return "mixed";
}

function sortedAvailableIdsByYear(state, year) {
  return state.players
    .filter((p) => p.birthYear === year && isPlayerAvailable(p))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((p) => p.id);
}

/**
 * Välj lag för match. Sätter intendedGroup2015 = schemalagd rotation,
 * selectedPlayerIds, selectionExplanation.
 */
export function selectTeamForMatch(state, matchId, opts = {}) {
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const match = state.matches.find((m) => m.id === matchId);
  if (!match) throw new Error("match_not_found");
  if (match.status === "played") throw new Error("match_already_played");
  match.declinedPlayerIds = [];

  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  if (!validateGroups2015(state)) {
    throw new Error("groups2015_invalid");
  }

  const mode = matchSquadMode(match);

  if (mode === "p11Mixed") {
    if (!validateGroups2016(state)) throw new Error("groups2016_invalid");
    const nAssist = p11Assist2016Count(match, state);
    if (nAssist <= 0) throw new Error("p11_assist_zero");

    const ids2015 = sortedAvailableIdsByYear(state, 2015);
    if (!ids2015.length) throw new Error("no_available_2015");

    const scheduledGroup2015 = computeNextGroup2015(state);
    const scheduledGroup2016 = computeNextGroup2016(state);

    let ids2016Pick;
    let used2016Override = false;
    if (opts.override2016PlayerIds?.length) {
      ids2016Pick = validateOverride2016(state, opts.override2016PlayerIds, nAssist);
      used2016Override = true;
    } else {
      ids2016Pick = pickNext2016AssistIds(state, nAssist, rng);
    }

    match.intendedGroup2015 = scheduledGroup2015;
    match.intendedGroup2016 = inferIntendedGroup2016(state.groups2016, ids2016Pick);
    match.selectedPlayerIds = [...ids2015, ...ids2016Pick];

    const g15 = groupLabel(scheduledGroup2015);
    const g16 = groupLabel(match.intendedGroup2016);
    const text2015 = `P 11 med ${nAssist} födda 2016: alla tillgängliga 2015. Rotation 2015: ${g15}.`;
    const text2016 = used2016Override
      ? `2016: manuellt urval (${nAssist} spelare).`
      : `2016: ${nAssist} spelare enligt dynamisk kö (färst assist först, därefter längst sedan). Gruppreferens: ${g16}.`;
    match.selectionExplanation = { text2015, text2016 };
    return {
      scheduledGroup: scheduledGroup2015,
      scheduledGroup2016,
      usedOverride: Boolean(opts.override2015PlayerIds?.length),
      used2016Override,
      text2015,
      text2016,
    };
  }

  if (mode === "all2015") {
    if (opts.override2015PlayerIds?.length) {
      // Ignoreras — P11 utan assist tar alltid alla tillgängliga 2015.
    }
    const ids = sortedAvailableIdsByYear(state, 2015);
    if (!ids.length) throw new Error("no_available_2015");
    const scheduledGroup = computeNextGroup2015(state);
    match.intendedGroup2015 = scheduledGroup;
    match.intendedGroup2016 = null;
    match.selectedPlayerIds = [...ids];
    const gLabel = groupLabel(scheduledGroup);
    const text2015 = `P 11-serie: alla tillgängliga spelare födda 2015 tas ut. Omgången räknas i rotation som ${gLabel}.`;
    const text2016 = "P 11-serie: inga spelare födda 2016 tas ut i den här matchen.";
    match.selectionExplanation = { text2015, text2016 };
    return { scheduledGroup, usedOverride: false, text2015, text2016 };
  }

  const scheduledGroup = computeNextGroup2015(state);
  const canonicalIds = [...(state.groups2015[scheduledGroup] || [])];

  let seed2015;
  let usedOverride = false;
  if (opts.override2015PlayerIds?.length) {
    seed2015 = validateOverride2015(state, opts.override2015PlayerIds);
    usedOverride = true;
  } else {
    seed2015 = canonicalIds.filter((id) => {
      const pl = state.players.find((p) => p.id === id);
      return isPlayerAvailable(pl);
    });
  }

  const ids2015 = fill2015Lineup(state, seed2015, rng);
  const ids2016 = sortedAvailableIdsByYear(state, 2016);
  if (!ids2016.length) throw new Error("no_available_2016");

  match.intendedGroup2015 = scheduledGroup;
  match.intendedGroup2016 = null;
  match.selectedPlayerIds = [...ids2015, ...ids2016];

  const gLabel = groupLabel(scheduledGroup);
  const text2015 = usedOverride
    ? `2015: ${gLabel} vald enligt rotationsschema; manuella ersättare för otillgängliga spelare.`
    : `2015: ${gLabel} vald enligt rotationsschema.`;
  const text2016 = "2016: Alla tillgängliga spelare födda 2016 tas ut.";

  match.selectionExplanation = { text2015, text2016 };
  return { scheduledGroup, usedOverride, text2015, text2016 };
}

export function simulateFullSeason(state) {
  const clone = JSON.parse(JSON.stringify(state));
  repairGroups2015IfNeeded(clone);
  repairGroups2016IfNeeded(clone);
  for (const p of clone.players) {
    p.matchesPlayed = 0;
    p.lastPlayedMatchNumber = null;
    p.available = true;
  }
  for (const m of clone.matches) {
    m.status = "not_played";
    m.selectedPlayerIds = [];
    m.intendedGroup2015 = null;
    m.intendedGroup2016 = null;
    m.selectionExplanation = null;
  }

  const rng = makeRng(0xdecafbad);
  const steps = [];
  const ordered = [...clone.matches].sort(compareMatchesChronologically);

  for (const m of ordered) {
    selectTeamForMatch(clone, m.id, { rng });
    m.status = "played";
    for (const id of m.selectedPlayerIds) {
      const pl = clone.players.find((p) => p.id === id);
      if (pl) {
        pl.matchesPlayed = (pl.matchesPlayed || 0) + 1;
        pl.lastPlayedMatchNumber = m.number;
      }
    }
    steps.push({
      match: m.number,
      group: m.intendedGroup2015,
      group2016: m.intendedGroup2016,
      selected2015: m.selectedPlayerIds.filter((id) => clone.players.find((p) => p.id === id)?.birthYear === 2015),
      selected2016: m.selectedPlayerIds.filter((id) => clone.players.find((p) => p.id === id)?.birthYear === 2016),
    });
  }

  const validation = validateSeasonDistribution(clone.players, ordered.length, ordered);
  const perPlayer = clone.players.map((p) => ({
    id: p.id,
    name: p.name,
    birthYear: p.birthYear,
    matchesPlayed: p.matchesPlayed,
  }));

  return { steps, perPlayer, validation };
}

export function validateSeasonDistribution(players, matchCount = 13, matches = null) {
  const p15 = players.filter((p) => p.birthYear === 2015);
  const p16 = players.filter((p) => p.birthYear === 2016);
  const n15 = p15.length;
  const n16 = p16.length;
  const c15 = p15.map((p) => p.matchesPlayed);
  const c16 = p16.map((p) => p.matchesPlayed);
  const min15 = c15.length ? Math.min(...c15) : 0;
  const max15 = c15.length ? Math.max(...c15) : 0;
  const min16 = c16.length ? Math.min(...c16) : 0;
  const max16 = c16.length ? Math.max(...c16) : 0;
  const spread15 = max15 - min15;
  const spread16 = max16 - min16;

  const list = Array.isArray(matches) ? matches : [];
  const hasMatchContext = list.length > 0;
  const nMatches = Math.max(1, Number(matchCount) || list.length || 13);
  const totalSlots2015 = hasMatchContext
    ? list.reduce((acc, m) => {
        const mode = matchSquadMode(m);
        if (mode === "all2015" || mode === "p11Mixed") return acc + n15;
        if (mode === "mixed") return acc + Math.min(MAX_2015_ON_FIELD, n15);
        return acc;
      }, 0)
    : nMatches * Math.min(MAX_2015_ON_FIELD, n15);
  const totalSlots2016 = hasMatchContext
    ? list.reduce((acc, m) => {
        const mode = matchSquadMode(m);
        if (mode === "mixed") return acc + n16;
        if (mode === "p11Mixed") {
          const raw = Math.floor(Number(m?.fixture?.p11Assist2016 ?? 0));
          const assist = Number.isFinite(raw) ? Math.max(0, Math.min(raw, n16)) : 0;
          return acc + assist;
        }
        return acc;
      }, 0)
    : nMatches * n16;

  const expected2015PerPlayer = n15 ? totalSlots2015 / n15 : 0;
  const expected2016PerPlayer = n16 ? totalSlots2016 / n16 : 0;
  const floor15 = Math.floor(expected2015PerPlayer);
  const ceil15 = Math.ceil(expected2015PerPlayer);
  const floor16 = Math.floor(expected2016PerPlayer);
  const ceil16 = Math.ceil(expected2016PerPlayer);

  const skip2015Fairness = totalSlots2015 === 0;
  const skip2016Fairness = totalSlots2016 === 0;

  const ok2015 = skip2015Fairness ? true : n15 > 0 ? spread15 <= 1 && min15 >= floor15 && max15 <= ceil15 : true;

  const ok2016 = skip2016Fairness ? true : n16 > 0 ? spread16 <= 1 && min16 >= floor16 && max16 <= ceil16 : true;

  const messages = [];
  if (skip2015Fairness) messages.push("Inga 2015-platser i matchkonfigurationen.");
  if (skip2016Fairness) messages.push("Inga 2016-platser i matchkonfigurationen.");
  if (!ok2015 && !skip2015Fairness)
    messages.push(`2015: spridning ${min15}–${max15} (förväntat ca ${floor15}–${ceil15} i denna kalender).`);
  if (!ok2016 && !skip2016Fairness)
    messages.push(`2016: spridning ${min16}–${max16} (förväntat ca ${floor16}–${ceil16} i denna kalender).`);
  if (ok2015 && ok2016) messages.push("Simulering: fördelning inom mål för aktuella serieregler.");

  return { ok2015, ok2016, ok: ok2015 && ok2016, min15, max15, min16, max16, spread15, spread16, messages };
}

export function rotationQueueSummary(state) {
  repairGroups2015IfNeeded(state);
  const played = state.matches.filter((m) => m.status === "played" && m.intendedGroup2015);
  return GROUP_ORDER.map((g) => {
    const forG = played.filter((m) => m.intendedGroup2015 === g);
    let lastM = null;
    for (const m of forG) {
      if (!lastM || compareMatchesChronologically(m, lastM) > 0) lastM = m;
    }
    return {
      id: g,
      label: groupLabel(g),
      lastMatchNumber: lastM?.number ?? null,
      lastMatchDate: lastM?.fixture?.date ?? null,
      playerNames: (state.groups2015[g] || []).map((id) => state.players.find((p) => p.id === id)?.name || id),
    };
  });
}

export function rotationQueueSummary2016(state) {
  repairGroups2016IfNeeded(state);
  const played = state.matches.filter((m) => m.status === "played" && m.intendedGroup2016);
  return GROUP_ORDER.map((g) => {
    const forG = played.filter((m) => m.intendedGroup2016 === g);
    let lastM = null;
    for (const m of forG) {
      if (!lastM || compareMatchesChronologically(m, lastM) > 0) lastM = m;
    }
    return {
      id: g,
      label: groupLabel(g),
      lastMatchNumber: lastM?.number ?? null,
      lastMatchDate: lastM?.fixture?.date ?? null,
      playerNames: (state.groups2016[g] || []).map((id) => state.players.find((p) => p.id === id)?.name || id),
    };
  });
}

export function buildRotationView(state) {
  repairGroups2015IfNeeded(state);
  repairGroups2016IfNeeded(state);
  const nextGroup2015 = validateGroups2015(state) ? computeNextGroup2015(state) : "A";
  const canonical2015Ids = validateGroups2015(state)
    ? [...(state.groups2015[nextGroup2015] || [])].slice(0, MAX_2015_ON_FIELD)
    : [];
  const nextGroup2016 = validateGroups2016(state) ? computeNextGroup2016(state) : "A";
  const canonical2016Ids = validateGroups2016(state)
    ? [...(state.groups2016[nextGroup2016] || [])].slice(0, 3)
    : [];
  return {
    nextGroup2015,
    nextGroupLabel: groupLabel(nextGroup2015),
    canonical2015Ids,
    nextGroup2016,
    nextGroup2016Label: groupLabel(nextGroup2016),
    canonical2016Ids,
    queue: rotationQueueSummary(state),
    queue2016: rotationQueueSummary2016(state),
    groupsValid: validateGroups2015(state),
    groups2016Valid: validateGroups2016(state),
  };
}
