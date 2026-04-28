/**
 * InterviewStage CRUD against in-memory Redis (ioredis-mock).
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Redis from "ioredis-mock";

import {
  createInterviewStage,
  getInterviewStage,
  listInterviewStages,
  removeInterviewStage,
  updateInterviewStage,
} from "../src/lib/entities.ts";

describe("interview stages (Redis entities)", { concurrency: false }, () => {
  let r: Redis;

  before(() => {
    r = new Redis() as unknown as Redis;
  });

  beforeEach(async () => {
    await r.flushall();
  });

  after(async () => {
    await r.quit();
  });

  it("creates a stage with default Applied status", async () => {
    const result = await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1" });
    assert("stage" in result);
    assert.equal(result.stage.status, "Applied");
    assert.equal(result.stage.id, "u1:stripe:j1");
    assert.equal(result.stage.notes, "");
  });

  it("rejects duplicate creation with 409", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1" });
    const dup = await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1" });
    assert("error" in dup);
    assert.equal(dup.code, 409);
  });

  it("PATCH advances status and rebalances status index", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1" });
    const screening = await updateInterviewStage(r, "u1", "stripe", "j1", { status: "Screening" });
    assert(screening);
    assert.equal(screening.status, "Screening");

    const onlyApplied = await listInterviewStages(r, { status: "Applied" });
    assert.equal(onlyApplied.length, 0);
    const onlyScreening = await listInterviewStages(r, { status: "Screening" });
    assert.equal(onlyScreening.length, 1);
  });

  it("PATCH updates notes without changing status", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1", status: "FinalRound" });
    const updated = await updateInterviewStage(r, "u1", "stripe", "j1", { notes: "onsite scheduled 2026-05-01" });
    assert(updated);
    assert.equal(updated.status, "FinalRound");
    assert.equal(updated.notes, "onsite scheduled 2026-05-01");
  });

  it("PATCH on missing row returns null", async () => {
    const updated = await updateInterviewStage(r, "ghost", "x", "y", { status: "Offer" });
    assert.equal(updated, null);
  });

  it("filters by user_id, status, and board", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1", status: "Applied" });
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j2", status: "Offer" });
    await createInterviewStage(r, { user_id: "u2", board: "stripe", job_id: "j3", status: "Applied" });
    await createInterviewStage(r, { user_id: "u1", board: "lever", job_id: "j4", status: "Applied" });

    const u1All = await listInterviewStages(r, { user_id: "u1" });
    assert.equal(u1All.length, 3);

    const u1Applied = await listInterviewStages(r, { user_id: "u1", status: "Applied" });
    assert.equal(u1Applied.length, 2);

    const u1AppliedStripe = await listInterviewStages(r, { user_id: "u1", status: "Applied", board: "stripe" });
    assert.equal(u1AppliedStripe.length, 1);
    assert.equal(u1AppliedStripe[0].job_id, "j1");
  });

  it("DELETE clears all indexes", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1", status: "Screening" });
    const removed = await removeInterviewStage(r, "u1", "stripe", "j1");
    assert.equal(removed, true);

    assert.equal(await getInterviewStage(r, "u1", "stripe", "j1"), null);
    assert.equal((await listInterviewStages(r, { status: "Screening" })).length, 0);
    assert.equal((await listInterviewStages(r, { user_id: "u1" })).length, 0);
  });

  it("terminal Rejected/Withdrawn statuses can still be PATCHed (e.g. to add notes)", async () => {
    await createInterviewStage(r, { user_id: "u1", board: "stripe", job_id: "j1", status: "Rejected" });
    const annotated = await updateInterviewStage(r, "u1", "stripe", "j1", { notes: "ghosted after onsite" });
    assert(annotated);
    assert.equal(annotated.status, "Rejected");
    assert.equal(annotated.notes, "ghosted after onsite");
  });
});
