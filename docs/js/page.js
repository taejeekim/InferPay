import { DEFAULT_ROOT, formatNear, readState, rosterOf } from "./chain.js";
import { decide, decideLines, isDecimal, needText, reputationQuality, replyOf, settleCounter } from "./decide.js";
import evidence from "./evidence.js";
import { grade, rateLines } from "./grade.js";
import { canonical, entryKey, factKey, keyHash, leafHash, slotOf, verifyChecks, verifyFact, walk } from "./scheme.js";

// Set this to the demo post's URL to show a link to it at the top of the page. Empty hides the link.
const DEMO_URL = "";

const EXPLORER = "https://testnet.nearblocks.io";
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === "class") node.className = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function short(hash, head = 8, tail = 6) {
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

// A hash shown abbreviated in the middle; activating it shows the whole value.
function hashButton(hash, head = 12, tail = 4) {
  const button = h("button", { type: "button", class: "hash", "aria-expanded": "false", title: hash, "aria-label": `${short(hash, head, tail)}, show full hash` }, short(hash, head, tail));
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? hash : short(hash, head, tail);
    button.setAttribute("aria-label", open ? hash : `${short(hash, head, tail)}, show full hash`);
  });
  return button;
}

const accountLink = (account, text = account) => h("a", { href: `${EXPLORER}/address/${account}` }, text);

function txLink(hash) {
  return TX_HASH.test(hash)
    ? h("a", { href: `${EXPLORER}/txns/${hash}`, title: hash, class: "mono", "aria-label": `payment transaction ${hash}` }, `${hash.slice(0, 8)}…`)
    : h("span", { class: "mono" }, short(hash));
}

const firstLabel = (account) => account.split(".")[0];

function utc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}


if (DEMO_URL !== "") {
  const demo = $("demo-link");
  demo.href = DEMO_URL;
  demo.hidden = false;
}


const asked = new URLSearchParams(location.search).get("root");
const requested = asked === null || asked.trim() === "" ? DEFAULT_ROOT : asked.trim();
let roster = rosterOf(requested);
let rootNote = "";
if (!roster.ok) {
  rootNote = roster.invalid === requested
    ? `"${requested}" is not a valid NEAR root account, so this shows ${DEFAULT_ROOT}. `
    : `Under "${requested}" the account ${roster.invalid} would not be a valid NEAR account id, so this shows ${DEFAULT_ROOT}. `;
  roster = rosterOf(DEFAULT_ROOT);
}
$("root-input").value = roster.root;

let live = null;

function renderShops(state) {
  const cards = state.shops.map((shop) => {
    const { commitment, reputation } = shop;
    const stars = reputation.ratings === 0
      ? "none yet"
      : `${reputation.average.toFixed(2)} average from ${reputation.ratings} rating${reputation.ratings === 1 ? "" : "s"}`;
    const formula = reputation.ratings === 0
      ? "the prior: an unrated shop starts at 0.70"
      : `(2 × 0.70 + ${reputation.ratings} × (${reputation.average.toFixed(2)} − 1) / 4) / (2 + ${reputation.ratings})`;
    return h("article", { class: "card" },
      h("h4", {}, shop.providerId),
      h("p", { class: "account" }, accountLink(shop.account)),
      h("dl", {},
        h("dt", {}, "Root"), h("dd", {}, commitment ? hashButton(commitment.root) : h("span", { class: "low" }, "none published")),
        commitment && [
          h("dt", {}, "Entries"), h("dd", {}, String(commitment.leaves)),
          h("dt", {}, "Scheme"), h("dd", { class: "mono" }, commitment.scheme),
          h("dt", {}, "Written"), h("dd", {}, `block ${commitment.block.toLocaleString("en-US")}`),
        ],
        h("dt", {}, "Ratings"), h("dd", {}, stars),
        h("dt", {}, "Reputation"), h("dd", {}, h("span", { class: "rep" }, (reputation.quality / 100).toFixed(2)), h("br"), h("span", { class: "hint" }, formula)),
      ),
    );
  });
  $("shops").replaceChildren(...cards);
}

