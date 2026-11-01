import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import { CALCULATORS, convert, convertBase, formatEngineering, twosComplement, UNIT_SYMBOLS, unitLabel, type Base } from '@aether/calculators';
import { CalculatorForm, Scratchpad } from '@aether/calculators/ui';
import { checkDimensions, devtools, niceTicks, sampleFunction } from '../index';
import './eng.css';

type Tool = 'scratch' | 'units' | 'dims' | 'plot' | 'dev' | `calc:${string}`;

/**
 * Built-in Engineering tools (Core shared utilities): scratchpad calculator,
 * unit converter, dimensional checker, function plotter, developer toolbox and
 * the catalogue of worked calculators. All offline.
 */
export function EngineeringApp(_props: { api: WorkbenchAppApi }) {
  const [tool, setTool] = useState<Tool>('scratch');
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, typeof CALCULATORS>();
    for (const c of CALCULATORS) {
      if (q && !`${c.title} ${c.keywords.join(' ')}`.toLowerCase().includes(q.toLowerCase())) continue;
      m.set(c.category, [...(m.get(c.category) ?? []), c]);
    }
    return [...m];
  }, [q]);
  const calc = tool.startsWith('calc:') ? CALCULATORS.find((c) => `calc:${c.id}` === tool) : undefined;
  const item = (id: Tool, label: string) => (
    <button key={id} className={`wb-side-item ${tool === id ? 'on' : ''}`} onClick={() => setTool(id)}>
      {label}
    </button>
  );
  return (
    <div className="wb-split-view eng">
      <nav className="wb-side">
        <h5>Tools</h5>
        {item('scratch', '🧮 Scratchpad calculator')}
        {item('units', '⇄ Unit converter')}
        {item('dims', '📏 Dimensional checker')}
        {item('plot', '📈 Function plotter')}
        {item('dev', '🛠 Developer toolbox')}
        <h5>Calculators</h5>
        <div style={{ padding: '0 10px 6px' }}>
          <input className="wb-input" style={{ width: '100%' }} placeholder="Search calculators" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <h5>{cat}</h5>
            {list.map((c) => item(`calc:${c.id}`, c.title))}
          </div>
        ))}
      </nav>
      <main className="wb-content">
        {tool === 'scratch' && (
          <>
            <h2>Scratchpad</h2>
            <p className="muted small">One expression per line. Use variables, SI prefixes (4.7k, 100n), `||` for parallel, and conversions like `60 mph to km/h`.</p>
            <Scratchpad />
          </>
        )}
        {tool === 'units' && <Units />}
        {tool === 'dims' && <Dims />}
        {tool === 'plot' && <Plot />}
        {tool === 'dev' && <Dev />}
        {calc && (
          <>
            <h2>{calc.title}</h2>
            <CalculatorForm key={calc.id} def={calc} />
            <p className="muted small">Textbook formula for preliminary design. Check assumptions and the part's datasheet before relying on it.</p>
          </>
        )}
      </main>
    </div>
  );
}

function Units() {
  const [v, setV] = useState('1');
  const [from, setFrom] = useState('mi');
  const [to, setTo] = useState('km');
  let out = '';
  let err = '';
  try {
    out = formatEngineering(convert(Number(v), from, to), 6);
  } catch (e) {
    err = (e as Error).message;
  }
  return (
    <>
      <h2>Unit converter</h2>
      <p className="muted small">Type any unit expression: `kWh`, `N*m`, `km/h`, `kg/m^3`, `degF`. SI prefixes work on SI units.</p>
      <div className="wb-form">
        <label>
          Value
          <input className="wb-input" value={v} onChange={(e) => setV(e.target.value)} />
        </label>
        <label>
          From
          <input className="wb-input" list="eng-units" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input className="wb-input" list="eng-units" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <datalist id="eng-units">
        {UNIT_SYMBOLS.map((u) => (
          <option key={u} value={u}>
            {unitLabel(u)}
          </option>
        ))}
      </datalist>
      <div className="wb-results">
        <div className="wb-result">
          <small>Result</small>
          {err ? <span className="danger">{err}</span> : <b>{`${out} ${to}`}</b>}
        </div>
      </div>
    </>
  );
}

