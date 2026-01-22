import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Decision Helper (client-side only)
 * - Manage multiple decisions
 * - Each decision: criteria with weights, options with scores, computed rankings
 * - LocalStorage persistence
 * - Simple SVG charts (no external chart libs)
 */

/** Storage key for persisted app state. */
const STORAGE_KEY = "decision_helper:v1";

/** App constants */
const DEFAULT_WEIGHT = 3;
const DEFAULT_SCORE = 3;
const MIN_WEIGHT = 0;
const MAX_WEIGHT = 10;
const MIN_SCORE = 0;
const MAX_SCORE = 10;

/** @returns {string} A reasonably unique id for client-side entities. */
function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** @returns {number} value clamped to [min, max] */
function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** @returns {number} safe parsed number */
function toNumber(value, fallback = 0) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Compute normalized weights so that each criterion's weight is weight/sum(weights).
 * If sum is 0, all normalized weights are 0 (no-op).
 */
function normalizeWeights(criteria) {
  const sum = criteria.reduce((acc, c) => acc + toNumber(c.weight, 0), 0);
  if (sum <= 0) {
    return criteria.map((c) => ({ ...c, normalizedWeight: 0 }));
  }
  return criteria.map((c) => ({
    ...c,
    normalizedWeight: toNumber(c.weight, 0) / sum,
  }));
}

/**
 * Compute option totals:
 * total = Σ (normalizedWeight * scoreNormalized)
 * where scoreNormalized = score / MAX_SCORE (0..1)
 *
 * Returns array of { optionId, total (0..1), total100 (0..100), breakdownByCriterionId }
 */
function computeTotals(decision) {
  const criteriaN = normalizeWeights(decision.criteria || []);
  const criteriaById = new Map(criteriaN.map((c) => [c.id, c]));
  const options = decision.options || [];

  return options.map((opt) => {
    let total = 0;
    const breakdownByCriterionId = {};
    for (const [criterionId, rawScore] of Object.entries(opt.scores || {})) {
      const c = criteriaById.get(criterionId);
      if (!c) continue;
      const score = clamp(toNumber(rawScore, 0), MIN_SCORE, MAX_SCORE);
      const scoreNormalized = score / MAX_SCORE;
      const contrib = (c.normalizedWeight || 0) * scoreNormalized;
      breakdownByCriterionId[criterionId] = {
        score,
        normalizedWeight: c.normalizedWeight || 0,
        contrib,
      };
      total += contrib;
    }

    // Criteria that exist but have no score should count as 0 score (still 0 contrib).
    for (const c of criteriaN) {
      if (breakdownByCriterionId[c.id]) continue;
      breakdownByCriterionId[c.id] = {
        score: 0,
        normalizedWeight: c.normalizedWeight || 0,
        contrib: 0,
      };
    }

    return {
      optionId: opt.id,
      total,
      total100: Math.round(total * 1000) / 10, // 1 decimal
      breakdownByCriterionId,
    };
  });
}

/** Sort option totals descending by total, stable by option name as tie-breaker. */
function rankOptions(decision) {
  const totals = computeTotals(decision);
  const optionById = new Map((decision.options || []).map((o) => [o.id, o]));
  return totals
    .map((t) => ({
      ...t,
      option: optionById.get(t.optionId),
    }))
    .filter((x) => x.option)
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (a.option.name || "").localeCompare(b.option.name || "");
    });
}

/**
 * Create a decision copy with the same data, but replace criteria weights from a map.
 * This allows sensitivity analysis to reuse the existing scoring/ranking logic unchanged.
 */
function applyWeightOverrides(decision, overridesByCriterionId) {
  const nextCriteria = (decision.criteria || []).map((c) => ({
    ...c,
    weight:
      overridesByCriterionId && Object.prototype.hasOwnProperty.call(overridesByCriterionId, c.id)
        ? overridesByCriterionId[c.id]
        : c.weight,
  }));
  return { ...decision, criteria: nextCriteria };
}

/**
 * Compute sensitivity for varying one criterion's weight from MIN_WEIGHT..MAX_WEIGHT while keeping
 * other weights constant.
 *
 * Result includes:
 * - baselineRankByOptionId: current rank for each option (1..n)
 * - points: per-weight result with rank changes
 */