function renderBots(state) {
  $("bots").tBodies[0].replaceChildren(...state.bots.map((bot) => h("tr", {},
    h("td", {}, accountLink(bot.account), bot.defaultPayer ? h("span", { class: "hint" }, "  default payer") : null),
    h("td", { class: "num" }, bot.balance === null ? h("span", { class: "hint" }, "not created") : `${formatNear(bot.balance)} NEAR`),
  )));
}

function ratingRow(rating, current, earlierRule) {
  const earlierRoot = rating.root !== null && current.get(rating.shop) !== undefined && current.get(rating.shop) !== rating.root;
  const checks = earlierRule
    ? [`${rating.verified} verified`, h("br"), h("span", { class: rating.forged > 0 ? "low" : "hint" }, `${rating.unproven} unproven, ${rating.forged} forged`)]
    : [`${rating.verified} verified, `, h("span", { class: rating.withheld > 0 ? "low" : "" }, `${rating.withheld} withheld`), h("br"), h("span", { class: rating.forged > 0 ? "low" : "hint" }, `${rating.unproven} unproven, ${rating.forged} forged`)];
  return h("tr", {},
    h("td", { class: "num" }, rating.block.toLocaleString("en-US")),
    h("td", { class: `stars${rating.stars <= 2 ? " low" : ""}` }, `${rating.stars}/5`),
    h("td", {}, accountLink(rating.shop, firstLabel(rating.shop)), earlierRoot ? h("div", { class: "hint" }, "rated against an earlier root") : null),
    h("td", { class: "counts" }, ...checks),
    h("td", {}, accountLink(rating.rater, firstLabel(rating.rater))),
    h("td", {}, rating.payment === null ? h("span", { class: "low" }, "nothing paid") : txLink(rating.payment)),
  );
}

function renderRatings(state) {
  const current = new Map(state.shops.map((shop) => [shop.account, shop.commitment?.root ?? null]));
  const rows = state.ratings.map((rating) => ratingRow(rating, current, false));
  if (rows.length === 0) {
    const why = state.earlier.length === 0
      ? "No ratings under this root yet."
      : "No rating under this root was written under the current grading rule yet, so the earlier ones below do not count toward reputation.";
    rows.push(h("tr", { class: "empty-row" }, h("td", { colspan: "6" }, why)));
  }
  $("ratings").tBodies[0].replaceChildren(...rows);
  $("earlier").hidden = state.earlier.length === 0;
  $("earlier-count").textContent = String(state.earlier.length);
  $("earlier-ratings").tBodies[0].replaceChildren(...state.earlier.map((rating) => ratingRow(rating, current, true)));
}

const chainRead = readState(roster)
  .then((state) => {
    live = state;
    $("live-status").replaceChildren(
      rootNote,
      "Read at block ", h("strong", {}, state.block.toLocaleString("en-US")), ` on ${utc(state.readAt)} for the root `,
      accountLink(state.root), ". ",
      `${state.ratings.length} rating${state.ratings.length === 1 ? "" : "s"} from ${state.bots.length} buyer bots`,
      state.earlier.length === 0 ? "." : `, and ${state.earlier.length} written under the earlier rule that do not count.`,
    );
    renderShops(state);
    renderBots(state);
    renderRatings(state);
    return state;
  })
  .catch((error) => {
    const status = $("live-status");
    status.classList.add("error");
    status.textContent = `${rootNote}Could not read NEAR testnet from this browser: ${error.message}. The proof below still runs, against the root embedded in this page.`;
    for (const table of ["bots", "ratings"]) {
      $(table).tBodies[0].replaceChildren(h("tr", { class: "empty-row" }, h("td", { colspan: "6" }, "Not available while the RPC node is unreachable.")));
    }
    return null;
  });


