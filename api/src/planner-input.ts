import { BadRequestException } from "@nestjs/common";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface PriorityInput {
  featureIds: string[];
  expectedRevision: string;
}
export interface ProposalInput extends PriorityInput {
  name: string;
}
export interface FeatureInput {
  name: string;
  description: string;
  project_id: string;
  status: "pending" | "in_progress" | "done" | "paused";
  dependency_ids: string[];
  backend_devs: number;
  backend_weeks: number;
  frontend_devs: number;
  frontend_weeks: number;
  design_devs: number;
  design_weeks: number;
  qa_devs: number;
  qa_weeks: number;
}
export interface VacationInput {
  start: string;
  end: string;
  working: boolean;
}
export interface CalibrationInput {
  anchor: string;
  history: { start_date: string; story_points: number }[];
}

export function vacationInput(body: unknown): VacationInput {
  if (
    !body ||
    typeof body !== "object" ||
    !("start" in body) ||
    !("end" in body) ||
    !("working" in body) ||
    typeof body.working !== "boolean"
  )
    throw new BadRequestException("Vacation range and working flag are required");
  const start = dateInput({ date: body.start }),
    end = dateInput({ date: body.end });
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (days < 0 || days > 365)
    throw new BadRequestException("Choose a date range of at most 366 days");
  return { start, end, working: body.working };
}

export function calibrationInput(body: unknown): CalibrationInput {
  if (
    !body ||
    typeof body !== "object" ||
    !("anchor" in body) ||
    !("history" in body) ||
    !Array.isArray(body.history)
  )
    throw new BadRequestException("Calibration anchor and history are required");
  const anchor = dateInput({ date: body.anchor });
  const history = body.history.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("start_date" in entry) ||
      !("story_points" in entry) ||
      typeof entry.story_points !== "number" ||
      !Number.isFinite(entry.story_points) ||
      entry.story_points < 0
    )
      throw new BadRequestException("Each sprint requires a date and finite nonnegative points");
    return { start_date: dateInput({ date: entry.start_date }), story_points: entry.story_points };
  });
  return { anchor, history };
}

export function featureInput(body: unknown): FeatureInput {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequestException("Feature fields are required");
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(body));
  if (
    typeof fields.name !== "string" ||
    !fields.name.trim() ||
    Array.from(fields.name.trim()).length > 120
  )
    throw new BadRequestException("Feature names need between 1 and 120 characters");
  if (typeof fields.description !== "string")
    throw new BadRequestException("Feature description must be text");
  if (typeof fields.project_id !== "string" || !uuid.test(fields.project_id))
    throw new BadRequestException("Feature project is required");
  const status = fields.status;
  if (status !== "pending" && status !== "in_progress" && status !== "done" && status !== "paused")
    throw new BadRequestException("Invalid feature status");
  const dependencies = fields.dependency_ids === undefined ? [] : fields.dependency_ids;
  if (
    !Array.isArray(dependencies) ||
    !dependencies.every((id: unknown): id is string => typeof id === "string" && uuid.test(id)) ||
    new Set(dependencies).size !== dependencies.length
  )
    throw new BadRequestException("Feature dependencies must be unique feature IDs");
  function estimate(role: string, unit: "devs" | "weeks") {
    const value = fields[`${role}_${unit}`];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > (unit === "devs" ? 100 : 104)
    )
      throw new BadRequestException(
        "Estimates require whole people from 0-100 and whole weeks from 0-104"
      );
    return value;
  }
  const estimates = {
    backend_devs: estimate("backend", "devs"),
    backend_weeks: estimate("backend", "weeks"),
    frontend_devs: estimate("frontend", "devs"),
    frontend_weeks: estimate("frontend", "weeks"),
    design_devs: estimate("design", "devs"),
    design_weeks: estimate("design", "weeks"),
    qa_devs: estimate("qa", "devs"),
    qa_weeks: estimate("qa", "weeks"),
  };
  for (const role of ["backend", "frontend", "design", "qa"] as const)
    if ((estimates[`${role}_devs`] === 0) !== (estimates[`${role}_weeks`] === 0))
      throw new BadRequestException("Each role needs both people and weeks, or neither");
  return {
    name: fields.name.trim(),
    description: fields.description,
    project_id: fields.project_id,
    status,
    dependency_ids: dependencies,
    ...estimates,
  };
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
  return namedInput(body, "Marker");
}

export function projectNameInput(body: unknown): string {
  return namedInput(body, "Project");
}

function namedInput(body: unknown, label: "Marker" | "Project"): string {
  if (!body || typeof body !== "object" || !("name" in body) || typeof body.name !== "string")
    throw new BadRequestException(`${label} name is required`);
  const name = body.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 80)
    throw new BadRequestException(`${label} names need between 1 and 80 characters`);
  return name;
}

export function markerInput(body: unknown): { name: string; date: string } {
  const name = markerNameInput(body);
  return { name, date: dateInput(body) };
}

export function inclusionInput(body: unknown): boolean {
  if (
    !body ||
    typeof body !== "object" ||
    !("included" in body) ||
    typeof body.included !== "boolean"
  )
    throw new BadRequestException("Roadmap inclusion must be a boolean");
  return body.included;
}

export function dateInput(body: unknown): string {
  if (
    !body ||
    typeof body !== "object" ||
    !("date" in body) ||
    typeof body.date !== "string" ||
    !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(body.date)
  )
    throw new BadRequestException("A valid calendar date is required");
  const parsed = new Date(`${body.date}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== body.date)
    throw new BadRequestException("A valid calendar date is required");
  return body.date;
}
