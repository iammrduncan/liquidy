// Asks the configured model about one message, without Discord, to try prompts and thresholds:
//   npm run classify -- "Free Nitro for everyone: https://dlscord-gift.com/claim"
// Only the model settings are read from the environment (LIQUID_API_KEY, MODEL, ...).
import { ConfigError, loadModelConfig } from "./config.ts";
import { extractLinks } from "./context.ts";
import { type Classifier, flagProbability } from "./model/classifier.ts";
import { liquidClassifier } from "./model/liquid.ts";

const text = process.argv.slice(2).join(" ");
if (!text) {
  console.error('usage: npm run classify -- "<message text>"');
  process.exit(2);
}

let classifier: Classifier;
try {
  classifier = liquidClassifier(loadModelConfig());
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const state = { message: { text, links: extractLinks(text) } };
const verdict = await classifier.classify({ state, images: [] });
console.log(
  JSON.stringify(
    {
      model: classifier.name,
      ...verdict,
      flagProbability: Math.round(flagProbability(verdict) * 1e4) / 1e4,
    },
    null,
    2,
  ),
);
