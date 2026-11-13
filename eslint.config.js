import tseslint from "typescript-eslint";

const marketInternals = {
  group: [
    "**/market/job",
    "**/market/job.ts",
    "**/market/job.js",
    "**/market/ledger",
    "**/market/ledger.ts",
    "**/market/ledger.js",
  ],
  message: "Import the marketplace through src/market/index.ts.",
};

const disclosureInternals = {
  group: [
    "**/disclosure/crossValidate",
    "**/disclosure/crossValidate.ts",
    "**/disclosure/facts",
    "**/disclosure/facts.ts",
    "**/disclosure/data",
    "**/disclosure/data/*",
    "**/providers/disclosure/crossValidate*",
    "**/providers/disclosure/facts*",
    "**/providers/disclosure/data/**",
    "**/legal/flagClauses",
    "**/legal/flagClauses.ts",
    "**/legal/playbook",
    "**/legal/playbook.ts",
    "**/legal/data",
    "**/legal/data/*",
    "**/providers/legal/flagClauses*",
    "**/providers/legal/playbook*",
    "**/providers/legal/data/**",
    "**/insurance/lookup",
    "**/insurance/lookup.ts",
    "**/insurance/schedule",
    "**/insurance/schedule.ts",
    "**/insurance/data",
    "**/insurance/data/*",
    "**/providers/insurance/lookup*",
    "**/providers/insurance/schedule*",
    "**/providers/insurance/data/**",
  ],
  message: "Import a specialist through its src/providers/<id>/index.ts.",
};

const shops = {
  group: ["**/providers/*/**", "**/providers/index", "**/providers/index.ts"],
  message: "Buyer code verifies a shop from its public evidence. Import src/commitment, not a shop.",
};

function restricted({ sdk, openai, near = true, buyer = false }) {
  const paths = [];
  if (near) {
    paths.push(
      { name: "near-api-js", message: "Import near-api-js only from src/near/client.ts." },
      { name: "near-api-js/rpc-errors", message: "Import near-api-js only from src/near/client.ts." },
    );
  }
  if (sdk) {
    paths.push({
      name: "@near-intents-agent-api/sdk",
      message: "Import @near-intents-agent-api/sdk only from src/payment/near-intents.ts.",
    });
  }
  if (openai) {
    paths.push({
      name: "openai",
      message: "Import openai only from src/inference/near-ai.ts.",
    });
  }
  return ["error", { paths, patterns: buyer ? [marketInternals, disclosureInternals, shops] : [marketInternals, disclosureInternals] }];
}

const paidCasts = [
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='PaidOrder']",
    message: "Construct PaidOrder only in src/market/index.ts.",
  },
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='CompletedJob']",
    message: "Construct CompletedJob only in src/market/index.ts.",
  },
];

const seatCasts = [
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='BuyerSeat']",
    message: "Construct BuyerSeat only in src/roster.ts.",
  },
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='ShopSeat']",
    message: "Construct ShopSeat only in src/roster.ts.",
  },
];

const verifiedCasts = [
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='VerifiedCheck']",
    message: "Construct VerifiedCheck only in src/consumer/verify.ts.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/**", ".inferpay/**", "dist/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/payment/near-intents.ts", "src/inference/near-ai.ts", "src/near/client.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: true, openai: true }) },
  },
  {
    files: ["src/consumer/**/*.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: true, openai: true, buyer: true }) },
  },
  {
    files: ["src/near/client.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: true, openai: true, near: false }) },
  },
  {
    files: ["src/payment/near-intents.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: false, openai: true }) },
  },
  {
    files: ["src/inference/near-ai.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: true, openai: false }) },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/market/index.ts", "src/roster.ts", "src/consumer/verify.ts"],
    rules: { "no-restricted-syntax": ["error", ...paidCasts, ...seatCasts, ...verifiedCasts] },
  },
  {
    files: ["src/market/index.ts"],
    rules: { "no-restricted-syntax": ["error", ...seatCasts, ...verifiedCasts] },
  },
  {
    files: ["src/roster.ts"],
    rules: { "no-restricted-syntax": ["error", ...paidCasts, ...verifiedCasts] },
  },
  {
    files: ["src/consumer/verify.ts"],
    rules: { "no-restricted-syntax": ["error", ...paidCasts, ...seatCasts] },
  },
);
