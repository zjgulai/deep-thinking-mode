function compareAscii(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const SAFETY_SIGNAL_PRECEDENCE = Object.freeze({
  immediate_personal_danger: 10,
  medical_diagnosis_or_treatment: 20,
  legal_advice_with_deadline: 30,
  high_stakes_financial_instruction: 40
});
const MAX_NEGATIVE_INSERTIONS = 4;
const DOUBLE_NEGATION_MARKERS = Object.freeze(["并不是", "不是", "并非"]);

export function normalizeRouterText(input) {
  const normalizedText = String(input ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, " ")
    .replace(/[^\p{Script=Han}\p{L}\p{N} ]+/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
  return {
    normalizedText,
    compactText: normalizedText.replace(/\s+/gu, "")
  };
}

export function createBigrams(normalizedCompactText) {
  const characters = [...String(normalizedCompactText ?? "")];
  const bigrams = new Set();
  for (let index = 0; index + 1 < characters.length; index += 1) {
    bigrams.add(`${characters[index]}${characters[index + 1]}`);
  }
  return bigrams;
}

function jaccardSimilarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function matchedPhrases(compactText, phrases = []) {
  return phrases.filter(({ text }) => {
    const phrase = normalizeRouterText(text).compactText;
    return phrase.length > 0 && compactText.includes(phrase);
  });
}

function normalizeNegativeClauses(input) {
  const clauses = [];
  let clause = [];
  for (const character of String(input ?? "").normalize("NFKC").toLowerCase()) {
    if (/\p{P}/u.test(character)) {
      if (clause.length > 0) clauses.push(clause);
      clause = [];
    } else if (/\s/u.test(character)) {
      continue;
    } else if (/[\p{Script=Han}\p{L}\p{N}]/u.test(character)) {
      clause.push(character);
    }
  }
  if (clause.length > 0) clauses.push(clause);
  return clauses;
}

function boundedSubsequenceCandidates(clause, phrase) {
  const candidates = [];
  for (let start = 0; start < clause.length; start += 1) {
    if (clause[start] !== phrase[0]) continue;
    let clauseIndex = start + 1;
    let phraseIndex = 1;
    while (phraseIndex < phrase.length && clauseIndex < clause.length) {
      if (clause[clauseIndex] === phrase[phraseIndex]) phraseIndex += 1;
      clauseIndex += 1;
      if (clauseIndex - start - phraseIndex > MAX_NEGATIVE_INSERTIONS) break;
    }
    if (phraseIndex === phrase.length) {
      const end = clauseIndex - 1;
      if (end - start + 1 - phrase.length <= MAX_NEGATIVE_INSERTIONS) candidates.push({ start, end });
    }
  }
  const minimalCandidates = [];
  let minEnd = Number.POSITIVE_INFINITY;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate.end < minEnd) {
      minimalCandidates.push(candidate);
      minEnd = candidate.end;
    }
  }
  return minimalCandidates.reverse();
}

function sequenceAt(characters, sequence, start) {
  if (start < 0 || start + sequence.length > characters.length) return false;
  for (let index = 0; index < sequence.length; index += 1) {
    if (characters[start + index] !== sequence[index]) return false;
  }
  return true;
}

function isReversedNegativeCandidate(clause, negativeStart) {
  for (const markerText of DOUBLE_NEGATION_MARKERS) {
    const marker = [...markerText];
    const firstMarkerStart = Math.max(0, negativeStart - marker.length - MAX_NEGATIVE_INSERTIONS);
    for (let markerStart = firstMarkerStart; markerStart + marker.length <= negativeStart; markerStart += 1) {
      if (
        sequenceAt(clause, marker, markerStart)
        && negativeStart - markerStart - marker.length <= MAX_NEGATIVE_INSERTIONS
      ) return true;
    }
  }
  return false;
}

