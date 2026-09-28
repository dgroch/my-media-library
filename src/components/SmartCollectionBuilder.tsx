"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CollectionCriteria, CriteriaConnector, CriteriaOp } from "@/lib/collectionCriteria";

interface FieldMeta {
  key: string;
  label: string;
  type: "multi_select" | "select" | "rich_text";
  ops: CriteriaOp[];
  options: string[] | null;
}

interface OpMeta {
  label: string;
  arity: "none" | "one" | "many";
}

interface Meta {
  fields: FieldMeta[];
  ops: Record<string, OpMeta>;
}

interface Rule {
  field: string;
  op: CriteriaOp;
  values: string[];
}

interface Props {
  /** Present when editing an existing smart collection. */
  initial?: {
    id: string;
    name: string;
    connector: CriteriaConnector;
    rules: Rule[];
  };
  onClose: () => void;
  onSaved: (id: string) => void;
}

const DEFAULT_FIELD = "tags";

function blankRule(): Rule {
  return { field: DEFAULT_FIELD, op: "hasAll", values: [] };
}

/**
 * Rule builder for smart collections. Populates its pickers from the Manifest
 * schema and dry-runs the rule as you edit, so a dead tag or a typo shows up as
 * "0 matches" before anything is saved.
 */
export default function SmartCollectionBuilder({
  initial,
  onClose,
  onSaved,
}: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [connector, setConnector] = useState<CriteriaConnector>(
    initial?.connector ?? "and",
  );
  const [rules, setRules] = useState<Rule[]>(
    initial?.rules?.length ? initial.rules : [blankRule()],
  );
  const [preview, setPreview] = useState<{
    count: number;
    truncated: boolean;
    problems: { ruleIndex: number; message: string }[];
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the field/operator vocabulary once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/collections/meta");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load fields");
        if (!cancelled) setMeta(data);
      } catch (err) {
        if (!cancelled) {
          setMetaError(err instanceof Error ? err.message : "Failed to load fields");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fieldByKey = useMemo(() => {
    const m = new Map<string, FieldMeta>();
    for (const f of meta?.fields ?? []) m.set(f.key, f);
    return m;
  }, [meta]);

  // Dry-run the rule whenever it changes. Debounced so typing a free-text value
  // does not fire a Notion query per keystroke.
  const previewSeq = useRef(0);
  const runPreview = useCallback(
    async (nextRules: Rule[], nextConnector: CriteriaConnector) => {
      const seq = ++previewSeq.current;
      setPreviewing(true);
      try {
        const res = await fetch("/api/collections/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connector: nextConnector, rules: nextRules }),
        });
        const data = await res.json();
        // Ignore a stale response that lost the race against a newer edit.
        if (seq !== previewSeq.current) return;
        if (!res.ok) {
          setPreview(null);
          return;
        }
        setPreview(data);
      } catch {
        if (seq === previewSeq.current) setPreview(null);
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!meta) return;
    const t = setTimeout(() => runPreview(rules, connector), 400);
    return () => clearTimeout(t);
  }, [rules, connector, meta, runPreview]);

  function updateRule(index: number, patch: Partial<Rule>) {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
  }

  function changeField(index: number, fieldKey: string) {
    const spec = fieldByKey.get(fieldKey);
    // Reset the operator and values: ops differ per property type, and a tag
    // value is meaningless on a rich_text field.
    updateRule(index, {
      field: fieldKey,
      op: (spec?.ops[0] ?? "contains") as CriteriaOp,
      values: [],
    });
  }

  function changeOp(index: number, op: CriteriaOp) {
    const arity = meta?.ops[op]?.arity;
    // Clear values when switching to an operator that takes none.
    updateRule(index, arity === "none" ? { op, values: [] } : { op });
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the collection a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const criteria: CollectionCriteria = {
        v: 1,
        connector,
        rules: rules as CollectionCriteria["rules"],
      };
      const url = initial?.id
        ? `/api/collections/${initial.id}`
        : "/api/collections";
      const res = await fetch(url, {
        method: initial?.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          initial?.id
            ? { criteria, name: trimmed }
            : { criteria, name: trimmed },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      onSaved(data.id ?? initial?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const totalProblems = preview?.problems?.length ?? 0;

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div
        className="modal modal-wide"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{initial?.id ? "Edit rule" : "New smart collection"}</h2>
        <p className="page-sub">
          A smart collection updates itself: it re-runs this rule every time you
          open it, so newly tagged assets appear automatically.
        </p>

        {metaError && <div className="notice error">{metaError}</div>}

        <label htmlFor="sc-name">Collection name</label>
        <input
          id="sc-name"
          className="search-input"
          value={name}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. High Floral Design launch event"
        />

        <div className="rule-connector">
          <span>Match</span>
          <div className="segmented">
            <button
              type="button"
              className={connector === "and" ? "active" : ""}
              onClick={() => setConnector("and")}
              disabled={saving}
            >
              all rules
            </button>
            <button
              type="button"
              className={connector === "or" ? "active" : ""}
              onClick={() => setConnector("or")}
              disabled={saving}
            >
              any rule
            </button>
          </div>
        </div>

        <div className="rule-list">
          {rules.map((rule, i) => {
            const spec = fieldByKey.get(rule.field);
            const arity = meta?.ops[rule.op]?.arity ?? "many";
            const ruleProblem = preview?.problems?.find(
              (p) => p.ruleIndex === i,
            );
            return (
              <div className="rule-row" key={i}>
                <div className="rule-row-main">
                  <select
                    className="search-input"
                    value={rule.field}
                    disabled={saving || !meta}
                    onChange={(e) => changeField(i, e.target.value)}
                  >
                    {(meta?.fields ?? []).map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>

                  <select
                    className="search-input"
                    value={rule.op}
                    disabled={saving || !spec}
                    onChange={(e) => changeOp(i, e.target.value as CriteriaOp)}
                  >
                    {(spec?.ops ?? []).map((op) => (
                      <option key={op} value={op}>
                        {meta?.ops[op]?.label ?? op}
                      </option>
                    ))}
                  </select>

                  {arity !== "none" && (
                    <ValueInput
                      spec={spec}
                      arity={arity}
                      values={rule.values}
                      disabled={saving}
                      onChange={(values) => updateRule(i, { values })}
                    />
                  )}

                  <button
                    type="button"
                    className="btn btn-danger rule-remove"
                    disabled={saving || rules.length === 1}
                    onClick={() =>
                      setRules((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    title={
                      rules.length === 1
                        ? "A smart collection needs at least one rule"
                        : "Remove rule"
                    }
                  >
                    ✕
                  </button>
                </div>
                {ruleProblem && (
                  <div className="rule-problem">{ruleProblem.message}</div>
                )}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          className="btn"
          disabled={saving}
          onClick={() => setRules((prev) => [...prev, blankRule()])}
        >
          + Add rule
        </button>

        <div className="rule-preview">
          {previewing ? (
            <span className="spinner" />
          ) : totalProblems > 0 ? (
            <span className="preview-bad">
              Fix {totalProblems} problem{totalProblems === 1 ? "" : "s"} above
            </span>
          ) : preview ? (
            <span className={preview.count === 0 ? "preview-zero" : "preview-ok"}>
              {preview.count}
              {preview.truncated ? "+" : ""} matching asset
              {preview.count === 1 ? "" : "s"}
              {preview.count === 0 && " — no assets match this rule yet"}
            </span>
          ) : (
            <span className="muted">Preview unavailable</span>
          )}
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={saving || totalProblems > 0 || previewing}
          >
            {saving ? <span className="spinner" /> : initial?.id ? "Save rule" : "Create collection"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Value editor whose shape follows the field type and the operator's arity. */
function ValueInput({
  spec,
  arity,
  values,
  disabled,
  onChange,
}: {
  spec: FieldMeta | undefined;
  arity: "none" | "one" | "many";
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  const [filter, setFilter] = useState("");

  if (!spec) return <div className="rule-values muted">—</div>;

  // Enumerated fields get a picker built from the real schema vocabulary, so a
  // typo cannot invent a tag that matches nothing.
  if (spec.options) {
    if (arity === "one" || spec.type === "select") {
      return (
        <select
          className="search-input"
          value={values[0] ?? ""}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        >
          <option value="">Choose…</option>
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }

    const q = filter.trim().toLowerCase();
    const shown = q
      ? spec.options.filter((o) => o.toLowerCase().includes(q))
      : spec.options;
    return (
      <div className="tag-picker">
        <input
          className="search-input"
          placeholder={`Filter ${spec.label.toLowerCase()}…`}
          value={filter}
          disabled={disabled}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="tag-picker-list">
          {shown.map((o) => {
            const checked = values.includes(o);
            return (
              <label key={o} className={`chip${checked ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() =>
                    onChange(
                      checked
                        ? values.filter((v) => v !== o)
                        : [...values, o],
                    )
                  }
                />
                {o}
              </label>
            );
          })}
          {shown.length === 0 && <span className="muted">No matches</span>}
        </div>
      </div>
    );
  }

  // Free-text fields: a plain input, since there is no closed vocabulary.
  return (
    <input
      className="search-input"
      placeholder={`${spec.label}…`}
      value={values[0] ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
    />
  );
}
