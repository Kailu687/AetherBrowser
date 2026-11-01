import { useMemo, useState } from "react";
import { CALCULATORS, findCalculators, type CalculatorDef, type Output } from "../registry.js";
import { evaluate, evaluateLines } from "../expr.js";
import { convertPhrase } from "../units.js";
import { formatSI } from "../format.js";

/**
 * Calculator sidebar panel: a scratchpad (one expression or "60 mph to km/h"
 * per line, variables carry between lines) and a searchable catalogue of
 * form-based calculators. Pure client-side; nothing leaves the device.
 */
export function CalculatorPanel({ initialTab = "scratch" }: { initialTab?: "scratch" | "tools" }) {
  const [tab, setTab] = useState(initialTab);
  return (
    <div className="ae-calc">
      <div role="tablist" className="ae-tabs">
        <button role="tab" aria-selected={tab === "scratch"} onClick={() => setTab("scratch")}>
          Scratchpad
        </button>
        <button role="tab" aria-selected={tab === "tools"} onClick={() => setTab("tools")}>
          Calculators
        </button>
      </div>
      {tab === "scratch" ? <Scratchpad /> : <Catalogue />}
    </div>
  );
}

export function Scratchpad({ initial = "r = 10k || 10k\nf = 1 / (2*pi*r*100n)\n60 mph to km/h" }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const results = useMemo(() => {
    const scope = new Map<string, number>();
    const lines = text.split("\n");
    const evald = evaluateLines(lines, scope);
    return evald.map((r, i) => {
      if (r.error) {
        const conv = convertPhrase(lines[i]!);
        if (conv) return { text: `${Number(conv.result.toPrecision(6))} ${conv.to}` };
        return { text: r.error, error: true };
      }
      return { text: r.value === undefined ? "" : formatSI(r.value, "", 6) };
    });
  }, [text]);
  return (
    <div className="ae-scratch">
      <textarea aria-label="Calculator scratchpad" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} rows={Math.max(6, results.length + 1)} />
      <ol className="ae-scratch-results" aria-label="Results">
        {results.map((r, i) => (
          <li key={i} className={r.error ? "ae-error" : undefined}>
            {r.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Catalogue() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CalculatorDef>(CALCULATORS[0]!);
  const list = findCalculators(query);
  return (
    <div className="ae-catalogue">
      <input type="search" placeholder="Search calculators" aria-label="Search calculators" value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="ae-calc-list">
        {list.map((c) => (
          <li key={c.id}>
            <button aria-pressed={c.id === selected.id} onClick={() => setSelected(c)}>
              {c.title} <small>{c.category}</small>
            </button>
          </li>
        ))}
      </ul>
      <CalculatorForm key={selected.id} def={selected} />
    </div>
  );
}

export function CalculatorForm({ def }: { def: CalculatorDef }) {
  const [raw, setRaw] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.fields.map((f) => [f.key, f.default === undefined ? "" : String(f.default)])),
  );
  let outputs: Output[] = [];
  let error: string | undefined;
  try {
    const values = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v.trim() === "" ? undefined : evaluate(v.replace(/[ΩΩ]|ohms?/gi, ""))]),
    );
    outputs = def.compute(values);
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <form className="ae-calc-form" onSubmit={(e) => e.preventDefault()} aria-label={def.title}>
      <h3>{def.title}</h3>
      {def.fields.map((f) => (
        <label key={f.key}>
          <span>
            {f.label}
            {f.unit ? ` (${f.unit})` : ""}
          </span>
          <input inputMode="decimal" value={raw[f.key]} placeholder={f.optional ? "optional" : ""} onChange={(e) => setRaw({ ...raw, [f.key]: e.target.value })} />
        </label>
      ))}
      {error ? (
        <p role="alert" className="ae-error">
          {error}
        </p>
      ) : (
        <dl className="ae-outputs">
          {outputs.map((o, i) => (
            <div key={i}>
              <dt>{o.label}</dt>
              <dd>{typeof o.value === "number" ? formatSI(o.value, o.unit ?? "") : `${o.value}${o.unit ? ` ${o.unit}` : ""}`}</dd>
            </div>
          ))}
        </dl>
      )}
    </form>
  );
}
