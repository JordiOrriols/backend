import { BadRequestException } from "@nestjs/common";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PriorityInput {
  featureIds: string[];
  expectedRevision: string;
}
export interface ProposalInput extends PriorityInput {
  name: string;
}

export function priorityInput(body: unknown): PriorityInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Priority order and revision are required");
  if (
    !("featureIds" in body) ||
    !Array.isArray(body.featureIds) ||
    !body.featureIds.every(
      (id: unknown): id is string => typeof id === "string" && uuid.test(id)
    ) ||
    new Set(body.featureIds).size !== body.featureIds.length ||
    !("expectedRevision" in body) ||
    typeof body.expectedRevision !== "string" ||
    !/^[a-f0-9]{32}$/.test(body.expectedRevision)
  )
    throw new BadRequestException("Invalid priority order or revision");
  return { featureIds: body.featureIds, expectedRevision: body.expectedRevision };
}

export function proposalInput(body: unknown): ProposalInput {
  const priority = priorityInput(body);
  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string")
    throw new BadRequestException("Proposal name is required");
  const name = body.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 120)
    throw new BadRequestException("Proposal names need between 1 and 120 characters");
  return { ...priority, name };
}

export function markerNameInput(body: unknown): string {
  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string")
    throw new BadRequestException("Marker name is required");
  const name = body.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 80)
    throw new BadRequestException("Marker names need between 1 and 80 characters");
  return name;
}

export function markerInput(body: unknown): { name: string; date: string } {
  const name = markerNameInput(body);
  if (
    !body ||
    typeof body !== "object" ||
    !("date" in body) ||
    typeof body.date !== "string" ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(body.date)
  )
    throw new BadRequestException("A valid marker date is required");
  const parsed = new Date(`${body.date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== body.date)
    throw new BadRequestException("A valid marker date is required");
  return { name, date: body.date };
}
