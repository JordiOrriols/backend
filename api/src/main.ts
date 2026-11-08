import "reflect-metadata";
import {
  Controller,
  BadRequestException,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AccessVerifier } from "./access.js";
import { APPLICATIONS, PlatformDatabase } from "./database.js";
import { buildPublicRoadmap } from "./scheduler.mjs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const verifier = new AccessVerifier(required("ACCESS_ISSUER"), required("ACCESS_AUDIENCE"));
const database = new PlatformDatabase(required("DATABASE_URL"));

@Controller("api")
class PlatformController {
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
      if (error instanceof Error && "code" in error && error.code === "42501")
        throw new ForbiddenException("Workspace access required");
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
