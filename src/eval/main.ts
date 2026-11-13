import { measure } from "./measure.ts";
import { renderReport } from "./render.ts";

const report = await measure();
process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report)}\n`);
if (report.failures.length > 0) {
  process.stderr.write(`eval invariants failed:\n${report.failures.map((failure) => `  ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
}
