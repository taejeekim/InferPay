// The buy-or-answer rule of src/consumer/decide.ts and the lines src/cli/render.ts prints for it.
// src/site/decide.test.ts holds both to the TypeScript over a grid of inputs.

const PRIOR_QUALITY = 0.7;
const PRIOR_RATINGS = 2;
export const LOCAL_FLOOR = 50;
const FRACTION_DIGITS = 18;
const UNITS_PER_WHOLE = 10n ** BigInt(FRACTION_DIGITS);
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,18})?$/;

export function isDecimal(value) {
  return DECIMAL.test(value);
}

export function toUnits(amount) {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * UNITS_PER_WHOLE + BigInt(frac.padEnd(FRACTION_DIGITS, "0"));
}

export function formatUnits(units) {
  const size = units < 0n ? -units : units;
  const frac = (size % UNITS_PER_WHOLE).toString().padStart(FRACTION_DIGITS, "0").replace(/0+$/, "");
  const whole = `${units < 0n ? "-" : ""}${size / UNITS_PER_WHOLE}`;
  return frac.length === 0 ? whole : `${whole}.${frac}`;
}

// Reputation as src/market reports it: { ratings: 0 } for an unrated shop, else the count and the average stars.
export function reputationQuality(reputation) {
  const ratings = reputation.ratings > 0 ? reputation.ratings : 0;
  const starQuality = ratings > 0 ? (reputation.average - 1) / 4 : 0;
  const smoothed = (PRIOR_RATINGS * PRIOR_QUALITY + ratings * starQuality) / (PRIOR_RATINGS + ratings);
  return Math.round(smoothed * 100);
}

function portion(share, units) {
  return (BigInt(share) * units) / 100n;
}

