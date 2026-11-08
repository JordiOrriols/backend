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

export interface ChecklistItem {
  category: string;
  title: string;
  description: string;
  mandatory: boolean;
}
export interface ChecklistInput {
  revision: number;
  items: ChecklistItem[];
}
export function checklistInput(body: unknown): ChecklistInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Checklist template is required");
  const fields = Object.fromEntries(Object.entries(body));
  if (
    typeof fields.revision !== "number" ||
    !Number.isSafeInteger(fields.revision) ||
    fields.revision < 0 ||
    fields.revision >= 2147483647 ||
    !Array.isArray(fields.items) ||
    fields.items.length > 100
  )
    throw new BadRequestException("Invalid checklist revision or items");
  const items = fields.items.map((value: unknown): ChecklistItem => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new BadRequestException("Invalid checklist item");
    const item = Object.fromEntries(Object.entries(value));
    if (
      typeof item.category !== "string" ||
      !item.category.trim() ||
      Array.from(item.category.trim()).length > 80 ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      Array.from(item.title.trim()).length > 160 ||
      typeof item.description !== "string" ||
      Array.from(item.description).length > 4000 ||
      typeof item.mandatory !== "boolean"
    )
      throw new BadRequestException("Invalid checklist item");
    return {
      category: item.category.trim(),
      title: item.title.trim(),
      description: item.description,
      mandatory: item.mandatory,
    };
  });
  return { revision: fields.revision, items };
}
export function checklistCompletionInput(body: unknown): boolean {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("completed" in body) ||
    typeof body.completed !== "boolean"
  )
    throw new BadRequestException("Checklist completion state is required");
  return body.completed;
}
