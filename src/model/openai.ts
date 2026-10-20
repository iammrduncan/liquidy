import { z } from "zod";
import type { ModelConfig } from "../config.ts";
import {
  type Classifier,
  CRITERIA,
  INSTRUCTIONS,
  LABELS,
  type Label,
  type Probabilities,
} from "./classifier.ts";
import { bearer, ModelError, postJson } from "./http.ts";

const SYSTEM_PROMPT = [
  INSTRUCTIONS,
  "",
  "Labels:",
  ...LABELS.map((label) => `- ${label}: ${CRITERIA[label]}`),
  "",
  'Reply with only a JSON object: {"label": one of the labels, "confidence": your probability, ' +
    "from 0 to 1, that the label is right}.",
].join("\n");

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    strict: true,
    schema: {
      type: "object",
      properties: { label: { type: "string", enum: LABELS }, confidence: { type: "number" } },
      required: ["label", "confidence"],
      additionalProperties: false,
    },
  },
};

const Reply = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number() }).optional(),
});

const Answer = z.object({ label: z.enum(LABELS), confidence: z.number().min(0).max(1) });

/**
 * Any OpenAI-compatible chat completions endpoint, such as a LiteLLM proxy. A chat model states
 * its own confidence, which is not calibrated the way d1's probabilities are, so the threshold
 * may need tuning per model.
 */
export function openaiClassifier(config: Extract<ModelConfig, { provider: "openai" }>): Classifier {
  const url = `${config.baseUrl}/chat/completions`;
  return {
    name: `openai:${config.model}`,
    async classify({ state, images }) {
      const text = JSON.stringify(state);
      const content =
        images.length > 0
          ? [
              { type: "text", text },
              ...images.map((image) => ({ type: "image_url", image_url: { url: image } })),
            ]
          : text;
      const reply = await postJson(
        url,
        {
          model: config.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content },
          ],
          response_format: RESPONSE_FORMAT,
        },
        bearer(config.apiKey),
        config.timeoutMs,
      );
      const parsed = Reply.safeParse(reply);
      if (!parsed.success)
        throw new ModelError(`unexpected chat completion: ${z.prettifyError(parsed.error)}`);
      const answer = Answer.safeParse(jsonObject(parsed.data.choices[0]?.message.content ?? ""));
      if (!answer.success)
        throw new ModelError(`unexpected verdict from the model: ${z.prettifyError(answer.error)}`);
      return {
        label: answer.data.label,
        probabilities: spread(answer.data.label, answer.data.confidence),
        inputTokens: parsed.data.usage?.prompt_tokens,
      };
    },
  };
}

/**
 * The JSON object in a reply, ignoring code fences and any reasoning written before it. The
 * object has no nesting, so it starts at the last "{".
 */
export function jsonObject(text: string): unknown {
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new ModelError(`no JSON object in reply: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelError(`malformed JSON in reply: ${text.slice(0, 200)}`);
  }
}

/** Gives the chosen label its stated confidence and splits the rest evenly. */
export function spread(label: Label, confidence: number): Probabilities {
  const rest = (1 - confidence) / (LABELS.length - 1);
  const probabilities: Probabilities = { legitimate: rest, spam: rest, scam: rest };
  probabilities[label] = confidence;
  return probabilities;
}