const honest = evidence.present.evidence;
const proof = {
  mode: "present",
  entry: { ...honest.entry },
  salt: honest.salt,
  absentTopic: evidence.absent.claim.topic,
  saltFlips: 0,
  withheld: false,
};
let honestWalk = null;
let computeRun = 0;

function committedRoot() {
  const shop = live?.shops.find((item) => item.providerId === evidence.shop);
  if (shop?.commitment) {
    return { root: shop.commitment.root, source: `Read from SocialDB at block ${live.block.toLocaleString("en-US")}, key ${shop.account}/inferpay/commitment, written at block ${shop.commitment.block.toLocaleString("en-US")}.` };
  }
  if (live) return { root: evidence.commitment.root, source: `${roster.root} has no insurance commitment on chain, so this compares with the root embedded in this page.` };
  return { root: evidence.commitment.root, source: "NEAR testnet was not reachable, so this compares with the root embedded in this page, which the repository's tests tie to the published root." };
}

function hashText(hash) {
  return hash === null ? h("span", { class: "low" }, "none") : hashButton(hash, 16, 8);
}

function verdictView(result, claimText, opened, committed) {
  const box = $("verdict");
  const withheld = proof.mode === "present" && proof.withheld;
  const ok = result.status === "verified" && !withheld;
  box.className = `verdict ${ok ? "ok" : "bad"}`;
  let head;
  let body;
  if (withheld) {
    head = "WITHHELD";
    body = `The shop sent no check on ${evidence.present.claim.topic}. The buyer needed this key, so it counts as withheld. The steps on the right show the evidence the shop held back.`;
  } else if (ok && result.verdict === "absent") {
    head = "VERIFIED: ABSENT";
    body = `The slot for this key is empty in the committed tree, so the shop provably holds nothing on ${claimText}. The buyer did not ask about this key, so the check is unrequested and counts neither for nor against the shop.`;
  } else if (ok) {
    head = `VERIFIED: ${result.verdict.toUpperCase()}`;
    body = `The evidence opens to the root on chain, and the buyer recomputes the verdict from the entry: value "${proof.entry.value}" against the claim "${evidence.present.claim.claimed}".`;
  } else if (result.forgery === "wrong-root") {
    head = "FORGED";
    body = opened === null
      ? "The salt is not 64 hex characters, so no leaf hash can be computed and the evidence cannot open to the root. The buyer rejects it."
      : `The evidence opens to ${short(opened)}, not to the committed root ${short(committed)}. The shop cannot change a root it already published, so this evidence did not come from its dataset. The rating drops to 1/5.`;
  } else if (result.forgery === "wrong-entry") {
    head = "FORGED";
    body = `The entry is about "${proof.entry.topic}", but the claim is about "${evidence.present.claim.topic}". Evidence for one key cannot stand in for another. The rating drops to 1/5.`;
  } else if (result.forgery === "wrong-verdict") {
    head = "FORGED";
    body = `The evidence opens to the root, but the entry does not support the shop's verdict (the buyer recomputes ${result.recomputed}).`;
  } else {
    head = result.status.toUpperCase();
    body = "The shop sent no usable evidence for this claim.";
  }
  box.replaceChildren(h("p", { class: "head" }, head), h("p", {}, body));
}

