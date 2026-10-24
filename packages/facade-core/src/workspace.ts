import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, sha256Hex, workspaceKeyOf, ZfacadeError } from "@zfacade/contracts";
import { openDatabase, tx } from "./db.js";
import { SqliteJournalStore } from "./journal-sqlite.js";
import { EffectService, type EffectHooks } from "./effects.js";
import { ArtifactRepo, CommandRepo, EpisodeRepo, QuestionRepo, SessionRepo } from "./repos.js";
import { canonicalRoot } from "./paths.js";

export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZFACADE_HOME && env.ZFACADE_HOME.length > 0 ? env.ZFACADE_HOME : join(homedir(), ".zfacade");
}

export interface WorkspaceStore {
  workspacePath: string;
  workspaceKey: string;
  dir: string;
  dbPath: string;
  db: DatabaseSync;
  journal: SqliteJournalStore;
  effects: EffectService;
  questions: QuestionRepo;
  commands: CommandRepo;
  sessions: SessionRepo;
  episodes: EpisodeRepo;
  artifacts: ArtifactRepo;
  ownerGeneration: number;
  ownerId: string;
  putArtifact(runId: string | undefined, kind: string, data: string | Uint8Array, contentType?: string): string;
  readArtifact(ref: string): Uint8Array;
  usage(): { dbBytes: number; artifactBytes: number; artifactCount: number };
  release(): void;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function openWorkspaceStore(workspacePath: string, opts?: { env?: NodeJS.ProcessEnv; effectHooks?: EffectHooks; readOnlyLock?: boolean }): WorkspaceStore {
  const canonical = canonicalRoot(workspacePath);
  const key = workspaceKeyOf(canonical);
  const root = stateRoot(opts?.env);
  const dir = join(root, "workspaces", key);
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  // Workspace index (paths only).
  const indexPath = join(root, "workspaces", "index.json");
  let index: Record<string, string> = {};
  try { index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>; } catch { index = {}; }
  index[key] = canonical;
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");

  const lockPath = join(dir, "coordinator.lock");
  let lockFd: number | undefined;
  if (!opts?.readOnlyLock) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lockFd = openSync(lockPath, "wx");
        writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        break;
      } catch {
        let holderPid = -1;
        try { holderPid = Number((JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid); } catch { holderPid = -1; }
        if (holderPid > 0 && holderPid !== process.pid && pidAlive(holderPid)) {
          throw new ZfacadeError("WorkspaceLocked", `workspace ${canonical} is owned by live pid ${holderPid}`);
        }
        if (attempt === 0) { rmSync(lockPath, { force: true }); continue; }
        throw new ZfacadeError("WorkspaceLocked", `could not acquire workspace lock for ${canonical}`);
      }
    }
  }

  const dbPath = join(dir, "zfacade.sqlite");
  const db = openDatabase(dbPath);
  db.prepare("INSERT INTO zf_workspace(workspace_key,canonical_path,created_at) VALUES (?,?,?) ON CONFLICT(workspace_key) DO NOTHING")
    .run(key, canonical, Date.now());
  const ownerId = newId("owner");
  const generation = tx(db, () => {
    const row = db.prepare("SELECT generation FROM zf_owner WHERE id=1").get() as { generation: number } | undefined;
    const next = (row ? Number(row.generation) : 0) + 1;
    db.prepare("INSERT INTO zf_owner(id,generation,owner_id,pid,started_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation, owner_id=excluded.owner_id, pid=excluded.pid, started_at=excluded.started_at")
      .run(next, ownerId, process.pid, Date.now());
    return next;
  });

  const artifacts = new ArtifactRepo(db);
  const store: WorkspaceStore = {
    workspacePath: canonical, workspaceKey: key, dir, dbPath, db,
    journal: new SqliteJournalStore(db),
    effects: new EffectService(db, opts?.effectHooks),
    questions: new QuestionRepo(db), commands: new CommandRepo(db),
    sessions: new SessionRepo(db), episodes: new EpisodeRepo(db), artifacts,
    ownerGeneration: generation, ownerId,
    putArtifact(runId, kind, data, contentType) {
      const id = newId("art");
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const relPath = `artifacts/${id}.bin`;
      writeFileSync(join(dir, relPath), bytes);
      artifacts.insert({ artifactId: id, runId, kind, relPath, bytes: bytes.length, sha256: sha256Hex(bytes), contentType });
      return `zfacade-artifact://${key}/${id}`;
    },
    readArtifact(ref) {
      const m = /^zfacade-artifact:\/\/[^/]+\/(.+)$/.exec(ref);
      if (!m) throw new ZfacadeError("ArtifactRefInvalid", `bad artifact ref: ${ref}`);
      return new Uint8Array(readFileSync(join(dir, "artifacts", `${m[1]}.bin`)));
    },
    usage() {
      let dbBytes = 0;
      for (const suffix of ["", "-wal", "-shm"]) {
        try { dbBytes += statSync(dbPath + suffix).size; } catch { /* missing suffix file */ }
      }
      const countRow = db.prepare("SELECT COUNT(*) AS c FROM zf_artifact").get() as { c: number };
      return { dbBytes, artifactBytes: artifacts.totalBytes(), artifactCount: Number(countRow.c) };
    },
    release() {
      try { db.close(); } catch { /* already closed */ }
      if (lockFd !== undefined) {
        try { closeSync(lockFd); } catch { /* already closed */ }
        try {
          const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
          if (holder.pid === process.pid) rmSync(lockPath, { force: true });
        } catch { /* lock already gone */ }
      }
    },
  };
  if (!existsSync(join(dir, "artifacts"))) mkdirSync(join(dir, "artifacts"), { recursive: true });
  return store;
}