function matchesBoundedNegative(clauses, text) {
  const phrase = [...normalizeRouterText(text).compactText];
  if (phrase.length === 0) return false;
  for (const clause of clauses) {
    const candidates = boundedSubsequenceCandidates(clause, phrase);
    if (candidates.some(({ start }) => !isReversedNegativeCandidate(clause, start))) return true;
  }
  return false;
}

export function scoreProblemTypes({ query, shortcutIntentId, problemTypes }) {
  const { compactText } = normalizeRouterText(query);
  const queryBigrams = createBigrams(compactText);
  const negativeClauses = normalizeNegativeClauses(query);

  return problemTypes.map((problemType) => {
    const negativeMatches = (problemType.negative_phrases ?? [])
      .filter(({ text }) => matchesBoundedNegative(negativeClauses, text));
    const positiveMatches = matchedPhrases(compactText, problemType.positive_phrases);
    const negativeScore = negativeMatches.reduce((total, { weight }) => total + weight, 0);
    const positiveScore = positiveMatches.reduce((total, { weight }) => total + weight, 0);

    let closestExample = null;
    let bestSimilarity = 0;
    for (const example of problemType.examples ?? []) {
      const similarity = jaccardSimilarity(queryBigrams, createBigrams(normalizeRouterText(example).compactText));
      if (similarity > bestSimilarity) {
        closestExample = example;
        bestSimilarity = similarity;
      }
    }
    const exampleReward = bestSimilarity < 0.22 ? 0 : Math.min(6, Math.floor(bestSimilarity * 6));
    if (exampleReward === 0) closestExample = null;

    const shortcutMatched = shortcutIntentId === problemType.id;
    const shortcutReward = shortcutMatched ? 8 : 0;
    return {
      id: problemType.id,
      priority: problemType.priority,
      score: Math.max(0, positiveScore - negativeScore + exampleReward + shortcutReward),
      matchedPositivePhrases: positiveMatches.map(({ text }) => text),
      matchedNegativePhrases: negativeMatches.map(({ text }) => text),
      closestExample,
      shortcutMatched
    };
  }).sort((left, right) => (
    right.score - left.score
    || left.priority - right.priority
    || compareAscii(left.id, right.id)
  ));
}

export function detectAgentStage({ query, agentStages }) {
  const { compactText } = normalizeRouterText(query);
  const rankedStages = agentStages.map((stage) => ({
    id: stage.id,
    priority: stage.priority,
    score: matchedPhrases(compactText, stage.positive_phrases)
      .reduce((total, { weight }) => total + weight, 0)
  })).sort((left, right) => (
    right.score - left.score
    || left.priority - right.priority
    || compareAscii(left.id, right.id)
  ));
  return rankedStages[0]?.score > 0 ? rankedStages[0].id : "intent";
}

function emptyResult(state) {
  return {
    state,
    problemTypeId: null,
    auxiliaryProblemTypeIds: [],
    agentStageId: null,
    evidence: {
      matchedPositivePhrases: [],
      matchedNegativePhrases: [],
      closestExample: null,
      shortcutIntentId: null
    },
    clarificationOptionIds: [],
    safetySignalId: null
  };
}

function clarificationOptions(rankedProblemTypes) {
  const options = rankedProblemTypes.filter(({ score }) => score > 0).map(({ id }) => id).slice(0, 4);
  for (const { id } of rankedProblemTypes) {
    if (options.length >= 2) break;
    if (!options.includes(id)) options.push(id);
  }
  return options;
}

function availableRouteKeys(routerData) {
  const source = Object.prototype.hasOwnProperty.call(routerData, "route_keys")
    ? routerData.route_keys
    : Array.isArray(routerData.routes)
      ? routerData.routes.map((route) => route?.id)
      : null;
  if (!Array.isArray(source) || source.length === 0) return new Set();

  const problemTypeIds = new Set((routerData.problem_types ?? []).map(({ id }) => id));
  const agentStageIds = new Set((routerData.agent_stages ?? []).map(({ id }) => id));
  const keys = new Set();
  for (const key of source) {
    if (typeof key !== "string") return new Set();
    const parts = key.split("::");
    if (
      parts.length !== 2
      || !problemTypeIds.has(parts[0])
      || !agentStageIds.has(parts[1])
      || keys.has(key)
    ) return new Set();
    keys.add(key);
  }
  return keys;
}

