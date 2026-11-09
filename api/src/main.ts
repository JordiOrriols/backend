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
  Query,
  ParseUUIDPipe,
  Post,
  Patch,
  Delete,
  ServiceUnavailableException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AccessVerifier } from "./access.js";
import { APPLICATIONS, PlatformDatabase } from "./database.js";
import {
  memberProfileInput,
  commentVisibilityInput,
  evaluationContentInput,
  evaluationStatusInput,
  goalCommentInput,
  goalProgressInput,
  smartGoalInput,
} from "./ladders-input.js";
import { buildPublicRoadmap, hasHolidayCalendar, validateSprintSettings } from "./scheduler.mjs";
import {
  applicationInput,
  releaseInput,
  checklistInput,
  checklistCompletionInput,
  approvalInput,
  auditCursorInput,
} from "./shiplog-input.js";
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
  @Get("ladders/me/members/:member/goals")
  async laddersMyGoals(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersMyGoals(id, member));
  }
  @Patch("ladders/me/members/:member/goals/:goal/progress")
  async laddersMyGoalProgress(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("goal", new ParseUUIDPipe()) goal: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersUpdateMyGoal(id, member, goal, goalProgressInput(body), null)
    );
  }
  @Post("ladders/me/members/:member/goals/:goal/comments")
  async laddersMyGoalComment(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("goal", new ParseUUIDPipe()) goal: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersUpdateMyGoal(id, member, goal, null, goalCommentInput(body))
    );
  }
  @Get("ladders/me/members/:member/self-evaluations")
  async laddersMySelfEvaluations(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersMySelfEvaluations(id, member));
  }
  @Post("ladders/me/members/:member/self-evaluations")
  async laddersCreateMyEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveMyEvaluation(id, member, null, evaluationContentInput(body))
    );
  }
  @Patch("ladders/me/members/:member/self-evaluations/:evaluation")
  async laddersUpdateMyEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveMyEvaluation(id, member, evaluation, evaluationContentInput(body))
    );
  }
  @Post("ladders/me/members/:member/self-evaluations/:evaluation/publish")
  async laddersPublishMyEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string
  ) {
    return this.execute(token, (id) => database.laddersPublishMyEvaluation(id, member, evaluation));
  }
  @Get("ladders/me/members")
  async laddersMyMembers(@Headers("cf-access-jwt-assertion") token: string | undefined) {
    return this.execute(token, (id) => database.laddersMyMembers(id));
  }
  @Get("ladders/me/members/:member/evaluations")
  async laddersMyEvaluations(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersMyEvaluations(id, member));
  }
  @Get("ladders/workspaces/:workspace/members/:member/goals")
  async laddersGoals(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersGoals(id, workspace, member));
  }
  @Post("ladders/workspaces/:workspace/members/:member/goals")
  async laddersCreateGoal(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveGoal(id, workspace, member, null, smartGoalInput(body))
    );
  }
  @Patch("ladders/workspaces/:workspace/members/:member/goals/:goal")
  async laddersUpdateGoal(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("goal", new ParseUUIDPipe()) goal: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveGoal(id, workspace, member, goal, smartGoalInput(body))
    );
  }
  @Post("ladders/workspaces/:workspace/members/:member/goals/:goal/comments")
  async laddersAppendGoalComment(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("goal", new ParseUUIDPipe()) goal: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersAppendGoalComment(id, workspace, member, goal, goalCommentInput(body))
    );
  }
  @Delete("ladders/workspaces/:workspace/members/:member/goals/:goal")
  async laddersDeleteGoal(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("goal", new ParseUUIDPipe()) goal: string
  ) {
    return this.execute(token, (id) => database.laddersDeleteGoal(id, workspace, member, goal));
  }
  @Post("ladders/workspaces/:workspace/members/:member/evaluations")
  async laddersCreateEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveEvaluation(id, workspace, member, null, evaluationContentInput(body))
    );
  }
  @Patch("ladders/workspaces/:workspace/members/:member/evaluations/:evaluation")
  async laddersSaveEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveEvaluation(
        id,
        workspace,
        member,
        evaluation,
        evaluationContentInput(body)
      )
    );
  }
  @Patch("ladders/workspaces/:workspace/members/:member/evaluations/:evaluation/status")
  async laddersEvaluationStatus(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersEvaluationStatus(
        id,
        workspace,
        member,
        evaluation,
        evaluationStatusInput(body)
      )
    );
  }
  @Delete("ladders/workspaces/:workspace/members/:member/evaluations/:evaluation")
  async laddersDeleteEvaluation(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string
  ) {
    return this.execute(token, (id) =>
      database.laddersDeleteEvaluation(id, workspace, member, evaluation)
    );
  }
  @Patch("ladders/workspaces/:workspace/members/:member/evaluations/:evaluation/comments/:category")
  async laddersCommentVisibility(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("evaluation", new ParseUUIDPipe()) evaluation: string,
    @Param("category") category: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersCommentVisibility(
        id,
        workspace,
        member,
        evaluation,
        category,
        commentVisibilityInput(body)
      )
    );
  }
  @Get("ladders/workspaces/:workspace/members/:member/evaluations")
  async laddersEvaluations(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersEvaluations(id, workspace, member));
  }
  @Patch("ladders/workspaces/:workspace/members/:member/teams/:team")
  async laddersMoveMember(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Param("team", new ParseUUIDPipe()) team: string
  ) {
    return this.execute(token, (id) => database.laddersMoveMember(id, workspace, member, team));
  }
  @Post("ladders/workspaces/:workspace/teams/:team/members")
  async laddersCreateMember(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("team", new ParseUUIDPipe()) team: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersCreateMember(id, workspace, team, memberProfileInput(body))
    );
  }
  @Delete("ladders/workspaces/:workspace/members/:member")
  async laddersDeleteMember(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string
  ) {
    return this.execute(token, (id) => database.laddersDeleteMember(id, workspace, member));
  }
  @Delete("ladders/workspaces/:workspace/teams/:team")
  async laddersDeleteTeam(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("team", new ParseUUIDPipe()) team: string
  ) {
    return this.execute(token, (id) => database.laddersDeleteTeam(id, workspace, team));
  }
  @Patch("ladders/workspaces/:workspace/members/:member")
  async laddersSaveProfile(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("member", new ParseUUIDPipe()) member: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveProfile(id, workspace, member, memberProfileInput(body))
    );
  }
  @Get("ladders/workspaces/:workspace/teams")
  async laddersTeams(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.laddersTeams(id, workspace));
  }
  @Post("ladders/workspaces/:workspace/teams")
  async laddersCreateTeam(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveTeam(id, workspace, teamNameInput(body), null)
    );
  }
  @Patch("ladders/workspaces/:workspace/teams/:team")
  async laddersRenameTeam(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("team", new ParseUUIDPipe()) team: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.laddersSaveTeam(id, workspace, teamNameInput(body), team)
    );
  }
  @Get("shiplog/workspaces/:workspace/audit")
  async audit(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Query("cursor") cursor: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogAudit(id, workspace, auditCursorInput(cursor))
    );
  }
  @Get("shiplog/workspaces/:workspace/releases/:release/decisions")
  async decisions(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string
  ) {
    return this.execute(token, (id) => database.shiplogDecisions(id, workspace, release));
  }
  @Patch("shiplog/workspaces/:workspace/releases/:release/decision")
  async decideRelease(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogDecideRelease(id, workspace, release, approvalInput(body))
    );
  }
  @Get("shiplog/workspaces/:workspace/applications/:application/checklist-template")
  async checklistTemplate(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("application", new ParseUUIDPipe()) application: string
  ) {
    return this.execute(token, (id) =>
      database.shiplogChecklistTemplate(id, workspace, application)
    );
  }
  @Patch("shiplog/workspaces/:workspace/applications/:application/checklist-template")
  async saveChecklistTemplate(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("application", new ParseUUIDPipe()) application: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogSaveChecklistTemplate(id, workspace, application, checklistInput(body))
    );
  }
  @Get("shiplog/workspaces/:workspace/releases/:release/readiness")
  async readiness(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string
  ) {
    return this.execute(token, (id) => database.shiplogReadiness(id, workspace, release));
  }
  @Patch("shiplog/workspaces/:workspace/releases/:release/checklist/:item")
  async completeChecklistItem(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string,
    @Param("item", new ParseUUIDPipe()) item: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogCompleteChecklistItem(
        id,
        workspace,
        release,
        item,
        checklistCompletionInput(body)
      )
    );
  }
  @Get("shiplog/workspaces/:workspace/features")
  async shiplogFeatures(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string
  ) {
    return this.execute(token, (id) => database.shiplogWorkspaceFeatures(id, workspace));
  }
  @Get("shiplog/workspaces/:workspace/releases/:release/features")
  async releaseFeatures(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string
  ) {
    return this.execute(token, (id) => database.shiplogReleaseFeatures(id, workspace, release));
  }
  @Post("shiplog/workspaces/:workspace/releases")
  async createRelease(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogSaveRelease(id, workspace, releaseInput(body), null)
    );
  }
  @Patch("shiplog/workspaces/:workspace/releases/:release")
  async updateRelease(
    @Headers("cf-access-jwt-assertion") token: string | undefined,
    @Param("workspace", new ParseUUIDPipe()) workspace: string,
    @Param("release", new ParseUUIDPipe()) release: string,
    @Body() body: unknown
  ) {
    return this.execute(token, (id) =>
      database.shiplogSaveRelease(id, workspace, releaseInput(body), release)
    );
  }
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
