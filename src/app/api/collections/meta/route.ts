import { NextResponse } from "next/server";

import {
  CRITERIA_FIELDS,
  CRITERIA_OPS,
  type CriteriaField,
} from "@/lib/collectionCriteria";
import { manifestVocabulary } from "@/lib/notion";

export const dynamic = "force-dynamic";

/**
 * Everything the rule builder needs to render itself: which fields can be
 * filtered, which operators each field accepts, and the option vocabulary for
 * the pickers. Reads the Manifest schema, so it costs one cached retrieve.
 */
export async function GET() {
  try {
    const options = await manifestVocabulary();

    const fields = (
      Object.entries(CRITERIA_FIELDS) as Array<
        [CriteriaField, (typeof CRITERIA_FIELDS)[CriteriaField]]
      >
    ).map(([key, spec]) => ({
      key,
      label: spec.label,
      type: spec.type,
      ops: spec.ops,
      // Only enumerated types have a closed vocabulary; rich_text is free text.
      options:
        spec.type === "multi_select"
          ? options.tags
          : spec.type === "select" && key === "source"
            ? options.source
            : spec.type === "select" && key === "rights"
              ? options.rights
              : null,
    }));

    return NextResponse.json({ fields, ops: CRITERIA_OPS });
  } catch (err) {
    console.error("collection meta failed", err);
    const message =
      err instanceof Error ? err.message : "Failed to load filter metadata";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
