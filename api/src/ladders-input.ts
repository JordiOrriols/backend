import { BadRequestException } from "@nestjs/common";
import { planningRoleInput, type PlanningRole } from "./planner-input.js";

const categories = ["Technology", "System", "People", "Process", "Influence"];
export interface EvaluationContent {
  current_levels: Record<string, number>;
  goal_levels: Record<string, number>;
  comments: Record<string, string>;
}
function competencyMap<T>(
  value: unknown,
  valid: (value: unknown) => value is T
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Invalid evaluation content");
  const entries = Object.entries(value);
  const result: Record<string, T> = {};
  for (const [key, value] of entries) {
    if (!categories.includes(key) || !valid(value))
      throw new BadRequestException("Invalid evaluation content");
    result[key] = value;
  }
  return result;
}
export function evaluationContentInput(body: unknown): EvaluationContent {
  if (
    !body ||
    typeof body !== "object" ||
    !("current_levels" in body) ||
    !("goal_levels" in body) ||
    !("comments" in body)
  )
    throw new BadRequestException("Invalid evaluation content");
  const level = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 5.5 &&
    Number.isInteger(value * 2);
  return {
    current_levels: competencyMap(body.current_levels, level),
    goal_levels: competencyMap(body.goal_levels, level),
    comments: competencyMap(
      body.comments,
      (value): value is string => typeof value === "string" && Array.from(value).length <= 2000
    ),
  };
}
export function evaluationStatusInput(body: unknown): "draft" | "published" {
  if (
    !body ||
    typeof body !== "object" ||
    !("status" in body) ||
    (body.status !== "draft" && body.status !== "published")
  )
    throw new BadRequestException("Invalid evaluation status");
  return body.status;
}

export function commentVisibilityInput(body: unknown): boolean {
  if (
    !body ||
    typeof body !== "object" ||
    !("visible" in body) ||
    typeof body.visible !== "boolean"
  )
    throw new BadRequestException("Choose an existing competency comment");
  return body.visible;
}

export interface MemberProfileInput {
  name: string;
  role: string;
  planning_role: PlanningRole | null;
  template_id: string | null;
}
export function memberProfileInput(body: unknown): MemberProfileInput {
  if (
    !body ||
    typeof body !== "object" ||
    !("name" in body) ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    Array.from(body.name.trim()).length > 120 ||
    !("role" in body) ||
    typeof body.role !== "string" ||
    Array.from(body.role.trim()).length > 120 ||
    !("planning_role" in body) ||
    !("template_id" in body) ||
    (body.template_id !== null &&
      (typeof body.template_id !== "string" || Array.from(body.template_id).length > 10))
  )
    throw new BadRequestException("Invalid member profile");
  return {
    name: body.name.trim(),
    role: body.role.trim(),
    planning_role: planningRoleInput({ role: body.planning_role }),
    template_id: body.template_id,
  };
}
