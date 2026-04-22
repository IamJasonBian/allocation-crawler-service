/**
 * Company CRUD against an in-memory Redis (ioredis-mock) — no network.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import Redis from "ioredis-mock";

import type { Company } from "../src/lib/types.ts";
import {
  getCompany,
  listCompanies,
  removeCompany,
  upsertCompany,
} from "../src/lib/entities.ts";

describe("companies (Redis entities)", { concurrency: false }, () => {
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

  it("upserts and fetches by id", async () => {
    const a = await upsertCompany(r, "acme", "acme", "Acme Co", "acme");
    assert.equal(a.id, "acme");
    assert.equal(a.marketing_slug, "acme");
    assert.equal(a.name, "Acme Co");
    assert.equal(a.board_id, "acme");
    const b = await getCompany(r, "acme");
    assert(b);
    assert.equal((b as Company).marketing_slug, "acme");
  });

  it("updates marketing_slug and preserves created_at on upsert", async () => {
    const first = await upsertCompany(r, "p2", "old-slug", "P2", "");
    const second = await upsertCompany(r, "p2", "new-slug", "P2", "");
    assert.equal(first.created_at, second.created_at);
    assert.equal(second.marketing_slug, "new-slug");
  });

  it("listCompanies returns all rows", async () => {
    await upsertCompany(r, "a", "a", "A", "");
    await upsertCompany(r, "b", "b", "B", "");
    const list = await listCompanies(r);
    const ids = new Set(list.map((c) => c.id));
    assert.ok(ids.has("a"));
    assert.ok(ids.has("b"));
  });

  it("removeCompany deletes the record", async () => {
    await upsertCompany(r, "z", "z", "Z", "");
    const ok = await removeCompany(r, "z");
    assert.equal(ok, true);
    const g = await getCompany(r, "z");
    assert.equal(g, null);
  });
});
