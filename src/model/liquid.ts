import { z } from "zod";
import type { ModelConfig } from "../config.ts";
import { type Classifier, CRITERIA, INSTRUCTIONS, LABELS } from "./classifier.ts";
import { bearer, ModelError, postJson } from "./http.ts";

const Reply = z.object({
  answers: z.object({
    verdict: z.object({
      type: z.literal("choice"),
      choice: z.enum(LABELS),
      probabilities: z.object({ legitimate: z.number(), spam: z.number(), scam: z.number() }),
    }),
  }),
  usage: z.object({ input_tokens: z.number() }).optional(),
});

/**
 * d1 through Liquid AI's System One API (POST /decisions/v1/systemone). d1 is a decision model:
 * it returns calibrated probabilities over the options it is given and generates no text, so
 * each message is one Choice question over the three labels.
 * https://docs.liquid.ai/lfm/models/d1
 */
export function liquidClassifier(config: ModelConfig): Classifier {
  const url = `${config.baseUrl}/decisions/v1/systemone`;
  return {
    name: `liquid:${config.model}`,
    async classify({ state, images }) {
      const reply = await postJson(
        url,
        {
          model: config.model,
          state: JSON.stringify(state),
          questions: {
            verdict: { type: "choice", instructions: INSTRUCTIONS, criteria: CRITERIA },
          },
          ...(images.length > 0 && { images }),
        },
        bearer(config.apiKey),
        config.timeoutMs,
      );
      const parsed = Reply.safeParse(reply);
      if (!parsed.success)
        throw new ModelError(`unexpected System One reply: ${z.prettifyError(parsed.error)}`);
      const { verdict } = parsed.data.answers;
      return {
        label: verdict.choice,
        probabilities: verdict.probabilities,
        inputTokens: parsed.data.usage?.input_tokens,
      };
    },
  };
}
