import { BadRequestException } from "@nestjs/common";
import { planningRoleInput, type PlanningRole } from "./planner-input.js";

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
