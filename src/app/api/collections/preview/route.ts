import { NextResponse } from "next/server";

import {
  normaliseCriteria,
  validateCriteria,
} from "@/lib/collectionCriteria";
import { countCriteriaMatches } from "@/lib/notion";

export const dynamic = "force-dynamic";

/**
 * Dry-run a rule: how many assets does it currently match?
 *
 * The builder calls this as you edit, so a typo or a dead tag shows up as
 * "0 matches" before you save anything. Bounded by the same cap as evaluation,
 * so a truncated result means "at least this many".
 */
export async function POST(request: Request) {
  let body: { connector?: unknown; rules?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const criteria = normaliseCriteria(body);
  const problems = validateCriteria(criteria);
  if (problems.length > 0) {
    // A malformed rule is a normal state while the user is still typing, so
    // this is a 200 with `problems` rather than an error status.
    return NextResponse.json({ count: 0, truncated: false, problems });
  }

  try {
    const { count, truncated } = await countCriteriaMatches(criteria);
    return NextResponse.json({ count, truncated, problems: [] });
  } catch (err) {
    console.error("collection preview failed", err);
    const message = err instanceof Error ? err.message : "Preview failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
