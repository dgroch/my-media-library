import "server-only";

// Choosing which existing Drive folder an uploaded asset belongs in.
//
// The decision is the model's, but it is constrained on both sides: it only
// ever sees folders that actually exist (shortlisted from the live tree), and
// its answer is checked back against that list before we act on it. A model
// that invents a path, picks something off-list, or is unsure lands the asset
// in the configured fallback folder rather than somewhere wrong — misfiling a
// brand asset into a plausible-looking neighbour is worse than leaving it in
// the inbox, because nobody goes looking for a file that isn't missing.

import { driveConfig, geminiConfigured } from "./config";
import { driveFolderTree, folderCandidates, type DriveFolder } from "./driveFolders";
import { callText, extractJsonObject } from "./gemini";

export interface FolderChoice {
  id: string;
  /** "" when this is the fallback folder rather than a routed placement. */
  path: string;
  reason: string;
  routed: boolean;
}

/** What the router knows about the asset. Everything is optional. */
export interface RoutingSubject {
  filename: string;
  description?: string;
  product?: string;
  productName?: string;
  contentType?: string;
  visualTags?: string;
  /** Flowers / products the vision pass named. */
  products?: string[];
  context?: string;
  tags?: string[];
  mediaType?: string;
}

function subjectText(subject: RoutingSubject): string {
  return [
    subject.context,
    subject.description,
    subject.product,
    subject.productName,
    subject.contentType,
    subject.visualTags,
    (subject.products ?? []).join(" "),
    (subject.tags ?? []).join(" "),
    subject.filename,
  ]
    .filter(Boolean)
    .join(" ");
}

function prompt(subject: RoutingSubject, candidates: DriveFolder[]): string {
  const list = candidates
    .map((folder, i) => `${i + 1}. ${folder.path}`)
    .join("\n");

  return (
    `You are filing a brand asset into an existing Google Drive library. ` +
    `Choose the ONE folder below that an experienced brand manager would file it in.\n\n` +
    `Asset:\n` +
    `- filename: ${subject.filename}\n` +
    (subject.mediaType ? `- media: ${subject.mediaType}\n` : "") +
    (subject.product ? `- product (stated by the uploader): ${subject.product}\n` : "") +
    (subject.productName ? `- product (identified by vision): ${subject.productName}\n` : "") +
    (subject.contentType ? `- content type: ${subject.contentType}\n` : "") +
    (subject.context ? `- uploader's note: ${subject.context}\n` : "") +
    (subject.description ? `- description: ${subject.description}\n` : "") +
    (subject.visualTags ? `- visual tags: ${subject.visualTags}\n` : "") +
    ((subject.products ?? []).length
      ? `- flowers / products shown: ${subject.products!.join(", ")}\n`
      : "") +
    ((subject.tags ?? []).length ? `- tags: ${subject.tags!.join(", ")}\n` : "") +
    `\nFolders (choose by exact path):\n${list}\n\n` +
    `Rules:\n` +
    `- Prefer the most specific folder that is clearly correct. A folder named ` +
    `after this exact product beats its parent category.\n` +
    `- Do NOT choose a folder just because some words overlap. A "Christmas" ` +
    `folder is only right if the asset is actually Christmas.\n` +
    `- If no folder is clearly correct, return an empty path. That is a normal, ` +
    `correct answer — a wrong folder is much worse than none.\n\n` +
    `Return ONLY JSON: {"path":"<exact path from the list, or empty string>",` +
    `"confidence":0.0,"reason":"<short phrase>"}`
  );
}

/**
 * Pick the destination folder for an asset. Never throws and never hangs —
 * every failure path degrades to the fallback folder, because the mirror is a
 * backup and must not be able to fail or stall an upload.
 */
export async function chooseDriveFolder(
  subject: RoutingSubject,
): Promise<FolderChoice> {
  const fallback: FolderChoice = {
    id: driveConfig.folderId,
    path: "",
    reason: "fallback",
    routed: false,
  };

  if (!driveConfig.routing) return { ...fallback, reason: "routing disabled" };
  if (!geminiConfigured()) return { ...fallback, reason: "no Gemini key" };

  // A cold cache means a full tree walk plus a model call, both on the
  // uploader's request. Cap the whole thing rather than let a slow Drive or a
  // hung generation hold the upload open.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FolderChoice>((resolve) => {
    timer = setTimeout(
      () => resolve({ ...fallback, reason: "routing timed out" }),
      driveConfig.routingTimeoutMs,
    );
  });
  try {
    return await Promise.race([route(subject, fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function route(
  subject: RoutingSubject,
  fallback: FolderChoice,
): Promise<FolderChoice> {

  let candidates: DriveFolder[];
  try {
    const tree = await driveFolderTree();
    if (tree.folders.length === 0) {
      return { ...fallback, reason: "no folders under the configured root" };
    }
    candidates = folderCandidates(
      tree.folders,
      subjectText(subject),
      subject.product || subject.productName || "",
    );
  } catch (err) {
    console.error("[drive-routing] could not read the folder tree", err);
    return { ...fallback, reason: "folder tree unavailable" };
  }

  if (candidates.length === 0) {
    return { ...fallback, reason: "no candidate folders" };
  }

  let answer: Record<string, unknown>;
  try {
    answer = extractJsonObject(await callText(prompt(subject, candidates)));
  } catch (err) {
    console.error("[drive-routing] model call failed", err);
    return { ...fallback, reason: "model call failed" };
  }

  const chosenPath = String(answer.path ?? "").trim();
  if (!chosenPath) {
    return { ...fallback, reason: "model declined to choose" };
  }

  // Only ever act on a path the model was actually offered. Anything else is a
  // hallucinated folder, and creating it would quietly grow someone's Drive.
  const match = candidates.find(
    (folder) => folder.path.toLowerCase() === chosenPath.toLowerCase(),
  );
  if (!match) {
    console.warn(
      `[drive-routing] model returned an off-list path (${chosenPath}) — using the fallback folder`,
    );
    return { ...fallback, reason: "off-list path" };
  }

  const confidence = Number(answer.confidence);
  if (Number.isFinite(confidence) && confidence < driveConfig.minConfidence) {
    return {
      ...fallback,
      reason: `low confidence (${confidence.toFixed(2)}) for ${match.path}`,
    };
  }

  return {
    id: match.id,
    path: match.path,
    reason: String(answer.reason ?? "").trim() || "matched",
    routed: true,
  };
}