function resolveCoreStage({ problemTypeId, rawStageId, routeKeys, agentStages }) {
  if (routeKeys.has(`${problemTypeId}::${rawStageId}`)) return rawStageId;
  return (agentStages ?? []).filter(({ id }) => routeKeys.has(`${problemTypeId}::${id}`))
    .sort((left, right) => left.priority - right.priority || compareAscii(left.id, right.id))[0]?.id ?? null;
}

export function matchRoute({ query, shortcutIntentId = null, routerData }) {
  if (query == null && shortcutIntentId == null) return emptyResult("idle");

  const normalized = normalizeRouterText(query);
  if (normalized.compactText.length < 2 && shortcutIntentId == null) return emptyResult("needs_input");

  const matchedSafetySignal = (routerData.safety_signals ?? []).filter((safetySignal) => (
    (safetySignal.phrases ?? []).some((phrase) => {
      const compactPhrase = normalizeRouterText(phrase).compactText;
      return compactPhrase.length > 0 && normalized.compactText.includes(compactPhrase);
    })
  )).sort((left, right) => (
    (SAFETY_SIGNAL_PRECEDENCE[left.id] ?? Number.MAX_SAFE_INTEGER)
    - (SAFETY_SIGNAL_PRECEDENCE[right.id] ?? Number.MAX_SAFE_INTEGER)
    || compareAscii(left.id, right.id)
  ))[0];
  if (matchedSafetySignal) {
    return {
      ...emptyResult("safety_stop"),
      safetySignalId: matchedSafetySignal.id
    };
  }

  const rankedProblemTypes = scoreProblemTypes({
    query,
    shortcutIntentId,
    problemTypes: routerData.problem_types
  });
  const first = rankedProblemTypes[0];
  const second = rankedProblemTypes[1];
  const agentStageId = detectAgentStage({ query, agentStages: routerData.agent_stages });
  const hasExplicitMatch = first.matchedPositivePhrases.length > 0 || first.shortcutMatched;
  const isAmbiguous = second && first.score >= 6 && second.score >= 6 && first.score - second.score < 2;

  if (first.score < 8 || !hasExplicitMatch || isAmbiguous) {
    return {
      ...emptyResult("clarify"),
      agentStageId,
      clarificationOptionIds: clarificationOptions(rankedProblemTypes)
    };
  }

  const routeKeys = availableRouteKeys(routerData);
  const resolvedAgentStageId = resolveCoreStage({
    problemTypeId: first.id,
    rawStageId: agentStageId,
    routeKeys,
    agentStages: routerData.agent_stages
  });
  if (resolvedAgentStageId === null) {
    return {
      ...emptyResult("clarify"),
      agentStageId,
      clarificationOptionIds: clarificationOptions(rankedProblemTypes)
    };
  }

  return {
    state: "matched",
    problemTypeId: first.id,
    auxiliaryProblemTypeIds: rankedProblemTypes.slice(1, 3)
      .filter(({ id, score }) => score >= 6 && routeKeys.has(`${id}::${resolvedAgentStageId}`))
      .map(({ id }) => id),
    agentStageId: resolvedAgentStageId,
    evidence: {
      matchedPositivePhrases: first.matchedPositivePhrases,
      matchedNegativePhrases: first.matchedNegativePhrases,
      closestExample: first.closestExample,
      shortcutIntentId: first.shortcutMatched ? shortcutIntentId : null
    },
    clarificationOptionIds: [],
    safetySignalId: null
  };
}
