// Smart-collection criteria: the rule model, its validation, and the compiler
// that turns it into a Notion data-source filter.
//
// A smart collection stores one of these as JSON in the `Criteria` rich_text
// property of its Collections row, and re-evaluates it on every view, so the
// membership stays current as new assets are added. Manual collections keep
// using the `Assets` relation and never touch this module.
//
// Design constraints, from the Notion API (see filter-data-source-entries):
//   - Compound filters (`and`/`or`) nest at most TWO levels deep.
//   - `multi_select.contains` accepts an array, but means ANY of them (OR), so
//     "all of these tags" has to be expressed as N separate `contains` clauses.
//   - `rich_text` has no array form: one condition compares one string.
// `compileCriteria` therefore emits at most two compound levels by construction
// and rejects anything it cannot express rather than letting Notion 400.

import { humanProps } from "./config";

export type CriteriaField =
  | "tags"
  | "source"
  | "rights"
  | "context"
  | "people"
  | "product"
  | "location"
  | "shoot"
  | "credit"
  | "rightsNotes";

export type CriteriaOp =
  | "hasAll"
  | "hasAny"
  | "hasNone"
  | "is"
  | "isNot"
  | "contains"
  | "equals"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty";

export type CriteriaConnector = "and" | "or";

export interface CriteriaRule {
  field: CriteriaField;
  op: CriteriaOp;
  /** Operand values. Ops that take none (`isEmpty`/`isNotEmpty`) use []. */
  values: string[];
}

export interface CollectionCriteria {
  /** Schema version, so the stored JSON can evolve without guessing. */
  v: 1;
  /**
   * How the rules combine. One connector for the whole collection — per-row
   * mixing would need arbitrary nesting, which Notion's two-level limit cannot
   * express.
   */
  connector: CriteriaConnector;
  rules: CriteriaRule[];
}

type PropType = "multi_select" | "select" | "rich_text";

interface FieldSpec {
  /** Notion property name. */
  name: string;
  type: PropType;
  /** Human label for the builder UI. */
  label: string;
  /** Operators that make sense for this property type. */
  ops: CriteriaOp[];
}

/**
 * The fields a rule may target. Names come from `humanProps`, so the existing
 * NOTION_PROP_* overrides keep working.
 */