async function computeProof() {
  const run = (computeRun += 1);
  const present = proof.mode === "present";
  const key = present ? entryKey(proof.entry) : factKey({ topic: proof.absentTopic });
  const [hashOfKey, slot] = await Promise.all([keyHash(key), slotOf(key)]);
  const leaf = present ? await leafHash(proof.entry, proof.salt) : null;
  const path = present ? honest.path : evidence.absent.evidence.path;
  const walked = present && leaf === null ? null : await walk(slot, leaf, path);
  const { root: committed, source } = committedRoot();
  const check = present
    ? { claim: evidence.present.claim, verdict: evidence.present.verdict, evidence: { entry: proof.entry, salt: proof.salt, path } }
    : { claim: { ...evidence.absent.claim, topic: proof.absentTopic }, verdict: evidence.absent.verdict, evidence: evidence.absent.evidence };
  const result = await verifyFact(check, committed);
  const sent = sentChecks();
  const results = await verifyChecks(sent, committed, evidence.needs);
  const shownLeaf = present ? leaf : await emptyLeaf();
  if (run !== computeRun) return;

  $("w-key").textContent = canonical(key);
  $("w-keyhash").replaceChildren(hashButton(hashOfKey, 8, 4));
  $("w-slot").replaceChildren(h("strong", {}, hashOfKey.slice(0, 8)), ` = ${slot.toLocaleString("en-US")}`);
  if (present) {
    $("w-leaf-title").textContent = "Leaf hash";
    $("w-leaf-formula").textContent = "sha256(00 ‖ salt ‖ entry)";
    $("w-leaf").replaceChildren(shownLeaf === null ? h("span", { class: "low" }, "salt is not 64 hex characters") : hashButton(shownLeaf, 16, 8));
    $("w-entry-row").hidden = false;
    $("w-entry").textContent = canonical(proof.entry);
  } else {
    $("w-leaf-title").textContent = "The slot is empty";
    $("w-leaf-formula").textContent = "E0 = sha256(02)";
    $("w-leaf").replaceChildren(hashButton(shownLeaf, 16, 8));
    $("w-entry-row").hidden = true;
  }

  const reference = present ? honestWalk : null;
  $("w-levels").tBodies[0].replaceChildren(...(walked?.steps ?? []).map((step, index) => {
    const changed = reference !== null && reference.steps[index]?.node !== step.node;
    return h("tr", { class: step.siblingEmpty ? "" : "given" },
      h("td", {}, String(step.level)),
      h("td", { class: "dim" }, step.side),
      h("td", { title: step.sibling }, step.siblingEmpty ? h("span", { class: "dim" }, `E${step.level}`) : short(step.sibling)),
      h("td", { title: step.node, class: changed ? "changed" : "" }, short(step.node)),
    );
  }));
  $("w-root").replaceChildren(hashText(walked?.root ?? null), walked && walked.root === committed ? "  equal" : h("span", { class: "low" }, "  different"));
  $("w-chain-root").replaceChildren(hashButton(committed, 16, 8));
  $("w-chain-source").textContent = source;
  verdictView(result, present ? evidence.present.claim.label : proof.absentTopic, walked?.root ?? null, committed);
  renderNeededKeys(sent, results);
}

// The checks the shop sends for the question, with the visitor's edits: the MRI check unless it is withheld, the
// copay check, and the check on a key the buyer did not ask for.
function sentChecks() {
  const mri = { kind: "fact", claim: evidence.present.claim, verdict: evidence.present.verdict, evidence: { entry: proof.entry, salt: proof.salt, path: honest.path } };
  const dental = { kind: "fact", claim: { ...evidence.absent.claim, topic: proof.absentTopic }, verdict: evidence.absent.verdict, evidence: evidence.absent.evidence };
  return [...(proof.withheld ? [] : [mri]), evidence.copay, dental];
}

const STATUS_TEXT = { verified: "verified", unrequested: "unrequested", withheld: "WITHHELD", forged: "FORGED", unproven: "unproven" };

function renderNeededKeys(sent, results) {
  $("n-checks").tBodies[0].replaceChildren(...results.map((result, index) => {
    const key = result.status === "withheld" ? result.need.topic : sent[index].claim.topic;
    const verdict = result.status === "withheld" ? "no opening sent"
      : result.status === "forged" ? result.forgery
        : result.verdict === "absent" ? "no entry" : result.verdict ?? "";
    const bad = result.status === "withheld" || result.status === "forged";
    return h("tr", {},
      h("td", { class: "mono" }, key),
      h("td", { class: bad ? "mono low" : "mono" }, STATUS_TEXT[result.status]),
      h("td", { class: "mono" }, verdict));
  }));
  $("n-rate").textContent = rateLines(grade(results)).join("\n");
  $("withhold").setAttribute("aria-pressed", String(proof.withheld));
}

