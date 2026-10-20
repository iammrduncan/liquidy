// Writes every labelled example as one JSON object per line, for training or evaluation:
//   npm run -s export > examples.jsonl
// Reads DATABASE_PATH (default data/liquidy.db), and nothing else, from the environment.
import { existsSync } from "node:fs";
import { loadDatabasePath } from "./config.ts";
import { ExampleStore } from "./store.ts";

const path = loadDatabasePath();
if (!existsSync(path)) {
  console.error(`no database at ${path}: mark a message in Discord first, or set DATABASE_PATH`);
  process.exit(1);
}

const store = new ExampleStore(path);
try {
  for (const example of store.examples()) process.stdout.write(`${JSON.stringify(example)}\n`);
} finally {
  store.close();
}
