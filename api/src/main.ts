import "reflect-metadata";
import {
  Controller,
  Body,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
  Get,
  Headers,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Delete,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AccessVerifier } from "./access.js";
import { APPLICATIONS, PlatformDatabase } from "./database.js";
import { buildPublicRoadmap, hasHolidayCalendar, validateSprintSettings } from "./scheduler.mjs";
import { applicationInput } from "./shiplog-input.js";
import {
  priorityInput,
  proposalInput,
  markerInput,
  markerNameInput,
  projectNameInput,
  featureInput,
  inclusionInput,
  dateInput,
  vacationInput,
  calibrationInput,
  teamNameInput,
  planningRoleInput,
} from "./planner-input.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const verifier = new AccessVerifier(required("ACCESS_ISSUER"), required("ACCESS_AUDIENCE"));
const database = new PlatformDatabase(required("DATABASE_URL"));

@Controller("api")
class PlatformController {
  @Get("shiplog/workspaces/:workspace/applications")
  async applications(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.shiplogApplications(id, workspace));
  }
  @Post("shiplog/workspaces/:workspace/applications")
  async createApplication(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogSaveApplication(id, workspace, applicationInput(body), null)
    );
  }
  @Patch("shiplog/workspaces/:workspace/applications/:application")
  async updateApplication(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("application", new ParseUUIDPipe()) application: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogSaveApplication(id, workspace, applicationInput(body), application)
    );
  }
  @Delete("shiplog/workspaces/:workspace/applications/:application")
  async deleteApplication(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("application", new ParseUUIDPipe()) application: string
  ) {
    return this.execute(token, (id) =>
      database.shiplogDeleteApplication(id, workspace, application)
    );
  }
  @Post("planner/workspaces/:workspace/teams")
  async createTeam(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerCreateTeam(id, workspace, teamNameInput(body))
    );
  }

  @Patch("planner/workspaces/:workspace/members/:member/planning-role")
  async planningRole(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerPlanningRole(id, workspace, member, planningRoleInput(body))
    );
  }

  @Get("planner/workspaces/:workspace/calendar")
  async calendar(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.plannerCalendar(id, workspace));
  }

  @Post("planner/workspaces/:workspace/members/:member/vacations")
  async vacations(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) => {
      const input = vacationInput(body);
      if (!hasHolidayCalendar(input.start) || !hasHolidayCalendar(input.end))
        throw new BadRequestException("Vacations require verified working calendar dates");
      return database.plannerVacations(id, workspace, member, input);
    });
  }

  @Patch("planner/workspaces/:workspace/calibration")
  async calibration(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) => {
      const input = calibrationInput(body);
      try {
        validateSprintSettings(input.anchor, input.history);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new BadRequestException(error.message);
      }
      return database.plannerCalibration(id, workspace, input);
    });
  }

  @Patch("planner/workspaces/:workspace/features/:feature/inclusion")
  async inclusion(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("feature", new ParseUUIDPipe()) feature: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerToggleBacklog(id, workspace, feature, inclusionInput(body))
    );
  }

  @Patch("planner/workspaces/:workspace/start-date")
  async startDate(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, async (id) => {
      const date = dateInput(body);
      if (!hasHolidayCalendar(date))
        throw new BadRequestException("Plan start requires a verified working calendar year");
      return buildPublicRoadmap(await database.plannerStartDate(id, workspace, date));
    });
  }

  @Get("planner/workspaces/:workspace/features")
  async features(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.plannerFeatures(id, workspace));
  }

  @Post("planner/workspaces/:workspace/features")
  async createFeature(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerFeature(id, workspace, "create", null, featureInput(body))
    );
  }

  @Patch("planner/workspaces/:workspace/features/:feature")
  async saveFeature(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("feature", new ParseUUIDPipe()) feature: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerFeature(id, workspace, "save", feature, featureInput(body))
    );
  }

  @Delete("planner/workspaces/:workspace/features/:feature")
  async deleteFeature(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("feature", new ParseUUIDPipe()) feature: string
  ) {
    return this.execute(token, (id) =>
      database.plannerFeature(id, workspace, "delete", feature, null)
    );
  }

  @Get("planner/workspaces/:workspace/projects")
  async projects(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.plannerProjects(id, workspace));
  }

  @Post("planner/workspaces/:workspace/projects")
  async createProject(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerProject(id, workspace, "create", null, projectNameInput(body))
    );
  }

  @Patch("planner/workspaces/:workspace/projects/:project")
  async renameProject(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("project", new ParseUUIDPipe()) project: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerProject(id, workspace, "rename", project, projectNameInput(body))
    );
  }

  @Delete("planner/workspaces/:workspace/projects/:project")
  async deleteProject(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("project", new ParseUUIDPipe()) project: string
  ) {
    return this.execute(token, (id) =>
      database.plannerProject(id, workspace, "delete", project, null)
    );
  }

  @Post("planner/workspaces/:workspace/priorities")
  async applyPriorities(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, async (id) =>
      buildPublicRoadmap(await database.plannerApplyPriorities(id, workspace, priorityInput(body)))
    );
  }

  @Get("planner/workspaces/:workspace/markers")
  async markers(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.plannerMarkers(id, workspace));
  }

  @Post("planner/workspaces/:workspace/markers")
  async createMarker(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) => {
      const input = markerInput(body);
      return database.plannerMarker(id, workspace, "create", null, input.name, input.date);
    });
  }

  @Patch("planner/workspaces/:workspace/markers/:marker")
  async renameMarker(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("marker", new ParseUUIDPipe()) marker: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.plannerMarker(id, workspace, "rename", marker, markerNameInput(body), null)
    );
  }

  @Delete("planner/workspaces/:workspace/markers/:marker")
  async deleteMarker(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("marker", new ParseUUIDPipe()) marker: string
  ) {
    return this.execute(token, (id) =>
      database.plannerMarker(id, workspace, "delete", marker, null, null)
    );
  }
  @Post("planner/workspaces/:workspace/preview")
  async preview(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, async (id) =>
      buildPublicRoadmap(await database.plannerPreview(id, workspace, priorityInput(body)))
    );
  }

  @Get("planner/workspaces/:workspace/proposals")
  async proposals(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.plannerProposals(id, workspace));
  }

  @Get("planner/workspaces/:workspace/proposals/:proposal")
  async savedProposal(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("proposal", new ParseUUIDPipe()) proposal: string
  ) {
    return this.execute(token, async (id) =>
      buildPublicRoadmap(await database.plannerSavedProposal(id, workspace, proposal))
    );
  }

  @Post("planner/workspaces/:workspace/proposals")
  async saveProposal(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, async (id) => ({
      id: await database.plannerSaveProposal(id, workspace, proposalInput(body)),
    }));
  }

  @Get("planner/workspaces/:workspace/roadmap")
  async roadmap(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, async (id) =>
      buildPublicRoadmap(await database.plannerSource(id, workspace))
    );
  }

  private async execute<T>(token: string | undefined, operation: (id: string) => Promise<T>) {
    const identity = await verifier.verify(token);
    try {
      const account = await database.account(identity);
      return await operation(account.id);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof Error && "code" in error && error.code === "42501")
        throw new ForbiddenException("Workspace access required");
      if (error instanceof Error && "code" in error && error.code === "23514")
        throw new ConflictException(error.message);
      if (error instanceof Error && "code" in error && error.code === "22023")
        throw new BadRequestException(error.message);
      if (error instanceof Error && "code" in error && error.code === "P0002")
        throw new NotFoundException(error.message);
      Logger.error("Platform operation failed", error, "PlatformAPI");
      throw new ServiceUnavailableException("Platform service unavailable");
    }
  }

  @Get("apps/:app/workspaces")
  async workspaces(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("app") app: string
  ) {
    const application = APPLICATIONS.find((candidate) => candidate === app);
    if (!application) throw new BadRequestException("Unknown application");
    return this.execute(token, (id) => database.workspaces(id, application));
  }

  @Get("shiplog/workspaces/:workspace/catalog")
  async catalog(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.shiplogCatalog(id, workspace));
  }

  @Get("me")
  async me(@Headers("cf-access-jwt-assertion") token: string | undefined) {
    const identity = await verifier.verify(token);
    try {
      return await database.account(identity);
    } catch (error) {
      Logger.error("Platform account operation failed", error, "PlatformAPI");
      throw new ServiceUnavailableException("Account service unavailable");
    }
  }
}

@Module({ controllers: [PlatformController] })
class PlatformModule {}

const app = await NestFactory.create(PlatformModule);
app.use(
  (
    _request: unknown,
    response: { setHeader(name: string, value: string): void },
    next: () => void
  ) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  }
);
app.enableShutdownHooks();
await app.listen(3000, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void database.pool.end());
