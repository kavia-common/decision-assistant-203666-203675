const DEFAULT_WEIGHT = 3;
const DEFAULT_SCORE = 3;

/** @returns {string} A reasonably unique id for client-side entities. */
function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Built-in starter templates. Template entities use stable ids (strings) which are
 * replaced with fresh client-side ids during instantiation.
 */
const DECISION_TEMPLATES = [
  {
    id: "blank",
    name: "Blank decision",
    description: "Start from scratch with no criteria or options.",
    payload: {
      description: "",
      criteria: [],
      options: [],
    },
  },
  {
    id: "simple-weighted",
    name: "Simple weighted decision (recommended)",
    description: "A balanced starter with 3 criteria and 2 options.",
    payload: {
      description: "",
      criteria: [
        { id: "c_cost", name: "Cost", weight: 4 },
        { id: "c_impact", name: "Impact", weight: 5 },
        { id: "c_effort", name: "Effort", weight: 3 },
      ],
      options: [
        {
          id: "o_a",
          name: "Option A",
          notes: "",
          scores: { c_cost: 7, c_impact: 6, c_effort: 4 },
        },
        {
          id: "o_b",
          name: "Option B",
          notes: "",
          scores: { c_cost: 5, c_impact: 8, c_effort: 6 },
        },
      ],
    },
  },
  {
    id: "hire-candidate",
    name: "Hiring decision",
    description: "Compare candidates across key hiring criteria.",
    payload: {
      description: "Compare candidates and discuss trade-offs explicitly.",
      criteria: [
        { id: "c_rolefit", name: "Role fit", weight: 5 },
        { id: "c_tech", name: "Technical skills", weight: 6 },
        { id: "c_collab", name: "Communication", weight: 4 },
        { id: "c_growth", name: "Growth potential", weight: 3 },
        { id: "c_comp", name: "Compensation fit", weight: 2 },
      ],
      options: [
        { id: "o_1", name: "Candidate A", notes: "", scores: {} },
        { id: "o_2", name: "Candidate B", notes: "", scores: {} },
        { id: "o_3", name: "Candidate C", notes: "", scores: {} },
      ],
    },
  },
  {
    id: "vendor-selection",
    name: "Vendor / tool selection",
    description: "Compare tools/vendors on cost, capabilities, security, and support.",
    payload: {
      description: "Select a vendor/tool based on weighted criteria.",
      criteria: [
        { id: "c_price", name: "Total cost", weight: 4 },
        { id: "c_features", name: "Feature fit", weight: 6 },
        { id: "c_security", name: "Security & compliance", weight: 5 },
        { id: "c_integration", name: "Integration", weight: 4 },
        { id: "c_support", name: "Support & roadmap", weight: 3 },
      ],
      options: [
        { id: "o_1", name: "Vendor A", notes: "", scores: {} },
        { id: "o_2", name: "Vendor B", notes: "", scores: {} },
        { id: "o_3", name: "Vendor C", notes: "", scores: {} },
      ],
    },
  },
  {
    id: "move-or-stay",
    name: "Relocation decision",
    description: "A personal decision template for moving/staying.",
    payload: {
      description: "Compare scenarios with a mix of tangible and intangible factors.",
      criteria: [
        { id: "c_finance", name: "Financial impact", weight: 5 },
        { id: "c_quality", name: "Quality of life", weight: 6 },
        { id: "c_career", name: "Career growth", weight: 5 },
        { id: "c_social", name: "Friends & family", weight: 4 },
        { id: "c_risk", name: "Risk/uncertainty", weight: 3 },
      ],
      options: [
        { id: "o_1", name: "Move", notes: "", scores: {} },
        { id: "o_2", name: "Stay", notes: "", scores: {} },
      ],
    },
  },
];

/**
 * Create a concrete decision from a template.
 * - Generates fresh ids for decision, criteria, and options
 * - Rewrites option scores to match the new criterion ids
 * - Ensures every option has a score for every criterion (defaults)
 *
 * PUBLIC_INTERFACE
 */
export function createDecisionFromTemplate(templateId, nameOverride) {
  /** This is a public function. */
  const template = DECISION_TEMPLATES.find((t) => t.id === templateId) || DECISION_TEMPLATES[0];

  const now = new Date().toISOString();
  const idMap = new Map(); // oldId -> newId

  const criteria = (template.payload.criteria || []).map((c) => {
    const newId = uid();
    idMap.set(c.id, newId);
    return {
      id: newId,
      name: c.name || "Criterion",
      weight: typeof c.weight === "number" ? c.weight : DEFAULT_WEIGHT,
    };
  });

  const options = (template.payload.options || []).map((o) => {
    const newId = uid();
    idMap.set(o.id, newId);
    return {
      id: newId,
      name: o.name || "Option",
      notes: o.notes || "",
      scores: { ...(o.scores || {}) }, // still references template criterion ids for now
    };
  });

  // Rewrite scores to new criterion ids and fill missing ones.
  const criterionIdsNew = criteria.map((c) => c.id);
  const criterionIdByOld = {};
  (template.payload.criteria || []).forEach((cOld) => {
    const cNew = idMap.get(cOld.id);
    if (cNew) criterionIdByOld[cOld.id] = cNew;
  });

  const nextOptions = options.map((o, idx) => {
    const templateOpt = (template.payload.options || [])[idx];
    const oldScores = templateOpt?.scores || {};

    const rewrittenScores = {};
    for (const [oldCritId, score] of Object.entries(oldScores)) {
      const newCritId = criterionIdByOld[oldCritId];
      if (!newCritId) continue;
      rewrittenScores[newCritId] = typeof score === "number" ? score : DEFAULT_SCORE;
    }

    // Default any missing criterion score.
    for (const cId of criterionIdsNew) {
      if (Object.prototype.hasOwnProperty.call(rewrittenScores, cId)) continue;
      rewrittenScores[cId] = DEFAULT_SCORE;
    }

    return { ...o, scores: rewrittenScores };
  });

  return {
    id: uid(),
    name: (nameOverride || template.name || "New Decision").trim() || "New Decision",
    description: template.payload.description || "",
    createdAt: now,
    updatedAt: now,
    criteria,
    options: nextOptions,
  };
}

/**
 * PUBLIC_INTERFACE
 */
export function getDecisionTemplates() {
  /** This is a public function. */
  return DECISION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }));
}