let emptyLeafHash = null;
async function emptyLeaf() {
  if (emptyLeafHash === null) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.of(2)));
    emptyLeafHash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return emptyLeafHash;
}

function fillProofInputs() {
  $("f-topic").value = proof.entry.topic;
  $("f-value").value = proof.entry.value;
  $("f-source").value = proof.entry.source;
  $("f-salt").value = proof.salt;
  $("f-absent-topic").value = proof.absentTopic;
}

function showMode(mode) {
  proof.mode = mode;
  const present = mode === "present";
  $("tab-present").setAttribute("aria-selected", String(present));
  $("tab-absent").setAttribute("aria-selected", String(!present));
  $("tab-present").tabIndex = present ? 0 : -1;
  $("tab-absent").tabIndex = present ? -1 : 0;
  $("entry-fields").hidden = !present;
  $("absent-fields").hidden = present;
  $("tamper-value").hidden = !present;
  $("tamper-salt").hidden = !present;
  const claim = present ? evidence.present : evidence.absent;
  $("claim-text").textContent = present
    ? `${claim.claim.label}: ${claim.claim.claimed}`
    : `${claim.claim.label}: the shop holds no entry for this key`;
  $("claim-verdict").textContent = present ? "match" : "unverifiable (nothing to check against)";
  computeProof();
}

for (const [id, field] of [["f-topic", "topic"], ["f-value", "value"], ["f-source", "source"]]) {
  $(id).addEventListener("input", (event) => {
    proof.entry = { ...proof.entry, [field]: event.target.value };
    computeProof();
  });
}
$("f-salt").addEventListener("input", (event) => {
  proof.salt = event.target.value.trim().toLowerCase();
  $("f-salt").setAttribute("aria-invalid", String(!/^[0-9a-f]{64}$/.test(proof.salt)));
  computeProof();
});
$("f-absent-topic").addEventListener("input", (event) => {
  proof.absentTopic = event.target.value;
  computeProof();
});
$("tamper-value").addEventListener("click", () => {
  proof.entry = { ...proof.entry, value: proof.entry.value === "excluded" ? "covered" : "excluded" };
  fillProofInputs();
  computeProof();
});
$("tamper-salt").addEventListener("click", () => {
  const at = (proof.saltFlips * 23 + 7) % 64;
  proof.saltFlips += 1;
  const digit = parseInt(proof.salt[at] ?? "0", 16);
  const next = Number.isNaN(digit) ? "0" : ((digit + 1) % 16).toString(16);
  proof.salt = `${proof.salt.slice(0, at)}${next}${proof.salt.slice(at + 1)}`;
  fillProofInputs();
  $("f-salt").setAttribute("aria-invalid", "false");
  computeProof();
});
$("withhold").addEventListener("click", () => {
  proof.withheld = !proof.withheld;
  computeProof();
});
$("reset-proof").addEventListener("click", () => {
  proof.withheld = false;
  proof.entry = { ...honest.entry };
  proof.salt = honest.salt;
  proof.absentTopic = evidence.absent.claim.topic;
  fillProofInputs();
  $("f-salt").setAttribute("aria-invalid", "false");
  computeProof();
});
$("tab-present").addEventListener("click", () => showMode("present"));
$("tab-absent").addEventListener("click", () => showMode("absent"));
for (const tab of [$("tab-present"), $("tab-absent")]) {
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = proof.mode === "present" ? "absent" : "present";
    showMode(next);
    $(`tab-${next}`).focus();
  });
}