function computeSensitivityOneCriterion(decision, criterionId, step = 1) {
  const crit = (decision.criteria || []).find((c) => c.id === criterionId);
  if (!crit) return null;

  const baseline = rankOptions(decision);
  const baselineRankByOptionId = {};
  baseline.forEach((r, idx) => {
    baselineRankByOptionId[r.optionId] = idx + 1;
  });

  const points = [];
  for (let w = MIN_WEIGHT; w <= MAX_WEIGHT; w += step) {
    const overriddenDecision = applyWeightOverrides(decision, { [criterionId]: w });
    const ranked = rankOptions(overriddenDecision);
    const rankByOptionId = {};
    ranked.forEach((r, idx) => {
      rankByOptionId[r.optionId] = idx + 1;
    });

    const top = ranked[0];
    points.push({
      weight: w,
      topOptionId: top?.optionId || null,
      topOptionName: top?.option?.name || "",
      rankByOptionId,
    });
  }

  // Summaries: how many times each option becomes #1, and max rank movement vs baseline.
  const winCountByOptionId = {};
  const maxDeltaByOptionId = {};
  for (const p of points) {
    if (p.topOptionId) winCountByOptionId[p.topOptionId] = (winCountByOptionId[p.topOptionId] || 0) + 1;
    for (const [optionId, rankNow] of Object.entries(p.rankByOptionId)) {
      const baseRank = baselineRankByOptionId[optionId] ?? null;
      if (!baseRank) continue;
      const delta = Math.abs(rankNow - baseRank);
      maxDeltaByOptionId[optionId] = Math.max(maxDeltaByOptionId[optionId] || 0, delta);
    }
  }

  return {
    criterion: crit,
    baselineRankByOptionId,
    points,
    winCountByOptionId,
    maxDeltaByOptionId,
  };
}

/** Create a starter decision */
function createDecision(name = "New Decision") {
  const c1 = { id: uid(), name: "Cost", weight: 4 };
  const c2 = { id: uid(), name: "Impact", weight: 5 };
  const c3 = { id: uid(), name: "Effort", weight: 3 };

  const o1 = { id: uid(), name: "Option A", notes: "", scores: {} };
  const o2 = { id: uid(), name: "Option B", notes: "", scores: {} };

  // Seed scores
  o1.scores[c1.id] = 7;
  o1.scores[c2.id] = 6;
  o1.scores[c3.id] = 4;

  o2.scores[c1.id] = 5;
  o2.scores[c2.id] = 8;
  o2.scores[c3.id] = 6;

  return {
    id: uid(),
    name,
    description: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    criteria: [c1, c2, c3],
    options: [o1, o2],
  };
}

/** Load persisted state from LocalStorage with basic validation and fallback. */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const initial = { decisions: [createDecision("Example Decision")], activeDecisionId: null, theme: "light" };
      initial.activeDecisionId = initial.decisions[0].id;
      return initial;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid state");
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const theme = parsed.theme === "dark" ? "dark" : "light";
    let activeDecisionId = parsed.activeDecisionId;
    if (!activeDecisionId && decisions.length > 0) activeDecisionId = decisions[0].id;
    if (activeDecisionId && !decisions.some((d) => d.id === activeDecisionId) && decisions.length > 0) {
      activeDecisionId = decisions[0].id;
    }
    return { decisions, activeDecisionId, theme };
  } catch (e) {
    // If parsing fails, start fresh.
    const initial = { decisions: [createDecision("Example Decision")], activeDecisionId: null, theme: "light" };
    initial.activeDecisionId = initial.decisions[0].id;
    return initial;
  }
}

/** Persist state to LocalStorage (best-effort). */
function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore quota/security errors; app continues without persistence
  }
}

