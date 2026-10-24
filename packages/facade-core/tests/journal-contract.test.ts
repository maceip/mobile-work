import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe } from "vitest";
import { runJournalStoreContract } from "@zcode/dynamic-workflow/testing";
import { openDatabase } from "../src/db.js";
import { SqliteJournalStore } from "../src/journal-sqlite.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("SqliteJournalStore upstream contract", () => {
  runJournalStoreContract(() => {
    const dir = mkdtempSync(join(tmpdir(), "zfacade-journal-"));
    dirs.push(dir);
    return new SqliteJournalStore(openDatabase(join(dir, "test.sqlite")));
  });
});