$("n-question").textContent = evidence.question;
$("n-needs").textContent = evidence.needs.map((need) => need.topic).join(", ");
fillProofInputs();
showMode("present");
Promise.all([slotOf(entryKey(honest.entry)), leafHash(honest.entry, honest.salt)])
  .then(([slot, leaf]) => walk(slot, leaf, honest.path))
  .then((walked) => {
    honestWalk = walked;
    return chainRead;
  })
  .then(() => computeProof());


const PRESETS = {
  list: { shop: "insurance", budget: "0.10", confidence: "0.20", coverage: "1.00", average: "", count: "0", ask: "0.02", floor: "0.012", missing: "this policy's schedule of covered procedures", needs: ["outpatient-mri", "mri-copay"] },
  accepted: { shop: "insurance", budget: "0.03", confidence: "0.20", coverage: "1.00", average: "5", count: "1", ask: "0.02", floor: "0.012", missing: "this policy's schedule of covered procedures", needs: ["outpatient-mri", "mri-copay"] },
  refused: { shop: "disclosure", budget: "0.10", confidence: "0.55", coverage: "1.00", average: "", count: "0", ask: "0.02", floor: "0.018", missing: "the revenue Samsung filed for Q3 2025", needs: ["Samsung Electronics / Q3 2025 / revenue"] },
  decline: { shop: "disclosure", budget: "0.10", confidence: "0.45", coverage: "1.00", average: "3", count: "3", ask: "0.02", floor: "0.018", missing: "the revenue Samsung filed for Q3 2025", needs: ["Samsung Electronics / Q3 2025 / revenue"] },
  local: { shop: "insurance", budget: "0.10", confidence: "0.99", coverage: "0.00", average: "5", count: "1", ask: "0.02", floor: "0.012", missing: "", needs: [] },
};
// A rule is tested against a clause quoted from the question, so each rule carries the clause from a recorded question.
const CLAUSES = { "uncapped-indemnity": "unlimited indemnification clause", "perpetual-nda": "three-year confidentiality term" };

function catalogNeeds(shop) {
  return (evidence.catalogs[shop] ?? []).map((item) => (item.kind === "rule" ? { ...item, clause: CLAUSES[item.id] } : item));
}

function renderNeeds(shop, checked) {
  const boxes = catalogNeeds(shop).map((need, index) => {
    const id = `c-need-${index}`;
    return h("label", { class: "check", for: id },
      h("input", { type: "checkbox", id, "data-need": String(index), checked: checked.includes(needText({ ...need, clause: undefined })) }),
      " ", h("span", { class: "mono" }, needText(need)));
  });
  $("c-needs").replaceChildren(...boxes);
  $("c-needs").dataset.shop = shop;
}

function checkedNeeds(shop) {
  const all = catalogNeeds(shop);
  return [...$("c-needs").querySelectorAll("input:checked")].map((box) => all[Number(box.dataset.need)]);
}
const FIELDS = ["shop", "budget", "confidence", "coverage", "average", "count", "ask", "floor"];
let missing = PRESETS.list.missing;

function share(raw) {
  const value = Number(raw);
  return raw.trim() !== "" && value >= 0 && value <= 1 ? Math.round(value * 100) : null;
}

function readCalc() {
  const raw = Object.fromEntries(FIELDS.map((field) => [field, $(`c-${field}`).value.trim()]));
  const count = /^\d+$/.test(raw.count) ? Number(raw.count) : null;
  const average = Number(raw.average);
  const problems = {
    budget: !isDecimal(raw.budget) || Number(raw.budget) === 0,
    confidence: share(raw.confidence) === null,
    coverage: share(raw.coverage) === null,
    count: count === null,
    average: count !== null && count > 0 && !(raw.average !== "" && average >= 1 && average <= 5),
    ask: !isDecimal(raw.ask),
    floor: !isDecimal(raw.floor),
  };
  for (const [field, bad] of Object.entries(problems)) $(`c-${field}`).setAttribute("aria-invalid", String(bad));
  const invalid = Object.keys(problems).filter((field) => problems[field]);
  if (invalid.length > 0) return { error: `Check ${invalid.join(", ")}.` };
  return {
    shop: raw.shop,
    value: raw.budget,
    confidence: share(raw.confidence),
    coverage: share(raw.coverage),
    reputation: { ratings: count, average: count > 0 ? average : 0 },
    ask: raw.ask,
    floor: raw.floor,
  };
}

