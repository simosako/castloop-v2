import { z } from "zod";
import { validateId } from "../packages/shared/src/index";

export type DeletionTarget = { kind: "show"; showId: string } | { kind: "episode"; showId: string; episodeId: string };
export type DeletionScope = { prefix: string } | { key: string };
export type DeletionObject = { key: string; etag: string; size: number };
export type DeletionInventoryPage = {
  target: DeletionTarget;
  scope: DeletionScope;
  payload: DeletionObject[];
  retainedMarkers: DeletionObject[];
  blockers: string[];
  nextCursor?: string;
  scopeComplete: boolean;
  authorizesDeletion: false;
};
export type DeletionReadEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "list" | "head"> };

function checkedTarget(target: DeletionTarget): DeletionTarget {
  validateId(target.showId, "show");
  if (target.kind === "episode") {
    validateId(target.episodeId, "episode");
    return { kind: "episode", showId: target.showId, episodeId: target.episodeId };
  }
  if (target.kind !== "show") throw new Error("Invalid deletion target kind");
  return { kind: "show", showId: target.showId };
}

export function lifecycleDeletionScopes(input: DeletionTarget): DeletionScope[] {
  const target = checkedTarget(input);
  if (target.kind === "episode") return [
    { prefix: `public/podcasts/${target.showId}/episodes/${target.episodeId}/` },
    { prefix: `public/episodes/${target.showId}/${target.episodeId}/` },
    { prefix: `staging/episodes/${target.showId}/${target.episodeId}/` },
  ];
  return [
    { key: `system/shows/${target.showId}/show.toml` },
    { prefix: `public/podcasts/${target.showId}/` },
    { prefix: `public/episodes/${target.showId}/` },
    { prefix: `staging/shows/${target.showId}/` },
    { prefix: `staging/episodes/${target.showId}/` },
  ];
}

export function classifyLifecycleDeletionKey(input: DeletionTarget, key: string): "payload" | "marker" | "outside" | "unknown" {
  const target = checkedTarget(input);
  if (!lifecycleDeletionScopes(target).some((scope) => "key" in scope ? key === scope.key : key.startsWith(scope.prefix))) {
    return "outside";
  }
  const parts = key.split("/");
  const validEpisode = (value: string) => {
    try { validateId(value, "episode"); return target.kind === "show" || value === target.episodeId; }
    catch { return false; }
  };
  if (key === `system/shows/${target.showId}/show.toml`) return "payload";
  if (parts[0] === "public" && parts[1] === "podcasts") {
    if (target.kind === "show" && parts.length === 4 && /^(feed\.xml|cover\.(jpg|png))$/.test(parts[3])) return "payload";
    if (parts.length === 6 && parts[3] === "episodes" && validEpisode(parts[4]) &&
      parts[5].endsWith(".mp3") && z.uuid().safeParse(parts[5].slice(0, -4)).success) return "payload";
  }
  if (parts[0] === "public" && parts[1] === "episodes" && validEpisode(parts[3])) {
    if (parts.length === 5 && parts[4] === "metadata.toml") return "payload";
    if (parts.length === 6 && parts[4] === "revisions" && parts[5].endsWith(".toml") &&
      z.uuid().safeParse(parts[5].slice(0, -5)).success) return "payload";
  }
  if (parts[0] === "staging") {
    const episode = parts[1] === "episodes";
    if ((episode && parts.length !== 6) || (!episode && (parts[1] !== "shows" || parts.length !== 5)) ||
      (episode && !validEpisode(parts[3])) || !z.uuid().safeParse(parts[episode ? 4 : 3]).success) return "unknown";
    const name = parts.at(-1)!;
    if (name === "commit.json") return "marker";
    if ((episode ? /^(episode\.toml|audio\.mp3)$/ : /^(show\.toml|cover\.(jpg|png))$/).test(name)) return "payload";
  }
  return "unknown";
}

export async function readLifecycleDeletionPage(env: DeletionReadEnv, input: DeletionTarget,
  options: { scopeIndex: number; cursor?: string; limit?: number }): Promise<DeletionInventoryPage> {
  const target = checkedTarget(input);
  const scopes = lifecycleDeletionScopes(target);
  if (!Number.isSafeInteger(options.scopeIndex) || options.scopeIndex < 0 || options.scopeIndex >= scopes.length) {
    throw new Error("Invalid deletion scope index");
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid deletion inventory page limit");
  if (options.cursor !== undefined && (!options.cursor || options.cursor.length > 4096)) throw new Error("Invalid deletion inventory cursor");
  const scope = scopes[options.scopeIndex];
  const result: DeletionInventoryPage = { target, scope, payload: [], retainedMarkers: [], blockers: [],
    scopeComplete: true, authorizesDeletion: false };
  let objects: R2Object[];
  if ("key" in scope) {
    if (options.cursor !== undefined) throw new Error("An exact-key scope cannot have a cursor");
    const object = await env.CASTLOOP_BUCKET.head(scope.key);
    objects = object ? [object] : [];
  } else {
    const listed = await env.CASTLOOP_BUCKET.list({ prefix: scope.prefix, cursor: options.cursor, limit });
    objects = listed.objects;
    if (listed.truncated) {
      if (!listed.cursor || listed.cursor === options.cursor) throw new Error("Deletion inventory cursor did not advance");
      result.nextCursor = listed.cursor;
      result.scopeComplete = false;
    }
  }
  const seen = new Set<string>();
  for (const object of objects) {
    if (seen.has(object.key)) throw new Error("Duplicate deletion inventory key");
    seen.add(object.key);
    if (!("key" in scope ? object.key === scope.key : object.key.startsWith(scope.prefix))) {
      throw new Error("Deletion inventory returned an object outside its scope");
    }
    if (!Number.isSafeInteger(object.size) || object.size < 0 || !object.etag) throw new Error("Invalid deletion object metadata");
    const entry = { key: object.key, etag: object.etag, size: object.size };
    const classification = classifyLifecycleDeletionKey(target, object.key);
    if (classification === "payload") result.payload.push(entry);
    else if (classification === "marker") result.retainedMarkers.push(entry);
    else result.blockers.push(object.key);
  }
  return result;
}
