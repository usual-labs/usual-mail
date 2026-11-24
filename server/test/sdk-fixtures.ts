// What the AI SDK tests share: the real access and the six options the pipeline sends.

export { AiServiceError, DEFAULT_MODELS, sdkModelAccess, type ChoiceRequest, type TextRequest } from "../src/index.ts";
import { CATEGORY_OPTIONS } from "../src/ai/prompt.ts";

export const CATEGORY = CATEGORY_OPTIONS.map((option) => ({ ...option }));