function runCalc() {
  const input = readCalc();
  const outcome = $("calc-outcome");
  if (input.error) {
    outcome.className = "outcome error";
    outcome.textContent = input.error;
    $("calc-out").textContent = "";
    return;
  }
  if ($("c-needs").dataset.shop !== input.shop) renderNeeds(input.shop, []);
  const needs = { [input.shop]: checkedNeeds(input.shop) };
  const plan = decide({
    value: input.value,
    confidence: input.confidence,
    missing: missing === "" ? [] : [missing],
    coverage: { [input.shop]: input.coverage },
    needs,
    listings: [{ id: input.shop, price: input.ask, reputation: input.reputation }],
  });
  const decision = plan.kind === "counter" ? settleCounter(plan, replyOf(plan.offer, input.floor)) : plan;
  $("calc-out").textContent = decideLines(decision, needs).join("\n");
  outcome.className = "outcome";
  const refused = decision.because?.kind === "counter-refused";
  outcome.textContent = decision.kind === "buy"
    ? decision.negotiation === "list-price" ? `Buy at the list price, ${decision.agreed} NEAR.` : `Counter-offer accepted: buy at ${decision.agreed} NEAR.`
    : decision.kind === "answer-locally"
      ? refused ? "Counter-offer refused: the buyer answers alone and pays nothing." : "Answer alone and pay nothing."
      : refused ? "Counter-offer refused: the buyer declines and pays nothing." : "Decline and pay nothing.";
  const rep = reputationQuality(input.reputation);
  $("c-live-note").textContent = $("c-live-note").dataset.live ?? `Reputation from these stars: ${(rep / 100).toFixed(2)}.`;
}

function loadPreset(name) {
  const preset = PRESETS[name];
  for (const field of FIELDS) $(`c-${field}`).value = preset[field];
  renderNeeds(preset.shop, preset.needs);
  missing = preset.missing;
  for (const button of document.querySelectorAll("#presets button")) button.setAttribute("aria-pressed", String(button.dataset.preset === name));
  delete $("c-live-note").dataset.live;
  runCalc();
}

for (const button of document.querySelectorAll("#presets button")) button.addEventListener("click", () => loadPreset(button.dataset.preset));
$("calc").addEventListener("input", () => {
  for (const button of document.querySelectorAll("#presets button")) button.setAttribute("aria-pressed", "false");
  delete $("c-live-note").dataset.live;
  runCalc();
});
$("calc").addEventListener("submit", (event) => event.preventDefault());
$("c-live").addEventListener("click", () => {
  const note = $("c-live-note");
  const shop = live?.shops.find((item) => item.providerId === $("c-shop").value);
  if (!shop) {
    note.dataset.live = "The live state has not loaded, so there is no on-chain reputation to use.";
  } else {
    $("c-count").value = String(shop.reputation.ratings);
    $("c-average").value = shop.reputation.average === null ? "" : String(Number(shop.reputation.average.toFixed(4)));
    note.dataset.live = `${shop.reputation.ratings} on-chain rating${shop.reputation.ratings === 1 ? "" : "s"} for ${shop.providerId} at block ${live.block.toLocaleString("en-US")}: reputation ${(shop.reputation.quality / 100).toFixed(2)}.`;
  }
  runCalc();
});
loadPreset("list");
