import { BadRequestException } from "@nestjs/common";

const questionKeys = ["health", "delivery", "autonomy", "clarity", "workload", "collaboration"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Invalid survey fields");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > maximum)
    throw new BadRequestException("Invalid survey text");
  return value.trim();
}
export interface SurveyInput {
  title: string;
  asks_comment: boolean;
  min_responses: number;
  questions: {
    key: string | null;
    prompt: string | null;
    low_label: string | null;
    high_label: string | null;
  }[];
}
export function surveyInput(value: unknown): SurveyInput {
  const body = fields(value);
  if (
    typeof body.asks_comment !== "boolean" ||
    typeof body.min_responses !== "number" ||
    !Number.isInteger(body.min_responses) ||
    body.min_responses < 1 ||
    body.min_responses > 50 ||
    !Array.isArray(body.questions) ||
    body.questions.length < 1 ||
    body.questions.length > 12
  )
    throw new BadRequestException("Invalid survey questions or minimum responses");
  return {
    title: text(body.title, 120),
    asks_comment: body.asks_comment,
    min_responses: body.min_responses,
    questions: body.questions.map((value: unknown) => {
      const question = fields(value);
      const key = question.key == null ? null : text(question.key, 40);
      const prompt = question.prompt == null ? null : text(question.prompt, 200);
      if ((key === null) === (prompt === null) || (key !== null && !questionKeys.includes(key)))
        throw new BadRequestException("Invalid survey question");
      return {
        key,
        prompt,
        low_label: question.low_label == null ? null : text(question.low_label, 40),
        high_label: question.high_label == null ? null : text(question.high_label, 40),
      };
    }),
  };
}
export function surveyResponseInput(value: unknown) {
  const body = fields(value);
  const ratings = fields(body.ratings);
  if (
    !Object.keys(ratings).length ||
    Object.keys(ratings).length > 12 ||
    Object.entries(ratings).some(
      ([id, value]) =>
        !uuid.test(id) ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 5
    ) ||
    typeof body.comment !== "string" ||
    Array.from(body.comment.trim()).length > 2000
  )
    throw new BadRequestException(
      "Rate every question from 1 to 5; comments allow at most 2000 characters"
    );
  return { ratings, comment: body.comment.trim() };
}
export function surveyStatusInput(value: unknown): "open" | "closed" {
  const body = fields(value);
  if (body.status !== "open" && body.status !== "closed")
    throw new BadRequestException("Invalid survey status");
  return body.status;
}
