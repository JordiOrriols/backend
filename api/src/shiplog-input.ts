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

export interface ReleaseInput {
  application_id: string;
  version: string;
  title: string;
  public_notes: string;
  status: "draft" | "qa" | "released";
  feature_ids: string[] | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export function releaseInput(body: unknown): ReleaseInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Release fields are required");
  const fields = Object.fromEntries(Object.entries(body));
  if (
    typeof fields.application_id !== "string" ||
    !uuid.test(fields.application_id) ||
    typeof fields.version !== "string" ||
    fields.version.length > 100 ||
    !versionPattern.test(fields.version) ||
    typeof fields.title !== "string" ||
    !fields.title.trim() ||
    Array.from(fields.title.trim()).length > 160 ||
    typeof fields.public_notes !== "string" ||
    Array.from(fields.public_notes).length > 20000 ||
    (fields.status !== "draft" && fields.status !== "qa" && fields.status !== "released") ||
    (fields.feature_ids !== null &&
      (!Array.isArray(fields.feature_ids) ||
        fields.feature_ids.some((id: unknown) => typeof id !== "string" || !uuid.test(id))))
  )
    throw new BadRequestException("Invalid release fields or Planner features");
  return {
    application_id: fields.application_id,
    version: fields.version,
    title: fields.title.trim(),
    public_notes: fields.public_notes,
    status: fields.status,
    feature_ids: fields.feature_ids,
  };
}
