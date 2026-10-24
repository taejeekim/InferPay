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
  ],
  message: "Import the disclosure provider through src/providers/disclosure/index.ts.",
};

function restricted({ sdk, openai }) {
  const paths = [];
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
  return ["error", { paths, patterns: [marketInternals, disclosureInternals] }];
}

const brandCasts = ["error",
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='PaidOrder']",
    message: "Construct PaidOrder only in src/market/index.ts.",
  },
  {
    selector: "TSAsExpression > TSTypeReference[typeName.name='CompletedJob']",
    message: "Construct CompletedJob only in src/market/index.ts.",
  },
];

export default tseslint.config(
  { ignores: ["node_modules/**", ".inferpay/**", "dist/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/payment/near-intents.ts", "src/inference/near-ai.ts"],
    rules: { "no-restricted-imports": restricted({ sdk: true, openai: true }) },
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
    ignores: ["src/market/index.ts"],
    rules: { "no-restricted-syntax": brandCasts },
  },
);
