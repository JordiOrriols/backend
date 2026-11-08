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
import { buildPublicRoadmap } from "./scheduler.mjs";
import {
  priorityInput,
  proposalInput,
  markerInput,
  markerNameInput,
  projectNameInput,
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
