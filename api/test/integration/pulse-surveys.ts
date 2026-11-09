import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PlatformDatabase } from "../../src/database.js";
import { surveyInput } from "../../src/pulse-input.js";
import {
  localPermissionConnection,
  runPermissionCommand,
} from "../../scripts/local-permissions.js";

const adminURL = localPermissionConnection({
  DATABASE_URL: process.env.DATABASE_URL,
  LOCAL_PERMISSIONS_CONFIRM: "local-only",
});
const apiURL = process.env.API_DATABASE_URL;
if (!apiURL || new URL(apiURL).hostname !== "db")
  throw new Error("Isolated Docker database required");

test("Pulse surveys enforce grant scope, anonymous threshold aggregates and one-time verified participation", async () => {
  const admin = new Client({ connectionString: adminURL });
  const restricted = new Client({ connectionString: apiURL });
  const api = new PlatformDatabase(apiURL);
  await Promise.all([admin.connect(), restricted.connect()]);
  const identity = {
    issuer: "https://pulse-surveys.invalid",
    subject: randomUUID(),
    email: "same@example.invalid",
  };
  const owner = await api.account(identity);
  const viewer = await api.account({ ...identity, subject: randomUUID() });
  const editor = await api.account({ ...identity, subject: randomUUID() });
  const stranger = await api.account({ ...identity, subject: randomUUID() });
  const accounts = [owner.id, viewer.id, editor.id, stranger.id];
  const workspaces: string[] = [];
  const legacy = randomUUID();
  type SurveyRow = { id: string; answered: boolean; pulse_questions: { id: string }[] };
  type Result = {
    survey_id: string;
    responses: number;
    participants: number;
    visible: boolean;
    distribution: Record<string, number[]>;
    comments: string[];
  };
  const content = surveyInput({
    title: "  Anonymous team health  ",
    asks_comment: true,
    min_responses: 3,
    questions: [{ key: "health" }, { prompt: "Clarity?", low_label: "Low", high_label: "High" }],
  });
  try {
    const workspace = (await api.createWorkspace(owner.id, "Pulse survey integration")) as {
      id: string;
    };
    const other = (await api.createWorkspace(owner.id, "Other survey workspace")) as { id: string };
    workspaces.push(workspace.id, other.id);
    await admin.query(
      "INSERT INTO platform.grants(user_id,workspace_id,app,role) VALUES($1,$3,'pulse','viewer'),($2,$3,'pulse','editor')",
      [viewer.id, editor.id, workspace.id]
    );
    await admin.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [legacy, identity.email]);
    await runPermissionCommand(admin, ["map-legacy", editor.id, legacy]);
    assert.deepEqual(await api.pulseSurveys(owner.id, workspace.id), []);
    assert.deepEqual(await api.pulseSurveyResults(viewer.id, workspace.id), []);
    await assert.rejects(api.pulseSurveys(stranger.id, workspace.id), /access required/);
    await assert.rejects(api.pulseSurveyResults(stranger.id, workspace.id), /access required/);
    await assert.rejects(
      api.pulseCreateSurvey(viewer.id, workspace.id, content),
      /access required/
    );
    const saved = (await api.pulseCreateSurvey(editor.id, workspace.id, content)) as { id: string };
    const [survey] = (await api.pulseSurveys(viewer.id, workspace.id)) as SurveyRow[];
    assert.equal(survey!.id, saved.id);
    assert.equal(survey!.answered, false);
    assert.equal(survey!.pulse_questions.length, 2);
    assert.equal(JSON.stringify(survey).includes(editor.id), false);
    const ratings = Object.fromEntries(survey!.pulse_questions.map((question) => [question.id, 4]));
    await assert.rejects(
      api.pulseSubmitResponse(owner.id, other.id, saved.id, ratings, ""),
      /unavailable/
    );
    await assert.rejects(
      api.pulseManageSurvey(owner.id, other.id, saved.id, "delete"),
      /unavailable/
    );
    await assert.rejects(
      api.pulseManageSurvey(viewer.id, workspace.id, saved.id, "closed"),
      /access required/
    );
    for (const invalid of [
      {},
      { ...ratings, [randomUUID()]: 3 },
      { ...ratings, [survey!.pulse_questions[0]!.id]: 6 },
      { ...ratings, [survey!.pulse_questions[0]!.id]: "4" },
    ]) {
      await assert.rejects(
        api.pulseSubmitResponse(owner.id, workspace.id, saved.id, invalid, ""),
        /Rate every question/
      );
    }
    await assert.rejects(
      api.pulseSubmitResponse(stranger.id, workspace.id, saved.id, ratings, ""),
      /access required/
    );
    const raced = await Promise.allSettled([
      api.pulseSubmitResponse(viewer.id, workspace.id, saved.id, ratings, "Viewer comment"),
      api.pulseSubmitResponse(viewer.id, workspace.id, saved.id, ratings, "Duplicate"),
    ]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = raced.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected" && /already answered/.test(String(rejected.reason)));
    await api.pulseSubmitResponse(owner.id, workspace.id, saved.id, ratings, "Owner comment");
    const result = async () =>
      ((await api.pulseSurveyResults(viewer.id, workspace.id)) as Result[])[0]!;
    assert.deepEqual(await result(), {
      survey_id: saved.id,
      responses: 2,
      participants: 3,
      visible: false,
      distribution: {},
      comments: [],
    });
    await api.pulseManageSurvey(editor.id, workspace.id, saved.id, "closed");
    assert.equal((await result()).visible, false);
    assert.deepEqual((await result()).comments, []);
    await assert.rejects(
      api.pulseSubmitResponse(editor.id, workspace.id, saved.id, ratings, ""),
      /closed/
    );
    await api.pulseManageSurvey(owner.id, workspace.id, saved.id, "open");
    await api.pulseSubmitResponse(editor.id, workspace.id, saved.id, ratings, "  Editor comment  ");
    assert.equal((await result()).visible, false);
    await api.pulseManageSurvey(owner.id, workspace.id, saved.id, "closed");
    const visible = await result();
    assert.equal(visible.visible, true);
    assert.equal(visible.responses, 3);
    assert.deepEqual(Object.values(visible.distribution), [
      [0, 0, 0, 3, 0],
      [0, 0, 0, 3, 0],
    ]);
    assert.equal(visible.comments.length, 3);
    assert.ok(visible.comments.includes("Editor comment"));
    assert.equal(JSON.stringify(visible).includes(editor.id), false);
    for (const table of ["pulse_responses", "pulse_answers", "pulse_comments"]) {
      await assert.rejects(restricted.query(`SELECT * FROM public.${table}`), /permission denied/);
    }
    await assert.rejects(
      restricted.query("SELECT * FROM platform.pulse_participations"),
      /permission denied/
    );
    await assert.rejects(
      restricted.query("SELECT platform.pulse_require_access($1,$2,false)", [
        viewer.id,
        workspace.id,
      ]),
      /permission denied/
    );
    const responseColumns = (
      await admin.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pulse_responses' ORDER BY ordinal_position"
      )
    ).rows.map((row) => row.column_name);
    assert.deepEqual(responseColumns, ["id", "survey_id"]);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM public.pulse_participations WHERE survey_id=$1 AND user_id=$2",
          [saved.id, legacy]
        )
      ).rows[0].n,
      1
    );
    const prior = (await api.pulseCreateSurvey(owner.id, workspace.id, {
      ...content,
      asks_comment: false,
    })) as { id: string };
    await admin.query("INSERT INTO public.pulse_participations(survey_id,user_id) VALUES($1,$2)", [
      prior.id,
      legacy,
    ]);
    assert.equal(
      ((await api.pulseSurveys(editor.id, workspace.id)) as SurveyRow[]).find(
        (row) => row.id === prior.id
      )!.answered,
      true
    );
    assert.equal(
      ((await api.pulseSurveys(viewer.id, workspace.id)) as SurveyRow[]).find(
        (row) => row.id === prior.id
      )!.answered,
      false
    );
    const [priorSurvey] = ((await api.pulseSurveys(editor.id, workspace.id)) as SurveyRow[]).filter(
      (row) => row.id === prior.id
    );
    const priorRatings = Object.fromEntries(
      priorSurvey!.pulse_questions.map((question) => [question.id, 1])
    );
    await assert.rejects(
      api.pulseSubmitResponse(editor.id, workspace.id, prior.id, priorRatings, ""),
      /already answered/
    );
    await api.pulseSubmitResponse(
      viewer.id,
      workspace.id,
      prior.id,
      priorRatings,
      "Ignored optional comment"
    );
    assert.equal(
      (
        await admin.query("SELECT count(*)::int n FROM public.pulse_comments WHERE survey_id=$1", [
          prior.id,
        ])
      ).rows[0].n,
      0
    );
    await admin.query(
      "DELETE FROM platform.grants WHERE user_id=$1 AND workspace_id=$2 AND app='pulse'",
      [viewer.id, workspace.id]
    );
    await assert.rejects(api.pulseSurveys(viewer.id, workspace.id), /access required/);
    await assert.rejects(api.pulseSurveyResults(viewer.id, workspace.id), /access required/);
    await api.pulseManageSurvey(owner.id, workspace.id, saved.id, "delete");
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM platform.pulse_participations WHERE survey_id=$1",
          [saved.id]
        )
      ).rows[0].n,
      0
    );
  } finally {
    try {
      await admin.query("DELETE FROM public.pulse_surveys WHERE workspace_id=ANY($1::uuid[])", [
        workspaces,
      ]);
      await admin.query("DELETE FROM platform.grants WHERE workspace_id=ANY($1::uuid[])", [
        workspaces,
      ]);
      await admin.query("DELETE FROM public.workspaces WHERE id=ANY($1::uuid[])", [workspaces]);
      await admin.query("DELETE FROM platform.identities WHERE user_id=ANY($1::uuid[])", [
        accounts,
      ]);
      await admin.query("DELETE FROM platform.users WHERE id=ANY($1::uuid[])", [accounts]);
      await admin.query("DELETE FROM auth.users WHERE id=$1", [legacy]);
    } finally {
      await Promise.all([admin.end(), restricted.end(), api.pool.end()]);
    }
  }
});