/** Simple inline SVG horizontal bar chart. */
function BarChart({ rows, maxValue = 100 }) {
  // rows: [{label, value (0..maxValue), subLabel}]
  const width = 560;
  const rowHeight = 28;
  const barMaxWidth = 280;
  const height = Math.max(1, rows.length) * rowHeight + 18;

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Rankings bar chart">
      <text x="0" y="14" className="chartTitle">
        Rankings
      </text>
      {rows.map((r, i) => {
        const y = 28 + i * rowHeight;
        const barW = (clamp(r.value, 0, maxValue) / maxValue) * barMaxWidth;
        return (
          <g key={r.label} transform={`translate(0, ${y})`}>
            <text x="0" y="12" className="chartLabel">
              {r.label}
            </text>
            <rect x="190" y="0" width={barMaxWidth} height="16" rx="8" className="chartTrack" />
            <rect x="190" y="0" width={barW} height="16" rx="8" className="chartBar" />
            <text x="480" y="12" className="chartValue">
              {r.value.toFixed(1)}%
            </text>
            {r.subLabel ? (
              <text x="190" y="28" className="chartSubLabel">
                {r.subLabel}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** UI atom for empty states */
function EmptyState({ title, description, action }) {
  return (
    <div className="emptyState" role="status" aria-live="polite">
      <div className="emptyStateTitle">{title}</div>
      <div className="emptyStateDesc">{description}</div>
      {action ? <div className="emptyStateAction">{action}</div> : null}
    </div>
  );
}

/** Reusable modal */
function Modal({ title, children, onClose, footer }) {
  // Close on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={title} onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div className="modalTitle">{title}</div>
          <button className="iconBtn" onClick={onClose} aria-label="Close modal">
            ✕
          </button>
        </div>
        <div className="modalBody">{children}</div>
        {footer ? <div className="modalFooter">{footer}</div> : null}
      </div>
    </div>
  );
}

// PUBLIC_INTERFACE
function App() {
  const loaded = useMemo(() => loadState(), []);
  const [theme, setTheme] = useState(loaded.theme || "light");
  const [decisions, setDecisions] = useState(loaded.decisions || []);
  const [activeDecisionId, setActiveDecisionId] = useState(loaded.activeDecisionId || null);
  const [activeTab, setActiveTab] = useState("workspace"); // workspace | charts | sensitivity
  const [toast, setToast] = useState(null);

  const [notesModal, setNotesModal] = useState(null); // { optionId }
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Sensitivity controls (UI-only state; does not modify the decision)
  const [sensitivityCriterionId, setSensitivityCriterionId] = useState(null);
  const [sensitivityStep, setSensitivityStep] = useState(1);

  const toastTimerRef = useRef(null);

  const activeDecision = useMemo(
    () => decisions.find((d) => d.id === activeDecisionId) || null,
    [decisions, activeDecisionId]
  );

  const ranking = useMemo(() => (activeDecision ? rankOptions(activeDecision) : []), [activeDecision]);

  // Keep a valid sensitivity criterion selected when decision changes / criteria changes.
  useEffect(() => {
    if (!activeDecision) {
      setSensitivityCriterionId(null);
      return;
    }
    const crits = activeDecision.criteria || [];
    if (crits.length === 0) {
      setSensitivityCriterionId(null);
      return;
    }
    if (!sensitivityCriterionId || !crits.some((c) => c.id === sensitivityCriterionId)) {
      setSensitivityCriterionId(crits[0].id);
    }
  }, [activeDecision, sensitivityCriterionId]);

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Persist app state
  useEffect(() => {
    saveState({ decisions, activeDecisionId, theme });
  }, [decisions, activeDecisionId, theme]);

  // Simple toast helper
  const showToast = (message) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  };

  // PUBLIC_INTERFACE
  const toggleTheme = () => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  };

  const updateDecision = (decisionId, updater) => {
    setDecisions((prev) =>
      prev.map((d) => {
        if (d.id !== decisionId) return d;
        const updated = typeof updater === "function" ? updater(d) : updater;
        return { ...updated, updatedAt: new Date().toISOString() };
      })
    );
  };

  const addDecision = () => {
    const d = createDecision(`Decision ${decisions.length + 1}`);
    setDecisions((prev) => [d, ...prev]);
    setActiveDecisionId(d.id);
    setActiveTab("workspace");
    showToast("Decision created");
  };

  const deleteDecision = (decisionId) => {
    const d = decisions.find((x) => x.id === decisionId);
    const ok = window.confirm(`Delete decision "${d?.name || "Untitled"}"? This cannot be undone.`);
    if (!ok) return;

    setDecisions((prev) => prev.filter((x) => x.id !== decisionId));
    if (activeDecisionId === decisionId) {
      const remaining = decisions.filter((x) => x.id !== decisionId);
      setActiveDecisionId(remaining[0]?.id || null);
    }
    showToast("Decision deleted");
  };

  const addCriterion = () => {
    if (!activeDecision) return;
    const newCriterion = { id: uid(), name: `Criterion ${activeDecision.criteria.length + 1}`, weight: DEFAULT_WEIGHT };
    updateDecision(activeDecision.id, (d) => {
      const next = { ...d, criteria: [...(d.criteria || []), newCriterion] };

      // Initialize scores for each existing option (default mid score)
      next.options = (next.options || []).map((o) => ({
        ...o,
        scores: { ...(o.scores || {}), [newCriterion.id]: DEFAULT_SCORE },
      }));
      return next;
    });
    showToast("Criterion added");
  };

  const deleteCriterion = (criterionId) => {
    if (!activeDecision) return;
    const c = (activeDecision.criteria || []).find((x) => x.id === criterionId);
    const ok = window.confirm(`Delete criterion "${c?.name || "Untitled"}"? Scores for this criterion will be removed.`);
    if (!ok) return;

    updateDecision(activeDecision.id, (d) => {
      const nextCriteria = (d.criteria || []).filter((x) => x.id !== criterionId);
      const nextOptions = (d.options || []).map((o) => {
        const nextScores = { ...(o.scores || {}) };
        delete nextScores[criterionId];
        return { ...o, scores: nextScores };
      });
      return { ...d, criteria: nextCriteria, options: nextOptions };
    });
    showToast("Criterion deleted");
  };

  const addOption = () => {
    if (!activeDecision) return;
    const newOption = { id: uid(), name: `Option ${activeDecision.options.length + 1}`, notes: "", scores: {} };
    for (const c of activeDecision.criteria || []) {
      newOption.scores[c.id] = DEFAULT_SCORE;
    }
    updateDecision(activeDecision.id, (d) => ({ ...d, options: [...(d.options || []), newOption] }));
    showToast("Option added");
  };

  const deleteOption = (optionId) => {
    if (!activeDecision) return;
    const o = (activeDecision.options || []).find((x) => x.id === optionId);
    const ok = window.confirm(`Delete option "${o?.name || "Untitled"}"?`);
    if (!ok) return;

    updateDecision(activeDecision.id, (d) => ({ ...d, options: (d.options || []).filter((x) => x.id !== optionId) }));
    showToast("Option deleted");
  };

  const resetActiveDecision = () => {
    if (!activeDecision) return;
    const ok = window.confirm("Reset scores to default (all 3) for this decision?");
    if (!ok) return;

    updateDecision(activeDecision.id, (d) => {
      const nextOptions = (d.options || []).map((o) => {
        const scores = {};
        for (const c of d.criteria || []) scores[c.id] = DEFAULT_SCORE;
        return { ...o, scores };
      });
      return { ...d, options: nextOptions };
    });
    showToast("Scores reset");
  };

  const exportActiveDecision = () => {
    if (!activeDecision) return "";
    const payload = {
      decision: activeDecision,
      computed: {
        rankedOptions: rankOptions(activeDecision).map((r) => ({
          optionId: r.optionId,
          optionName: r.option?.name,
          total100: r.total100,
        })),
      },
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(payload, null, 2);
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied to clipboard");
    } catch {
      showToast("Copy failed (browser permission)");
    }
  };

  const normalizedCriteria = useMemo(() => {
    if (!activeDecision) return [];
    return normalizeWeights(activeDecision.criteria || []);
  }, [activeDecision]);

  const chartRows = useMemo(() => {
    return ranking.map((r) => ({
      label: r.option?.name || "Option",
      value: r.total100 || 0,
    }));
  }, [ranking]);

  const sensitivityResult = useMemo(() => {
    if (!activeDecision) return null;
    if ((activeDecision.criteria || []).length === 0) return null;
    if ((activeDecision.options || []).length === 0) return null;
    if (!sensitivityCriterionId) return null;

    const step = clamp(toNumber(sensitivityStep, 1), 1, 5);
    return computeSensitivityOneCriterion(activeDecision, sensitivityCriterionId, step);
  }, [activeDecision, sensitivityCriterionId, sensitivityStep]);

  const sensitivityTopChanges = useMemo(() => {
    if (!sensitivityResult) return [];
    const pts = sensitivityResult.points || [];
    const changes = [];
    let prevTop = null;
    for (const p of pts) {
      if (p.topOptionId !== prevTop) {
        changes.push({ weight: p.weight, topOptionId: p.topOptionId, topOptionName: p.topOptionName });
        prevTop = p.topOptionId;
      }
    }
    return changes;
  }, [sensitivityResult]);

  return (
    <div className="App">
      <div className="topbar">
        <div className="brand">
          <div className="brandMark" aria-hidden="true">
            DH
          </div>
          <div className="brandText">
            <div className="brandTitle">Decision Helper</div>
            <div className="brandSubtitle">Weighted criteria scoring</div>
          </div>
        </div>

        <div className="topbarActions">
          <button className="btn btnGhost" onClick={() => setExportModalOpen(true)} disabled={!activeDecision}>
            Export
          </button>
          <button className="btn btnGhost" onClick={resetActiveDecision} disabled={!activeDecision}>
            Reset scores
          </button>
          <button className="btn btnPrimary" onClick={addDecision}>
            New decision
          </button>
          <button className="btn btnGhost" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
            {theme === "light" ? "Dark" : "Light"}
          </button>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar" aria-label="Decisions">
          <div className="sidebarHeader">
            <div className="sidebarTitle">Decisions</div>
            <button className="btn btnSmall" onClick={addDecision}>
              + Add
            </button>
          </div>

          {decisions.length === 0 ? (
            <EmptyState
              title="No decisions yet"
              description="Create your first decision to start comparing options."
              action={
                <button className="btn btnPrimary" onClick={addDecision}>
                  Create decision
                </button>
              }
            />
          ) : (
            <div className="decisionList">
              {decisions.map((d) => (
                <div
                  key={d.id}
                  className={`decisionItem ${d.id === activeDecisionId ? "active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setActiveDecisionId(d.id);
                    setActiveTab("workspace");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      setActiveDecisionId(d.id);
                      setActiveTab("workspace");
                    }
                  }}
                >
                  <div className="decisionItemTop">
                    <div className="decisionName">{d.name || "Untitled"}</div>
                    <button
                      className="iconBtn danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteDecision(d.id);
                      }}
                      aria-label={`Delete decision ${d.name || ""}`}
                      title="Delete decision"
                    >
                      🗑
                    </button>
                  </div>
                  <div className="decisionMeta">
                    {(d.options || []).length} options · {(d.criteria || []).length} criteria
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="sidebarFooter">
            <div className="hint">Data is stored locally in your browser (LocalStorage). Nothing is sent to a server.</div>
          </div>
        </aside>

        <main className="content" aria-label="Decision workspace">
          {!activeDecision ? (
            <div className="contentCard">
              <EmptyState
                title="Select a decision"
                description="Choose a decision from the left or create a new one."
                action={
                  <button className="btn btnPrimary" onClick={addDecision}>
                    New decision
                  </button>
                }
              />
            </div>
          ) : (
            <>
              <div className="contentHeader">
                <div className="decisionHeader">
                  <input
                    className="input titleInput"
                    value={activeDecision.name || ""}
                    onChange={(e) => updateDecision(activeDecision.id, (d) => ({ ...d, name: e.target.value }))}
                    placeholder="Decision name"
                    aria-label="Decision name"
                  />
                  <textarea
                    className="input textarea"
                    value={activeDecision.description || ""}
                    onChange={(e) => updateDecision(activeDecision.id, (d) => ({ ...d, description: e.target.value }))}
                    placeholder="Add a short description (optional)"
                    aria-label="Decision description"
                    rows={2}
                  />
                </div>

                <div className="tabs" role="tablist" aria-label="Workspace tabs">
                  <button
                    className={`tab ${activeTab === "workspace" ? "active" : ""}`}
                    onClick={() => setActiveTab("workspace")}
                    role="tab"
                    aria-selected={activeTab === "workspace"}
                  >
                    Workspace
                  </button>
                  <button
                    className={`tab ${activeTab === "charts" ? "active" : ""}`}
                    onClick={() => setActiveTab("charts")}
                    role="tab"
                    aria-selected={activeTab === "charts"}
                  >
                    Charts
                  </button>
                  <button
                    className={`tab ${activeTab === "sensitivity" ? "active" : ""}`}
                    onClick={() => setActiveTab("sensitivity")}
                    role="tab"
                    aria-selected={activeTab === "sensitivity"}
                  >
                    Sensitivity
                  </button>
                </div>
              </div>

              {activeTab === "workspace" ? (
                <div className="grid">
                  <section className="card" aria-label="Criteria">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Criteria</div>
                        <div className="cardSub">Set weights (0–10). Weights are normalized automatically.</div>
                      </div>
                      <button className="btn btnSmall" onClick={addCriterion}>
                        + Criterion
                      </button>
                    </div>

                    {(activeDecision.criteria || []).length === 0 ? (
                      <EmptyState
                        title="No criteria"
                        description="Add criteria to start scoring options."
                        action={
                          <button className="btn btnPrimary" onClick={addCriterion}>
                            Add criterion
                          </button>
                        }
                      />
                    ) : (
                      <div className="list">
                        {normalizedCriteria.map((c) => (
                          <div key={c.id} className="listRow">
                            <input
                              className="input"
                              value={c.name || ""}
                              onChange={(e) =>
                                updateDecision(activeDecision.id, (d) => ({
                                  ...d,
                                  criteria: (d.criteria || []).map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)),
                                }))
                              }
                              placeholder="Criterion name"
                              aria-label={`Criterion name ${c.name || ""}`}
                            />
                            <div className="weightCell">
                              <input
                                className="range"
                                type="range"
                                min={MIN_WEIGHT}
                                max={MAX_WEIGHT}
                                value={clamp(toNumber(c.weight, DEFAULT_WEIGHT), MIN_WEIGHT, MAX_WEIGHT)}
                                onChange={(e) =>
                                  updateDecision(activeDecision.id, (d) => ({
                                    ...d,
                                    criteria: (d.criteria || []).map((x) =>
                                      x.id === c.id ? { ...x, weight: clamp(toNumber(e.target.value, DEFAULT_WEIGHT), MIN_WEIGHT, MAX_WEIGHT) } : x
                                    ),
                                  }))
                                }
                                aria-label={`Weight for ${c.name || "criterion"}`}
                              />
                              <div className="weightValue" title="Weight / normalized weight">
                                {clamp(toNumber(c.weight, 0), MIN_WEIGHT, MAX_WEIGHT)}{" "}
                                <span className="muted">({Math.round((c.normalizedWeight || 0) * 100)}%)</span>
                              </div>
                            </div>
                            <button className="iconBtn danger" onClick={() => deleteCriterion(c.id)} aria-label={`Delete criterion ${c.name || ""}`}>
                              🗑
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="card" aria-label="Options">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Options</div>
                        <div className="cardSub">Add options and score them against each criterion (0–10).</div>
                      </div>
                      <button className="btn btnSmall" onClick={addOption}>
                        + Option
                      </button>
                    </div>

                    {(activeDecision.options || []).length === 0 ? (
                      <EmptyState
                        title="No options"
                        description="Add at least one option to compare."
                        action={
                          <button className="btn btnPrimary" onClick={addOption}>
                            Add option
                          </button>
                        }
                      />
                    ) : (
                      <div className="list">
                        {(activeDecision.options || []).map((o) => (
                          <div key={o.id} className="listRow optionRow">
                            <input
                              className="input"
                              value={o.name || ""}
                              onChange={(e) =>
                                updateDecision(activeDecision.id, (d) => ({
                                  ...d,
                                  options: (d.options || []).map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)),
                                }))
                              }
                              placeholder="Option name"
                              aria-label={`Option name ${o.name || ""}`}
                            />
                            <button className="btn btnSmall btnGhost" onClick={() => setNotesModal({ optionId: o.id })}>
                              Notes
                            </button>
                            <button className="iconBtn danger" onClick={() => deleteOption(o.id)} aria-label={`Delete option ${o.name || ""}`}>
                              🗑
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="card wide" aria-label="Scoring table">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Scoring</div>
                        <div className="cardSub">Scores are multiplied by normalized weights to produce a final ranking.</div>
                      </div>
                      <div className="cardHeaderActions">
                        <button className="btn btnSmall btnGhost" onClick={() => setActiveTab("charts")} disabled={ranking.length === 0}>
                          View charts
                        </button>
                      </div>
                    </div>

                    {(activeDecision.criteria || []).length === 0 || (activeDecision.options || []).length === 0 ? (
                      <EmptyState title="Add criteria and options to score" description="You need at least 1 criterion and 1 option to compute rankings." />
                    ) : (
                      <div className="tableWrap" role="region" aria-label="Comparison scoring table">
                        <table className="table">
                          <thead>
                            <tr>
                              <th className="stickyCol">Option</th>
                              {(activeDecision.criteria || []).map((c) => (
                                <th key={c.id} title={`Weight: ${c.weight}`}>
                                  <div className="thTop">{c.name || "Criterion"}</div>
                                  <div className="thSub">w={clamp(toNumber(c.weight, 0), MIN_WEIGHT, MAX_WEIGHT)}</div>
                                </th>
                              ))}
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(activeDecision.options || []).map((o) => {
                              const totalRow = ranking.find((r) => r.optionId === o.id);
                              return (
                                <tr key={o.id}>
                                  <td className="stickyCol">
                                    <div className="cellOptionName">{o.name || "Option"}</div>
                                  </td>
                                  {(activeDecision.criteria || []).map((c) => {
                                    const currentScore = clamp(toNumber(o.scores?.[c.id], DEFAULT_SCORE), MIN_SCORE, MAX_SCORE);
                                    return (
                                      <td key={c.id}>
                                        <input
                                          className="scoreInput"
                                          type="number"
                                          inputMode="numeric"
                                          min={MIN_SCORE}
                                          max={MAX_SCORE}
                                          value={currentScore}
                                          onChange={(e) => {
                                            const nextScore = clamp(toNumber(e.target.value, DEFAULT_SCORE), MIN_SCORE, MAX_SCORE);
                                            updateDecision(activeDecision.id, (d) => ({
                                              ...d,
                                              options: (d.options || []).map((x) =>
                                                x.id === o.id ? { ...x, scores: { ...(x.scores || {}), [c.id]: nextScore } } : x
                                              ),
                                            }));
                                          }}
                                          aria-label={`Score for ${o.name || "option"} on ${c.name || "criterion"}`}
                                        />
                                      </td>
                                    );
                                  })}
                                  <td>
                                    <div className="totalPill" title="Total score (0–100)">
                                      {totalRow ? `${totalRow.total100.toFixed(1)}%` : "—"}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>

                  <section className="card wide" aria-label="Rankings">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Rankings</div>
                        <div className="cardSub">Highest total wins. Adjust weights/scores to see changes instantly.</div>
                      </div>
                    </div>

                    {ranking.length === 0 ? (
                      <EmptyState title="No rankings yet" description="Add criteria and options, then score each option." />
                    ) : (
                      <div className="rankingList">
                        {ranking.map((r, idx) => (
                          <div key={r.optionId} className="rankingRow">
                            <div className="rankingLeft">
                              <div className="rankBadge" aria-label={`Rank ${idx + 1}`}>
                                {idx + 1}
                              </div>
                              <div>
                                <div className="rankingName">{r.option?.name || "Option"}</div>
                                <div className="rankingMeta">{(activeDecision.criteria || []).length} criteria · weighted score</div>
                              </div>
                            </div>
                            <div className="rankingRight">
                              <div className="rankingScore">{r.total100.toFixed(1)}%</div>
                              <div className="miniBar" aria-hidden="true">
                                <div className="miniBarFill" style={{ width: `${clamp(r.total100, 0, 100)}%` }} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              ) : activeTab === "charts" ? (
                <div className="grid">
                  <section className="card wide" aria-label="Charts">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Charts</div>
                        <div className="cardSub">A quick visualization of the current computed totals.</div>
                      </div>
                      <div className="cardHeaderActions">
                        <button className="btn btnSmall btnGhost" onClick={() => setActiveTab("workspace")}>
                          Back to workspace
                        </button>
                      </div>
                    </div>

                    {chartRows.length === 0 ? (
                      <EmptyState title="Nothing to chart" description="Add criteria/options and score them to see the chart." />
                    ) : (
                      <div className="chartWrap">
                        <BarChart rows={chartRows} maxValue={100} />
                      </div>
                    )}
                  </section>

                  <section className="card wide" aria-label="How scoring works">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">How scoring works</div>
                        <div className="cardSub">Totals are computed using normalized weights.</div>
                      </div>
                    </div>
                    <div className="explain">
                      <div className="explainRow">
                        <div className="pill">1</div>
                        <div>
                          <div className="explainTitle">Normalize weights</div>
                          <div className="explainText">Each criterion weight is divided by the sum of all weights.</div>
                        </div>
                      </div>
                      <div className="explainRow">
                        <div className="pill">2</div>
                        <div>
                          <div className="explainTitle">Normalize scores</div>
                          <div className="explainText">Scores (0–10) are converted to 0–1 by dividing by 10.</div>
                        </div>
                      </div>
                      <div className="explainRow">
                        <div className="pill">3</div>
                        <div>
                          <div className="explainTitle">Weighted sum</div>
                          <div className="explainText">Total = Σ(normalizedWeight × normalizedScore). Displayed as %.</div>
                        </div>
                      </div>
                    </div>
                  </section>
                </div>
              ) : (
                <div className="grid">
                  <section className="card wide" aria-label="Sensitivity analysis">
                    <div className="cardHeader">
                      <div>
                        <div className="cardTitle">Sensitivity analysis</div>
                        <div className="cardSub">
                          Vary one criterion’s weight from {MIN_WEIGHT} to {MAX_WEIGHT} and see how rankings change (other weights stay the same).
                        </div>
                      </div>
                      <div className="cardHeaderActions">
                        <button className="btn btnSmall btnGhost" onClick={() => setActiveTab("workspace")}>
                          Back to workspace
                        </button>
                      </div>
                    </div>

                    {(activeDecision.criteria || []).length === 0 || (activeDecision.options || []).length === 0 ? (
                      <EmptyState title="Not enough data" description="Add at least 1 criterion and 1 option to run sensitivity analysis." />
                    ) : (
                      <>
                        <div className="sensitivityControls" role="group" aria-label="Sensitivity controls">
                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="label" htmlFor="sens-criterion">
                              Criterion to vary
                            </label>
                            <select
                              id="sens-criterion"
                              className="input"
                              value={sensitivityCriterionId || ""}
                              onChange={(e) => setSensitivityCriterionId(e.target.value)}
                              aria-label="Select criterion to vary"
                            >
                              {(activeDecision.criteria || []).map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name || "Criterion"}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="label" htmlFor="sens-step">
                              Step size
                            </label>
                            <select
                              id="sens-step"
                              className="input"
                              value={sensitivityStep}
                              onChange={(e) => setSensitivityStep(toNumber(e.target.value, 1))}
                              aria-label="Sensitivity step size"
                            >
                              <option value={1}>1</option>
                              <option value={2}>2</option>
                              <option value={5}>5</option>
                            </select>
                          </div>

                          <div className="field" style={{ marginBottom: 0 }}>
                            <label className="label">Current weight</label>
                            <div className="readonly">
                              {(() => {
                                const c = (activeDecision.criteria || []).find((x) => x.id === sensitivityCriterionId);
                                const w = clamp(toNumber(c?.weight, 0), MIN_WEIGHT, MAX_WEIGHT);
                                return `${w} (baseline)`;
                              })()}
                            </div>
                          </div>
                        </div>

                        {!sensitivityResult ? (
                          <EmptyState title="Select a criterion" description="Choose which criterion weight you want to vary." />
                        ) : (
                          <div className="sensitivityGrid">
                            <div className="card" style={{ boxShadow: "none" }} aria-label="Summary">
                              <div className="cardHeader">
                                <div>
                                  <div className="cardTitle">Summary</div>
                                  <div className="cardSub">How often each option becomes #1, and max rank movement from baseline.</div>
                                </div>
                              </div>

                              <div className="tableWrap" role="region" aria-label="Sensitivity summary table">
                                <table className="table" style={{ minWidth: 520 }}>
                                  <thead>
                                    <tr>
                                      <th>Option</th>
                                      <th>#1 count</th>
                                      <th>Max rank change</th>
                                      <th>Baseline rank</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(activeDecision.options || [])
                                      .map((o) => {
                                        const baselineRank = sensitivityResult.baselineRankByOptionId[o.id] ?? null;
                                        const wins = sensitivityResult.winCountByOptionId[o.id] || 0;
                                        const maxDelta = sensitivityResult.maxDeltaByOptionId[o.id] || 0;
                                        return { option: o, baselineRank, wins, maxDelta };
                                      })
                                      .sort((a, b) => {
                                        // Sort by most wins, then baseline rank.
                                        if (b.wins !== a.wins) return b.wins - a.wins;
                                        if ((a.baselineRank || 999) !== (b.baselineRank || 999)) return (a.baselineRank || 999) - (b.baselineRank || 999);
                                        return (a.option.name || "").localeCompare(b.option.name || "");
                                      })
                                      .map((row) => (
                                        <tr key={row.option.id}>
                                          <td>
                                            <div className="cellOptionName">{row.option.name || "Option"}</div>
                                          </td>
                                          <td>{row.wins}</td>
                                          <td>{row.maxDelta}</td>
                                          <td>{row.baselineRank ?? "—"}</td>
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            <div className="card" style={{ boxShadow: "none" }} aria-label="When the winner changes">
                              <div className="cardHeader">
                                <div>
                                  <div className="cardTitle">Winner changes</div>
                                  <div className="cardSub">Points where the top-ranked option changes as weight varies.</div>
                                </div>
                              </div>

                              {sensitivityTopChanges.length === 0 ? (
                                <EmptyState title="No changes detected" description="The same option stays #1 across the tested range." />
                              ) : (
                                <div className="sensitivityChanges">
                                  {sensitivityTopChanges.map((c, idx) => (
                                    <div key={`${c.weight}_${c.topOptionId || idx}`} className="rankingRow" style={{ background: "rgba(59, 130, 246, 0.04)" }}>
                                      <div className="rankingLeft">
                                        <div className="rankBadge" aria-label={`Change ${idx + 1}`}>
                                          {idx + 1}
                                        </div>
                                        <div>
                                          <div className="rankingName">{c.topOptionName || "—"}</div>
                                          <div className="rankingMeta">Becomes #1 at weight = {c.weight}</div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div className="card wide" style={{ boxShadow: "none" }} aria-label="Rank table over weight range">
                              <div className="cardHeader">
                                <div>
                                  <div className="cardTitle">Rankings over weight range</div>
                                  <div className="cardSub">Rows are tested weights; cells show rank (1 = best) for each option.</div>
                                </div>
                              </div>

                              <div className="tableWrap" role="region" aria-label="Sensitivity ranks by weight table">
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th className="stickyCol">Weight</th>
                                      {(activeDecision.options || []).map((o) => (
                                        <th key={o.id}>
                                          <div className="thTop">{o.name || "Option"}</div>
                                          <div className="thSub">baseline #{sensitivityResult.baselineRankByOptionId[o.id] ?? "—"}</div>
                                        </th>
                                      ))}
                                      <th>Winner</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sensitivityResult.points.map((p) => (
                                      <tr key={p.weight}>
                                        <td className="stickyCol">
                                          <div className="cellOptionName">{p.weight}</div>
                                        </td>
                                        {(activeDecision.options || []).map((o) => {
                                          const rankNow = p.rankByOptionId[o.id] ?? null;
                                          const baseRank = sensitivityResult.baselineRankByOptionId[o.id] ?? null;
                                          const changed = baseRank && rankNow && baseRank !== rankNow;
                                          return (
                                            <td key={o.id} className={changed ? "sensitivityCellChanged" : ""} title={changed ? `Baseline #${baseRank} → #${rankNow}` : `Rank #${rankNow}`}>
                                              {rankNow ?? "—"}
                                            </td>
                                          );
                                        })}
                                        <td>
                                          <span className="totalPill" style={{ fontSize: 12, padding: "6px 10px" }}>
                                            {p.topOptionName || "—"}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              <div className="hint" style={{ marginTop: 10 }}>
                                Tip: If nothing changes, your scores may be far apart or weights too similar. Try adjusting scores/weights, then revisit this tab.
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {notesModal && activeDecision ? (
        <Modal
          title="Option notes"
          onClose={() => setNotesModal(null)}
          footer={
            <div className="modalFooterRow">
              <button className="btn btnGhost" onClick={() => setNotesModal(null)}>
                Close
              </button>
            </div>
          }
        >
          {(() => {
            const option = (activeDecision.options || []).find((o) => o.id === notesModal.optionId);
            if (!option) return <EmptyState title="Option not found" description="This option may have been deleted." />;
            return (
              <div className="modalForm">
                <div className="field">
                  <label className="label">Option</label>
                  <div className="readonly">{option.name || "Untitled"}</div>
                </div>
                <div className="field">
                  <label className="label">Notes</label>
                  <textarea
                    className="input textarea"
                    rows={8}
                    value={option.notes || ""}
                    onChange={(e) =>
                      updateDecision(activeDecision.id, (d) => ({
                        ...d,
                        options: (d.options || []).map((x) => (x.id === option.id ? { ...x, notes: e.target.value } : x)),
                      }))
                    }
                    placeholder="Add reasoning, assumptions, risks, or links…"
                    aria-label="Option notes"
                  />
                </div>
              </div>
            );
          })()}
        </Modal>
      ) : null}

      {exportModalOpen ? (
        <Modal
          title="Export decision (JSON)"
          onClose={() => setExportModalOpen(false)}
          footer={
            <div className="modalFooterRow">
              <button className="btn btnGhost" onClick={() => setExportModalOpen(false)}>
                Close
              </button>
              <button
                className="btn btnPrimary"
                onClick={() => {
                  const text = exportActiveDecision();
                  copyToClipboard(text);
                }}
                disabled={!activeDecision}
              >
                Copy JSON
              </button>
            </div>
          }
        >
          {!activeDecision ? (
            <EmptyState title="No active decision" description="Select a decision to export." />
          ) : (
            <div className="exportBox">
              <pre className="codeBlock">{exportActiveDecision()}</pre>
            </div>
          )}
        </Modal>
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

export default App;