export const CRITERIA_FIELDS: Record<CriteriaField, FieldSpec> = {
  tags: {
    name: humanProps.tags,
    type: "multi_select",
    label: "Tags",
    ops: ["hasAll", "hasAny", "hasNone", "isEmpty", "isNotEmpty"],
  },
  source: {
    name: humanProps.source,
    type: "select",
    label: "Source",
    ops: ["is", "isNot", "isEmpty", "isNotEmpty"],
  },
  rights: {
    name: humanProps.rights,
    type: "select",
    label: "Rights",
    ops: ["is", "isNot", "isEmpty", "isNotEmpty"],
  },
  context: {
    name: humanProps.context,
    type: "rich_text",
    label: "Context",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  people: {
    name: humanProps.people,
    type: "rich_text",
    label: "People",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  product: {
    name: humanProps.product,
    type: "rich_text",
    label: "Product",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  location: {
    name: humanProps.location,
    type: "rich_text",
    label: "Location",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  shoot: {
    name: humanProps.shoot,
    type: "rich_text",
    label: "Shoot",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  credit: {
    name: humanProps.credit,
    type: "rich_text",
    label: "Credit",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
  rightsNotes: {
    name: humanProps.rightsNotes,
    type: "rich_text",
    label: "Rights notes",
    ops: ["contains", "notContains", "equals", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
  },
};

export const CRITERIA_OPS: Record<CriteriaOp, { label: string; arity: "none" | "one" | "many" }> = {
  hasAll: { label: "has all of", arity: "many" },
  hasAny: { label: "has any of", arity: "many" },
  hasNone: { label: "has none of", arity: "many" },
  is: { label: "is", arity: "many" },
  isNot: { label: "is not", arity: "many" },
  contains: { label: "contains", arity: "one" },
  notContains: { label: "does not contain", arity: "one" },
  // Notion's rich_text `equals` ignores case, so the label says so rather than
  // promising an exact match.
  equals: { label: "is (ignoring case)", arity: "one" },
  startsWith: { label: "starts with", arity: "one" },
  endsWith: { label: "ends with", arity: "one" },
  isEmpty: { label: "is empty", arity: "none" },
  isNotEmpty: { label: "is not empty", arity: "none" },
};

/** Notion filter object. Deliberately loose: the SDK types are unions. */
export type NotionFilter = Record<string, unknown>;

/** A validation problem, addressed to the rule that caused it. */
export interface CriteriaProblem {
  /** Index into `rules`, or -1 for a whole-criteria problem. */
  ruleIndex: number;
  message: string;
}

const MAX_COMPOUND_DEPTH = 2;

/** Notion's per-segment limit for a rich_text `text.content`. */
const RICH_TEXT_SEGMENT_MAX = 2000;

/** Trim, drop blanks, and de-duplicate while preserving order. */
function cleanValues(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Validate a parsed criteria object. Returns [] when it is usable.
 * `knownOptions` maps a field to the option names the data source actually
 * has; when supplied, select/multi_select values are checked against it so a
 * typo produces a clear error instead of silently matching nothing.
 */
export function validateCriteria(
  criteria: unknown,
  knownOptions?: Partial<Record<CriteriaField, string[]>>,
): CriteriaProblem[] {
  const problems: CriteriaProblem[] = [];

  if (!criteria || typeof criteria !== "object") {
    return [{ ruleIndex: -1, message: "Criteria must be an object." }];
  }
  const c = criteria as Partial<CollectionCriteria>;
  if (c.connector !== "and" && c.connector !== "or") {
    problems.push({ ruleIndex: -1, message: 'connector must be "and" or "or".' });
  }
  if (!Array.isArray(c.rules) || c.rules.length === 0) {
    // An empty rule set would match the entire library; refuse rather than
    // silently resolving to thousands of rows.
    problems.push({ ruleIndex: -1, message: "At least one rule is required." });
    return problems;
  }

  // Notion stores the rule as rich_text: at most 100 segments of 2,000
  // characters. Anything larger could never be saved.
  if (JSON.stringify(c).length > 100 * RICH_TEXT_SEGMENT_MAX) {
    problems.push({ ruleIndex: -1, message: "This rule is too large to save." });
    return problems;
  }

  const spec = (f: unknown): FieldSpec | undefined =>
    typeof f === "string" ? CRITERIA_FIELDS[f as CriteriaField] : undefined;

  c.rules.forEach((rule, i) => {
    if (!rule || typeof rule !== "object") {
      problems.push({ ruleIndex: i, message: "Rule must be an object." });
      return;
    }
    const fs = spec(rule.field);
    if (!fs) {
      problems.push({ ruleIndex: i, message: `Unknown field "${String(rule.field)}".` });
      return;
    }
    const op = CRITERIA_OPS[rule.op as CriteriaOp];
    if (!op) {
      problems.push({ ruleIndex: i, message: `Unknown operator "${String(rule.op)}".` });
      return;
    }
    if (!fs.ops.includes(rule.op)) {
      problems.push({
        ruleIndex: i,
        message: `Operator "${rule.op}" is not valid for ${fs.label} (${fs.type}).`,
      });
      return;
    }

    const values = cleanValues(rule.values);
    if (op.arity === "none" && values.length > 0) {
      problems.push({ ruleIndex: i, message: `"${op.label}" takes no values.` });
    }
    if (op.arity === "one" && values.length !== 1) {
      problems.push({
        ruleIndex: i,
        message: `"${op.label}" needs exactly one value (got ${values.length}).`,
      });
    }
    if (op.arity === "many" && values.length === 0) {
      problems.push({ ruleIndex: i, message: `"${op.label}" needs at least one value.` });
    }

    // Option-name check for the enumerated property types. Exact match:
    // Notion's option names are case-sensitive in filters, so "HIGH-FLORAL"
    // would be refused at query time even though "high-floral" exists.
    const options = knownOptions?.[rule.field as CriteriaField];
    if (options && fs.type !== "rich_text") {
      const exact = new Set(options);
      for (const v of values) {
        if (exact.has(v)) continue;
        const near = options.find((o) => o.toLowerCase() === v.toLowerCase());
        problems.push({
          ruleIndex: i,
          message: near
            ? `"${v}" is not an existing ${fs.label} option. Did you mean "${near}"?`
            : `"${v}" is not an existing ${fs.label} option.`,
        });
      }
    }
  });

  return problems;
}

/** A single leaf condition for one field. */
function leaf(spec: FieldSpec, condition: Record<string, unknown>): NotionFilter {
  return { property: spec.name, [spec.type]: condition };
}

/**
 * Expand one rule into one or more leaf filters.
 *
 * `hasAll` is the interesting case: `multi_select.contains` with an array means
 * ANY, so "all of these tags" must become one `contains` per value. Whether
 * that needs its own nested group depends on the connector — under `and` the
 * clauses can flatten into the parent, but under `or` they must be wrapped so
 * the AND-ness is preserved.
 */
function ruleLeaves(rule: CriteriaRule, spec: FieldSpec): NotionFilter[] {
  const op = rule.op;
  const values = cleanValues(rule.values);

  switch (op) {
    case "isEmpty":
      return [leaf(spec, { is_empty: true })];
    case "isNotEmpty":
      return [leaf(spec, { is_not_empty: true })];

    case "hasAll":
      return values.map((v) => leaf(spec, { contains: v }));
    case "hasAny":
      // Array form is documented as "matches any of the provided values".
      return [leaf(spec, { contains: values })];
    case "hasNone":
      return [leaf(spec, { does_not_contain: values })];

    case "is":
      return [leaf(spec, { equals: values })];
    case "isNot":
      return [leaf(spec, { does_not_equal: values })];

    case "contains":
      return [leaf(spec, { contains: values[0] })];
    case "notContains":
      return [leaf(spec, { does_not_contain: values[0] })];
    case "equals":
      return [leaf(spec, { equals: values[0] })];
    case "startsWith":
      return [leaf(spec, { starts_with: values[0] })];
    case "endsWith":
      return [leaf(spec, { ends_with: values[0] })];

    default:
      // Unreachable: validateCriteria rejects unknown operators first.
      throw new Error(`Unsupported operator: ${String(op)}`);
  }
}

/** Count nested compound levels; Notion allows at most `MAX_COMPOUND_DEPTH`. */
function compoundDepth(filter: NotionFilter): number {
  const groups = (["and", "or"] as const).filter((k) => Array.isArray(filter[k]));
  if (groups.length === 0) return 0;
  let deepest = 0;
  for (const key of groups) {
    for (const child of filter[key] as NotionFilter[]) {
      deepest = Math.max(deepest, compoundDepth(child));
    }
  }
  return 1 + deepest;
}

/**
 * Compile criteria into a Notion filter, or throw with a readable message.
 *
 * Throws rather than returning null so a bad rule surfaces at the API boundary
 * instead of quietly resolving to "everything".
 */
export function compileCriteria(
  criteria: CollectionCriteria,
  knownOptions?: Partial<Record<CriteriaField, string[]>>,
): NotionFilter {
  const problems = validateCriteria(criteria, knownOptions);
  if (problems.length > 0) {
    throw new Error(
      "Invalid collection criteria: " +
        problems.map((p) => (p.ruleIndex >= 0 ? `rule ${p.ruleIndex + 1}: ${p.message}` : p.message)).join("; "),
    );
  }

  const connector = criteria.connector;
  const clauses: NotionFilter[] = [];

  for (const rule of criteria.rules) {
    const spec = CRITERIA_FIELDS[rule.field];
    const leaves = ruleLeaves(rule, spec);
    if (leaves.length === 1) {
      clauses.push(leaves[0]);
      continue;
    }
    if (connector === "and") {
      // Already an AND context — flatten, so we stay at one compound level.
      clauses.push(...leaves);
    } else {
      // OR context: keep the rule's internal AND-ness with one nested group.
      // This is the only place a second level appears.
      clauses.push({ and: leaves });
    }
  }

  const filter: NotionFilter =
    clauses.length === 1 ? clauses[0] : { [connector]: clauses };

  const depth = compoundDepth(filter);
  if (depth > MAX_COMPOUND_DEPTH) {
    // Defensive: by construction we never exceed 2, so this indicates a bug in
    // the expansion above rather than bad user input.
    throw new Error(
      `Compiled filter nests ${depth} levels, but Notion allows ${MAX_COMPOUND_DEPTH}.`,
    );
  }
  return filter;
}

/** Parse the JSON stored in the Criteria property. Returns null when absent. */
export function parseCriteria(raw: string | null | undefined): CollectionCriteria | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Partial<CollectionCriteria>;
  if (!Array.isArray(c.rules)) return null;
  // Refuse a schema version this code does not understand rather than
  // guessing at it. A missing `v` predates versioning and is read as 1.
  if (c.v !== undefined && c.v !== 1) return null;
  return {
    v: 1,
    connector: c.connector === "or" ? "or" : "and",
    rules: c.rules as CriteriaRule[],
  };
}

/** One-line, human-readable rendering — stored in `Rule Summary`. */
export function describeCriteria(criteria: CollectionCriteria): string {
  const join = criteria.connector === "or" ? " OR " : " AND ";
  const parts = criteria.rules.map((rule) => {
    const spec = CRITERIA_FIELDS[rule.field];
    const label = spec?.label ?? rule.field;
    const opLabel = CRITERIA_OPS[rule.op]?.label ?? rule.op;
    const values = cleanValues(rule.values);
    if (values.length === 0) return `${label} ${opLabel}`;
    const quoted = values.map((v) => `"${v}"`).join(", ");
    return `${label} ${opLabel} ${quoted}`;
  });
  return parts.join(join);
}

/** Normalise raw rule input from the builder into a storable object. */
export function normaliseCriteria(input: {
  connector?: unknown;
  rules?: unknown;
}): CollectionCriteria {
  const connector: CriteriaConnector = input.connector === "or" ? "or" : "and";
  const rules = Array.isArray(input.rules)
    ? (input.rules as CriteriaRule[]).map((r) => ({
        field: r?.field,
        op: r?.op,
        values: cleanValues(r?.values),
      }))
    : [];
  return { v: 1, connector, rules: rules as CriteriaRule[] };
}

/**
 * Split a long string into rich_text segments Notion will accept. A single
 * segment is capped at 2,000 characters, so a large rule stored as one segment
 * would fail to save; reading joins the segments back (see `plainText`).
 * Never splits a surrogate pair, so emoji and other astral characters survive.
 */
export function toRichTextSegments(
  value: string,
): Array<{ text: { content: string } }> {
  const segments: Array<{ text: { content: string } }> = [];
  let i = 0;
  while (i < value.length) {
    let end = Math.min(i + RICH_TEXT_SEGMENT_MAX, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    segments.push({ text: { content: value.slice(i, end) } });
    i = end;
  }
  return segments;
}