function order(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// value and each ask are decimal strings; confidence and coverage are whole percents. needs maps a shop to the
// keys from its catalog the question needs. As in src/consumer/assess.ts, a shop with no
// needed key covers nothing, whatever coverage says.
export function decide({ value, confidence, missing = [], coverage, needs = {}, listings }) {
  const valueUnits = toUnits(value);
  const worth = portion(confidence, valueUnits);
  const priced = [];
  const unaffordable = [];
  for (const listing of listings) {
    if (toUnits(listing.price) > valueUnits) {
      unaffordable.push({ kind: "unaffordable", providerId: listing.id, ask: listing.price });
      continue;
    }
    const cover = (needs[listing.id]?.length ?? 0) > 0 ? coverage[listing.id] ?? 0 : 0;
    const reputation = reputationQuality(listing.reputation);
    const quality = Math.round((cover * reputation) / 100);
    const gross = portion(quality, valueUnits);
    priced.push({
      kind: "priced",
      providerId: listing.id,
      ask: listing.price,
      coverage: cover,
      reputation,
      quality,
      net: gross - toUnits(listing.price),
      reservation: gross - worth,
    });
  }
  const candidates = priced
    .filter((option) => option.coverage > 0)
    .sort((a, b) => order(b.net, a.net) || order(toUnits(a.ask), toUnits(b.ask)));
  const analysis = {
    value,
    local: { confidence, worth, missing },
    options: [...candidates, ...priced.filter((option) => option.coverage === 0), ...unaffordable],
  };
  if (priced.length === 0) return withoutDeal(analysis, { kind: "nothing-affordable" });
  const best = candidates[0];
  if (!best) return withoutDeal(analysis, { kind: "no-coverage" });
  if (best.net >= worth) return { ...analysis, kind: "buy", option: best, agreed: best.ask, negotiation: "list-price" };
  if (best.reservation <= 0n) return withoutDeal(analysis, { kind: "no-price-worth-paying", option: best });
  return { ...analysis, kind: "counter", option: best, offer: formatUnits(best.reservation) };
}

export function settleCounter(plan, reply) {
  const analysis = { value: plan.value, local: plan.local, options: plan.options };
  if (reply === "accepted") return { ...analysis, kind: "buy", option: plan.option, agreed: plan.offer, negotiation: "counter-accepted" };
  return withoutDeal(analysis, { kind: "counter-refused", option: plan.option, offer: plan.offer });
}

// A shop accepts any offer at or above its private floor.
export function replyOf(offer, floor) {
  return toUnits(offer) >= toUnits(floor) ? "accepted" : "refused";
}

function withoutDeal(analysis, because) {
  if (analysis.local.confidence >= LOCAL_FLOOR) return { ...analysis, kind: "answer-locally", because };
  return { ...analysis, kind: "decline", because };
}

export function line(label, rest) {
  return `${label.padEnd(10)}${rest}`;
}

export function field(name, value) {
  return line("", `${name.padEnd(8)}${value}`);
}

function share(percent) {
  return (percent / 100).toFixed(2);
}

function near(units) {
  const [whole, frac] = formatUnits(units).split(".");
  return `${whole ?? "0"}.${(frac ?? "").slice(0, 6).padEnd(3, "0")}`;
}

function headline(decision) {
  if (decision.kind === "buy") {
    const how = decision.negotiation === "list-price" ? "list price" : "counter-offer accepted";
    return `buy from ${decision.option.providerId} at ${decision.agreed} NEAR (${how})`;
  }
  const refused = decision.because.kind === "counter-refused" ? " (counter-offer refused)" : "";
  return `${decision.kind === "answer-locally" ? "answer locally" : "decline"}, pay nothing${refused}`;
}

function optionText(option, idWidth, value) {
  const head = `${option.providerId.padEnd(idWidth)}ask ${option.ask}  `;
  if (option.kind === "unaffordable") return `${head}outside the ${value} NEAR budget`;
  const quality = `cover ${share(option.coverage)} x rep ${share(option.reputation)} = quality ${share(option.quality)}`;
  return `${head}${quality}  net ${option.net < 0n ? "" : "+"}${near(option.net)}`;
}

function ruleRows(decision) {
  const { value, local } = decision;
  const buyRule = (option) => {
    const verdict = option.net >= local.worth ? ">=" : "<";
    return field("rule", `net = quality x value - ask; buy when net >= local worth: ${near(option.net)} ${verdict} ${near(local.worth)}`);
  };
  const reservation = (option) => `(${share(option.quality)} - ${share(local.confidence)}) x ${value} = ${near(option.reservation)} NEAR`;
  const counterRows = (option, offer, reply) => [
    field("reserve", `${reservation(option)}, where buying equals the local worth`),
    field("counter", `${offer} NEAR against the ask of ${option.ask} NEAR`),
    field("reply", `${option.providerId} ${reply}`),
  ];
  if (decision.kind === "buy") {
    if (decision.negotiation === "list-price") return [buyRule(decision.option)];
    return [buyRule(decision.option), ...counterRows(decision.option, decision.agreed, "accepted")];
  }
  const clears = local.confidence >= LOCAL_FLOOR;
  const floor = share(LOCAL_FLOOR);
  const localRule = field(
    "rule",
    `answer locally when confidence >= ${floor}: ${share(local.confidence)} ${clears ? ">=" : "<"} ${floor}${clears ? "" : ", so decline"}`,
  );
  const { because } = decision;
  switch (because.kind) {
    case "nothing-affordable":
      return [field("rule", `never pay above the budget: every ask is outside ${value} NEAR`), localRule];
    case "no-coverage":
      return [field("rule", "buy only from a shop that covers a missing fact: no shop within the budget does"), localRule];
    case "no-price-worth-paying":
      return [buyRule(because.option), field("rule", `counter only when the reservation is above zero: ${reservation(because.option)}`), localRule];
    default:
      return [buyRule(because.option), ...counterRows(because.option, because.offer, "refused, so the buyer walks away"), localRule];
  }
}

// A catalog key as the CLI names it, with the clause a rule is to be tested against.
export function needText(need) {
  if (need.kind === "figure") return `${need.company} / ${need.period} / ${need.metric}`;
  if (need.kind === "fact") return need.topic;
  return need.clause === undefined ? need.id : `${need.id} on "${need.clause}"`;
}

function needsRows(needs, idWidth) {
  const rows = Object.entries(needs)
    .filter(([, list]) => list.length > 0)
    .map(([shop, list]) => field("needs", `${shop.padEnd(idWidth)}${list.map(needText).join("; ")}`));
  if (rows.length === 0) rows.push(field("needs", "no key from any shop's catalog"));
  return rows;
}

// The decide block the CLI prints, line for line, for needs the buyer picked from each catalog.
export function decideLines(decision, needs) {
  const { value, local } = decision;
  const idWidth = decision.options.reduce((max, option) => Math.max(max, option.providerId.length), 0) + 2;
  return [
    line("decide", headline(decision)),
    field("value", `${value} NEAR, the budget: the most a right answer is worth`),
    field("local", `confidence ${share(local.confidence)} x value = worth ${near(local.worth)} NEAR`),
    field("missing", local.missing.length === 0 ? "nothing" : local.missing.join("; ")),
    ...needsRows(needs, idWidth),
    ...decision.options.map((option) => field("option", optionText(option, idWidth, value))),
    ...ruleRows(decision),
  ];
}
