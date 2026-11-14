// Runs the site's chain module against NEAR testnet from Node and prints what the page shows.
// Usage: node src/site/read-chain.ts [root account]

type Chain = {
  DEFAULT_ROOT: string;
  rosterOf(root: string): { readonly ok: boolean; readonly invalid?: string };
  readState(roster: unknown): Promise<{
    readonly root: string;
    readonly block: number;
    readonly readAt: string;
    readonly shops: readonly { readonly providerId: string; readonly account: string; readonly commitment: { readonly root: string; readonly leaves: number; readonly scheme: string; readonly block: number } | null; readonly reputation: { readonly ratings: number; readonly average: number | null; readonly quality: number } }[];
    readonly bots: readonly { readonly account: string; readonly balance: bigint | null }[];
    readonly ratings: readonly { readonly block: number; readonly rater: string; readonly shop: string; readonly stars: number; readonly verified: number; readonly unproven: number; readonly forged: number; readonly withheld: number; readonly payment: string; readonly jobId: string }[];
    readonly earlier: readonly unknown[];
  }>;
  formatNear(yocto: bigint): string;
};

const chain = (await import(new URL("../../docs/js/chain.js", import.meta.url).href)) as Chain;
const root = process.argv[2] ?? chain.DEFAULT_ROOT;
const roster = chain.rosterOf(root);
if (!roster.ok) {
  console.error(`${roster.invalid} is not a valid NEAR account id`);
  process.exit(1);
}
const state = await chain.readState(roster);
console.log(`root ${state.root}  block ${state.block}  read ${state.readAt}`);
for (const shop of state.shops) {
  const c = shop.commitment;
  const rep = shop.reputation;
  const stars = rep.average === null ? "unrated" : `${rep.average.toFixed(2)} stars from ${rep.ratings}`;
  console.log(`shop ${shop.providerId.padEnd(10)} ${shop.account}  ${c ? `root ${c.root} ${c.leaves} leaves at block ${c.block}` : "no commitment"}  ${stars}  rep ${(rep.quality / 100).toFixed(2)}`);
}
for (const bot of state.bots) console.log(`bot  ${bot.account.padEnd(36)} ${bot.balance === null ? "not created" : `${chain.formatNear(bot.balance)} NEAR`}`);
for (const r of state.ratings) {
  console.log(`rate block ${r.block}  ${r.stars}/5  ${r.shop.split(".")[0]}  by ${r.rater.split(".")[0]}  verified ${r.verified} unproven ${r.unproven} forged ${r.forged} withheld ${r.withheld}  tx ${r.payment}`);
}
console.log(`${state.earlier.length} ratings written under the earlier rule, not counted`);
