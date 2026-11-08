import { BadRequestException } from "@nestjs/common";

export interface ApplicationInput {
  name: string;
  description: string;
  team_id: string | null;
}
export function applicationInput(body: unknown): ApplicationInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Application fields are required");
  const fields = Object.fromEntries(Object.entries(body));
  if (
    typeof fields.name !== "string" ||
    !fields.name.trim() ||
    Array.from(fields.name.trim()).length > 120 ||
    typeof fields.description !== "string" ||
    Array.from(fields.description).length > 4000 ||
    (fields.team_id !== null &&
      (typeof fields.team_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.team_id)))
  )
    throw new BadRequestException("Invalid application name, description or team");
  return { name: fields.name.trim(), description: fields.description, team_id: fields.team_id };
}
