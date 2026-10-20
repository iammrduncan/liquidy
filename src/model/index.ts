import type { ModelConfig } from "../config.ts";
import type { Classifier } from "./classifier.ts";
import { liquidClassifier } from "./liquid.ts";
import { openaiClassifier } from "./openai.ts";

export function createClassifier(config: ModelConfig): Classifier {
  return config.provider === "liquid" ? liquidClassifier(config) : openaiClassifier(config);
}
