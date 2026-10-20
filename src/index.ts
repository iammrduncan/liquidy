import { startBot } from "./bot.ts";
import { type BotConfig, ConfigError, loadBotConfig } from "./config.ts";
import { errorText, log } from "./log.ts";
import { createClassifier } from "./model/index.ts";
import { ExampleStore } from "./store.ts";

let config: BotConfig;
try {
  config = loadBotConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const classifier = createClassifier(config.model);
const store = new ExampleStore(config.databasePath);
const client = await startBot(config, classifier, store).catch((e: unknown) => {
  log.error("could not start", { error: errorText(e) });
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    log.info("shutting down", { signal });
    void client.destroy().finally(() => {
      store.close();
      process.exit(0);
    });
  });