function Dims() {
  const [eq, setEq] = useState('kg*m/s^2 = N');
  const r = checkDimensions(eq);
  return (
    <>
      <h2>Dimensional checker</h2>
      <p className="muted small">Write the units of each term separated by `=`. It reduces every side to SI base units and tells you whether they match.</p>
      <input className="wb-input mono" style={{ width: '100%' }} value={eq} onChange={(e) => setEq(e.target.value)} />
      {r.error ? (
        <p className="danger">{r.error}</p>
      ) : (
        <>
          <table className="wb-table" style={{ marginTop: 12 }}>
            <tbody>
              {r.sides.map((s, i) => (
                <tr key={i}>
                  <td className="mono">{s.unit}</td>
                  <td className="mono">{s.dims}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={r.ok ? 'ok' : 'danger'}>{r.ok ? '✓ Dimensionally consistent' : '✗ Dimensions differ'}</p>
        </>
      )}
    </>
  );
}

const COLORS = ['var(--accent)', 'var(--accent-2)', '#e5833a', '#8bc34a'];

function Plot() {
  const [exprs, setExprs] = useState('sin(x)\nx^2/10');
  const [x0, setX0] = useState('-10');
  const [x1, setX1] = useState('10');
  const svg = useRef<SVGSVGElement>(null);
  const series = useMemo(() => {
    return exprs
      .split('\n')
      .map((e) => e.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((e) => {
        try {
          return { e, pts: sampleFunction(e, Number(x0), Number(x1)) };
        } catch (err) {
          return { e, error: (err as Error).message, pts: [] as { x: number; y: number | null }[] };
        }
      });
  }, [exprs, x0, x1]);
  const ys = series.flatMap((s) => s.pts.map((p) => p.y).filter((y): y is number => y !== null));
  const sorted = [...ys].sort((a, b) => a - b);
  // Clip extreme values (asymptotes) to the 2nd–98th percentile.
  let y0 = sorted[Math.floor(sorted.length * 0.02)] ?? -1;
  let y1 = sorted[Math.ceil(sorted.length * 0.98) - 1] ?? 1;
  if (y0 === y1) {
    y0 -= 1;
    y1 += 1;
  }
  const pad = (y1 - y0) * 0.08;
  y0 -= pad;
  y1 += pad;
  const W = 800;
  const H = 440;
  const X = (x: number) => ((x - Number(x0)) / (Number(x1) - Number(x0))) * W;
  const Y = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const path = (pts: { x: number; y: number | null }[]) => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      if (p.y === null || p.y < y0 - (y1 - y0) || p.y > y1 + (y1 - y0)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const exportSvg = () => {
    if (!svg.current) return;
    const blob = new Blob([new XMLSerializer().serializeToString(svg.current)], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plot.svg';
    a.click();
  };
  return (
    <>
      <h2>Function plotter</h2>
      <div className="eng-plot-controls">
        <label>
          y = f(x), one per line (up to 4)
          <textarea className="wb-input mono" rows={3} value={exprs} onChange={(e) => setExprs(e.target.value)} />
        </label>
        <label>
          x min
          <input className="wb-input" value={x0} onChange={(e) => setX0(e.target.value)} />
        </label>
        <label>
          x max
          <input className="wb-input" value={x1} onChange={(e) => setX1(e.target.value)} />
        </label>
        <button className="wb-btn" onClick={exportSvg}>
          Export SVG
        </button>
      </div>
      {series.filter((s) => s.error).map((s) => (
        <p key={s.e} className="danger small">
          {s.e}: {s.error}
        </p>
      ))}
      <svg ref={svg} className="eng-plot" viewBox={`-50 -10 ${W + 60} ${H + 40}`} xmlns="http://www.w3.org/2000/svg">
        <rect x={0} y={0} width={W} height={H} fill="none" stroke="currentColor" opacity={0.25} />
        {niceTicks(Number(x0), Number(x1)).map((t) => (
          <g key={`x${t}`}>
            <line x1={X(t)} x2={X(t)} y1={0} y2={H} stroke="currentColor" opacity={t === 0 ? 0.5 : 0.1} />
            <text x={X(t)} y={H + 16} fontSize={11} textAnchor="middle" fill="currentColor">
              {formatEngineering(t, 3)}
            </text>
          </g>
        ))}
        {niceTicks(y0, y1).map((t) => (
          <g key={`y${t}`}>
            <line x1={0} x2={W} y1={Y(t)} y2={Y(t)} stroke="currentColor" opacity={t === 0 ? 0.5 : 0.1} />
            <text x={-6} y={Y(t) + 4} fontSize={11} textAnchor="end" fill="currentColor">
              {formatEngineering(t, 3)}
            </text>
          </g>
        ))}
        {series.map((s, i) => (
          <path key={s.e} d={path(s.pts)} fill="none" stroke={COLORS[i]} strokeWidth={2} />
        ))}
      </svg>
      <div className="row gap small">
        {series.map((s, i) => (
          <span key={s.e} style={{ color: COLORS[i] }}>
            ━ {s.e}
          </span>
        ))}
      </div>
    </>
  );
}

function Dev() {
  const [text, setText] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [num, setNum] = useState('255');
  const [bits, setBits] = useState(8);
  const run = async (f: (t: string) => string | Promise<string>) => {
    setErr('');
    try {
      setOut(await f(text));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  let bases: ReturnType<typeof convertBase> | null = null;
  let twos = '';
  try {
    bases = convertBase(num, 'auto' as Base | 'auto');
  } catch {
    bases = null;
  }
  try {
    twos = bases ? twosComplement(bases.value, bits) : '';
  } catch (e) {
    twos = (e as Error).message;
  }
  useEffect(() => setOut(''), [text]);
  return (
    <>
      <h2>Developer toolbox</h2>
      <h4>Number bases</h4>
      <div className="wb-form">
        <label>
          Number (0x…, 0b…, 0o… or decimal)
          <input className="wb-input mono" value={num} onChange={(e) => setNum(e.target.value)} />
        </label>
        <label>
          Two's complement bits
          <select className="wb-select" value={bits} onChange={(e) => setBits(Number(e.target.value))}>
            {[8, 16, 32, 64].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
      </div>
      {bases ? (
        <div className="wb-results">
          {(['dec', 'hex', 'bin', 'oct'] as const).map((k) => (
            <div key={k} className="wb-result">
              <small>{k}</small>
              <b className="mono">{bases![k]}</b>
            </div>
          ))}
          <div className="wb-result">
            <small>{bits}-bit two's complement</small>
            <b className="mono">{twos}</b>
          </div>
        </div>
      ) : (
        <p className="danger small">Not a valid number.</p>
      )}
      <h4>Text</h4>
      <textarea className="wb-input mono" rows={6} style={{ width: '100%' }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste JSON, text, Base64, a URL or a timestamp" />
      <div className="row gap wrap" style={{ margin: '8px 0' }}>
        <button className="wb-btn small" onClick={() => void run((t) => devtools.json(t))}>Format JSON</button>
        <button className="wb-btn small" onClick={() => void run((t) => devtools.json(t, 0))}>Minify JSON</button>
        <button className="wb-btn small" onClick={() => void run(devtools.b64encode)}>Base64 encode</button>
        <button className="wb-btn small" onClick={() => void run(devtools.b64decode)}>Base64 decode</button>
        <button className="wb-btn small" onClick={() => void run(devtools.urlEncode)}>URL encode</button>
        <button className="wb-btn small" onClick={() => void run(devtools.urlDecode)}>URL decode</button>
        <button className="wb-btn small" onClick={() => void run((t) => { const r = devtools.timestamp(t); return `${r.iso}\nUnix: ${r.unix}\nLocal: ${r.local}`; })}>Timestamp</button>
        <button className="wb-btn small" onClick={() => void run(devtools.sha256)}>SHA-256</button>
      </div>
      {err && <p className="danger small">{err}</p>}
      {out && <pre className="wb-card mono eng-out">{out}</pre>}
    </>
  );
}
