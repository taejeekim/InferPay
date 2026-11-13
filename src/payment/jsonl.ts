import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// A crash mid-append can leave a torn last line. Only that line is skipped; a bad line anywhere else is corruption.
export async function readJsonl<Row>(file: string, parse: (raw: unknown) => Row | null): Promise<readonly Row[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: Row[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    const row = parseLine(line, parse);
    if (row !== null) {
      rows.push(row);
      continue;
    }
    if (index === lines.length - 1) continue;
    throw new Error(`${file} line ${index + 1} is not a record`);
  }
  return rows;
}

export async function appendJsonl(file: string, row: object): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.write(`${JSON.stringify(row)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function serialize(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

function parseLine<Row>(line: string, parse: (raw: unknown) => Row | null): Row | null {
  try {
    return parse(JSON.parse(line));
  } catch {
    return null;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
