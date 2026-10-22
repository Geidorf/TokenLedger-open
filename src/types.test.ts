import { describe, expect, it } from 'vitest';
import {
  assignToolChartSlots,
  colorForTool,
  colorsForToolsInView,
  effectiveTokens,
  getPalette,
  PALETTE,
  PALETTE_DARK,
  PALETTE_LIGHT,
  summaryEffectiveTokens,
  toolChartSlot,
  toolColorMap,
} from './types';

/** The 18 canonical tool identities (excludes same-product aliases, tested separately below). */
const TOOL_IDENTITIES = ['antigravity', 'claude', 'codex', 'opencode', 'kilo', 'kimi', 'pi', 'minimax', 'qclaw', 'reasonix',
  'trae', 'workbuddy', 'marvis', 'deepseek', 'hermes', 'zcode', 'grok', 'gemini'];
/** Same-product spelling variants that must resolve to their canonical name's slot (T10.161, carried into T10.178; alias table is R-8(b)). */
const ALIASES: Array<[string, string]> = [['kimidesktop', 'kimi'], ['mavis', 'marvis'], ['deepseekgui', 'deepseek'], ['dsh', 'deepseek']];
/** Tool -> chart-slot table, shared with Android (android-visual-refresh-v2.md §3.8, user decision V-Q6). */
const EXPECTED_SLOT: Record<string, number> = {
  antigravity: 1, gemini: 1,
  codex: 2, marvis: 2, mavis: 2, hermes: 2,
  pi: 3,
  opencode: 4, workbuddy: 4,
  reasonix: 5, deepseek: 5, deepseekgui: 5, dsh: 5, grok: 5,
  claude: 6, qclaw: 6,
  kilo: 7, kimi: 7, kimidesktop: 7, trae: 7,
  minimax: 8, zcode: 8,
};
/** One tool per primary slot 1..8, in slot order, none colliding — `colorsForToolsInView` on this list returns the 8 raw slot colours untouched. */
const SLOT_PROBE = ['antigravity', 'codex', 'pi', 'opencode', 'reasonix', 'claude', 'kilo', 'minimax'];
/** T10.150 surfaces: panel, popover, page. Charts draw on the panel. */
const SURFACES = { dark: { panel: '#15181e', popover: '#1d2129', page: '#0d0f13' }, light: { panel: '#ffffff', popover: '#ffffff', page: '#f4f5f7' } } as const;

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const toLinearSrgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinearSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);

/** Source-over in gamma-encoded sRGB with 8-bit output, as canvas and CSS composite a translucent fill. */
function composite(hex: string, alpha: number, surface: string): string {
  const fg = channels(hex);
  const bg = channels(surface);
  return `#${fg.map((c, i) => Math.round((alpha * c + (1 - alpha) * bg[i]) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// Colour-vision deficiency simulation: Machado, Oliveira & Fernandes (2009), severity 1.0, in linear RGB.
const CVD_MATRICES = {
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
} as const;
type Vision = 'normal' | keyof typeof CVD_MATRICES;
type Lab = [number, number, number];

/** CIE L*a*b* (D65) of a colour as seen with the given vision. */
function labOf(hex: string, vision: Vision = 'normal'): Lab {
  let rgb = channels(hex);
  if (vision !== 'normal') {
    const linear = rgb.map(toLinearSrgb);
    rgb = CVD_MATRICES[vision].map((row) => fromLinearSrgb(Math.min(1, Math.max(0, row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]))));
  }
  const [r, g, b] = rgb.map(toLinearSrgb);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const fy = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
function ciede2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => (a === 0 && b === 0 ? 0 : ((Math.atan2(b, a) / rad) + 360) % 360);
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

const deltaE00 = (x: string, y: string, vision: Vision = 'normal') => ciede2000(labOf(x, vision), labOf(y, vision));

/** Smallest pairwise CIEDE2000 distance across every combination in `colors` — "the same-view worst case" when every colour can appear alongside every other. */
function minPairwiseDeltaE(colors: readonly string[], vision: Vision): number {
  let min = Infinity;
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      min = Math.min(min, deltaE00(colors[i], colors[j], vision));
    }
  }
  return min;
}

function relativeLuminance(hex: string): number {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('types / color palette', () => {
  it('effectiveTokens sums input and output without cache drift', () => {
    expect(effectiveTokens({ input: 100, output: 50 })).toBe(150);
  });

  it('summaryEffectiveTokens sums input and output without cache drift', () => {
    expect(summaryEffectiveTokens({
      totalTokens: 500,
      inputTokens: 300,
      outputTokens: 200,
      cachedTokens: 1000,
      totalCost: 0.1,
      totalRequests: 5,
      avgTokensPerReq: 100,
    })).toBe(500);
  });

  // --- T10.178: tool -> chart-slot table (shared with Android, V-Q6) -------

  it('resolves the full tool -> chart-slot table shared with Android (android-visual-refresh-v2.md §3.8), case-insensitively', () => {
    for (const [name, slot] of Object.entries(EXPECTED_SLOT)) {
      expect(toolChartSlot(name), name).toBe(slot);
      expect(toolChartSlot(name.toUpperCase()), `${name} upper-case`).toBe(slot);
      expect(toolChartSlot(name[0].toUpperCase() + name.slice(1)), `${name} capitalised`).toBe(slot);
    }
    // Every canonical identity and alias is covered above; nothing in the
    // table maps outside 1..8.
    expect(Object.values(EXPECTED_SLOT).every((slot) => slot >= 1 && slot <= 8)).toBe(true);
  });

  it('aliases of the same product resolve to their canonical name\'s slot and colour (R-8(b): alias table is resolved before the slot table lookup)', () => {
    for (const [alias, canonical] of ALIASES) {
      expect(toolChartSlot(alias), `${alias} follows ${canonical}`).toBe(toolChartSlot(canonical));
      for (const theme of ['dark', 'light'] as const) {
        expect(colorForTool(alias, 0, theme)).toBe(colorForTool(canonical, 0, theme));
      }
    }
    // Whitespace around a name is trimmed before both alias resolution and
    // hashing (R-8(a)) — " mavis " is still the "mavis" alias, not a
    // different, unregistered name that would hash on its own.
    expect(toolChartSlot(' mavis ')).toBe(toolChartSlot('marvis'));
  });

  it('colorForTool resolves a slot straight to the matching --chart-N token value (tokens.css)', () => {
    // slot 6 == --chart-6
    expect(colorForTool('claude', 0, 'dark')).toBe('#3fe480');
    expect(colorForTool('claude', 0, 'light')).toBe('#16a34a');
    expect(colorForTool('qclaw', 0, 'dark')).toBe(colorForTool('claude', 0, 'dark'));
    // slot 2 == --chart-2
    expect(colorForTool('codex', 0, 'dark')).toBe('#907adc');
    expect(colorForTool('codex', 0, 'light')).toBe('#8972fe');
    expect(colorForTool('marvis', 0, 'dark')).toBe(colorForTool('codex', 0, 'dark'));
    expect(colorForTool('hermes', 0, 'light')).toBe(colorForTool('codex', 0, 'light'));
    // slot 3 == --chart-3, the one tool alone in its slot
    expect(colorForTool('pi', 0, 'dark')).toBe('#2dd4bf');
    expect(colorForTool('pi', 0, 'light')).toBe('#0d9488');
  });

  // The tokens.css mirror-guard (comparing these hard-coded values against
  // the actual --chart-1..8 CSS, review FI-5) lives in
  // tests/frontend-contracts.test.mjs instead of here: this file is
  // type-checked under the browser-only tsconfig (no Node/fs types), while
  // that one already reads source/config files off disk as plain JS.

  it('colorForTool resolves case-insensitively and infers the theme from the document data-theme attribute when omitted', () => {
    expect(colorForTool('CLAUDE', 0, 'light')).toBe('#16a34a');
    expect(colorForTool('OpenCode', 0, 'light')).toBe('#d57501');
    expect(colorForTool('cOdEx', 0, 'dark')).toBe('#907adc');

    try {
      document.documentElement.setAttribute('data-theme', 'light');
      expect(colorForTool('claude')).toBe('#16a34a');
      expect(getPalette()).toBe(PALETTE_LIGHT);

      document.documentElement.setAttribute('data-theme', 'dark');
      expect(colorForTool('claude')).toBe('#3fe480');
      expect(getPalette()).toBe(PALETTE_DARK);
    } finally {
      document.documentElement.removeAttribute('data-theme');
    }
  });

  it('an unregistered tool hashes to a stable, reproducible slot in 1..8 (review-equivalent of T10.161\'s P3-8 fallback)', () => {
    const names = ['some_future_tool', 'a-brand-new-cli', '未来工具', 'x', ''];
    for (const name of names) {
      const slot = toolChartSlot(name);
      expect(slot, name).toBeGreaterThanOrEqual(1);
      expect(slot, name).toBeLessThanOrEqual(8);
      // Same name, same slot, every time (and independent of casing).
      expect(toolChartSlot(name)).toBe(slot);
      expect(toolChartSlot(name.toUpperCase())).toBe(slot);
      expect(colorForTool(name, 0, 'dark')).toBe(colorForTool(name, 0, 'dark'));
    }
    // Does not depend on process/call order: shuffling unrelated lookups
    // in between does not change a name's own slot.
    const before = toolChartSlot('some_future_tool');
    toolChartSlot('claude');
    toolChartSlot('a-brand-new-cli');
    expect(toolChartSlot('some_future_tool')).toBe(before);
  });

  it('R-8(a) fixed hash vectors (FNV-1a 32-bit over the normalised — trimmed, lower-cased — name, mod 8): Android copies this exact table to land on the same slot for the same name', () => {
    // Verified against this commit's implementation; a change here is a
    // cross-platform-visible behaviour change, not a refactor.
    expect(['', 'x', 'some_future_tool', '未来工具', 'cursor', 'cline'].map(toolChartSlot)).toEqual([6, 8, 5, 1, 8, 1]);
    // Leading/trailing whitespace does not change the slot: it is trimmed
    // before hashing, same as before alias/table lookup.
    expect(toolChartSlot('  cursor  ')).toBe(toolChartSlot('cursor'));
    expect(toolChartSlot('\tcline\n')).toBe(toolChartSlot('cline'));
  });

  // --- T10.178: same-view collision handling -------------------------------

  it('assignToolChartSlots leaves non-colliding tools on their own primary slot', () => {
    expect(assignToolChartSlots(['claude', 'codex', 'pi'])).toEqual([6, 2, 3]);
  });

  it('assignToolChartSlots shifts the lower-ranked tool to the next empty slot on a same-slot collision, and is reproducible', () => {
    // codex, marvis and hermes all primary to slot 2.
    expect(assignToolChartSlots(['codex', 'marvis'])).toEqual([2, 3]);
    expect(assignToolChartSlots(['codex', 'marvis', 'hermes'])).toEqual([2, 3, 4]);
    // Rank order decides who yields: whoever is highest-ranked (first) keeps
    // the primary slot; a later tool with the same primary shifts, even when
    // it is the "canonical" one for that slot.
    expect(assignToolChartSlots(['marvis', 'codex'])).toEqual([2, 3]);
    expect(assignToolChartSlots(['hermes', 'codex', 'marvis'])).toEqual([2, 3, 4]);
    // Deterministic: same rank-ordered input, same output, every call.
    expect(assignToolChartSlots(['codex', 'marvis', 'hermes'])).toEqual(assignToolChartSlots(['codex', 'marvis', 'hermes']));
  });

  it('assignToolChartSlots only shifts within the colliding pair, not tools already placed elsewhere', () => {
    // gemini shares slot 1 with antigravity, but claude (slot 6) is unrelated
    // and must not move just because something later in the list collides.
    expect(assignToolChartSlots(['antigravity', 'claude', 'gemini'])).toEqual([1, 6, 2]);
  });

  it('an out-of-table name is not exempt from the same-view shift: it still moves off a slot an earlier tool already took (review P1-1 "表外的名字要接着已占用的槽顺延")', () => {
    // '未来工具' hashes to slot 1 (fixed vector above) — the same primary as antigravity/gemini.
    expect(toolChartSlot('未来工具')).toBe(1);
    expect(assignToolChartSlots(['antigravity', '未来工具'])).toEqual([1, 2]);
  });

  it('assignToolChartSlots gives the 9th+ ranked tool in one view the neutral "other" slot instead of repeating an already-placed primary slot (R-8(d))', () => {
    // One tool per slot, in order 1..8: no collisions yet.
    const eightDistinct = ['antigravity', 'codex', 'pi', 'opencode', 'reasonix', 'claude', 'kilo', 'minimax'];
    expect(assignToolChartSlots(eightDistinct)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 9th and 10th tools (gemini, workbuddy) arrive after every slot is full:
    // both draw "other", not a repeated/reshuffled primary slot — the
    // pairwise-distinct guarantee only ever covered the top 8 (R-8(d)).
    const withOverflow = assignToolChartSlots([...eightDistinct, 'gemini', 'workbuddy']);
    expect(withOverflow.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(withOverflow[8]).toBe('other');
    expect(withOverflow[9]).toBe('other');
  });

  it('colours for the 9th+ ranked tool share one neutral "other" colour, distinct from every one of the 8 identity slots, in both themes', () => {
    const eightDistinct = ['antigravity', 'codex', 'pi', 'opencode', 'reasonix', 'claude', 'kilo', 'minimax'];
    for (const theme of ['dark', 'light'] as const) {
      const colors = colorsForToolsInView([...eightDistinct, 'gemini', 'workbuddy'], theme);
      expect(colors[8]).toBe(colors[9]); // rank 9 and rank 10 share the same "other" colour…
      expect(new Set(colors.slice(0, 8)).has(colors[8])).toBe(false); // …which is none of the 8 slot colours.
      // Still a real, readable colour against every T10.150 surface, not a
      // decorative accident of whatever the fallback happened to resolve to.
      for (const surface of Object.values(SURFACES[theme])) {
        expect(contrastRatio(colors[8], surface)).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it(
    'property: for any same-view combination of up to 8 distinct tools (named or hashed), ' +
    'assignToolChartSlots always gives pairwise-distinct slots — T10.161\'s "no two tools share a colour" ' +
    'guarantee, rescoped from global to "within one view" (root guidance 2026-09-25; see task log)',
    () => {
      // Deterministic PRNG (mulberry32) so this is reproducible across runs and
      // machines without a property-testing dependency (none is installed).
      const mulberry32 = (seed: number) => () => {
        seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const shuffle = <T,>(items: readonly T[], rand: () => number): T[] => {
        const copy = items.slice();
        for (let i = copy.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rand() * (i + 1));
          [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
      };
      // The 21 known identities (18 canonical + 3 same-slot aliases already
      // covered by TOOL_IDENTITIES via their canonical spelling would be
      // redundant, so alias spellings are included directly here) plus a
      // handful of never-registered names, so both the table path and the
      // hash path are exercised.
      const knownPool = [...TOOL_IDENTITIES, 'kimidesktop', 'mavis', 'deepseekgui', 'dsh'];
      const unregisteredPool = ['tool-alpha', 'tool-beta', 'brand-new-cli', '未来工具', 'x', 'y', 'z', 'a1b2c3'];
      const pool = [...knownPool, ...unregisteredPool];

      const rand = mulberry32(178025); // fixed seed: same trials every run
      const TRIALS = 200;
      for (let trial = 0; trial < TRIALS; trial += 1) {
        const size = 2 + Math.floor(rand() * 7); // 2..8 distinct tools in one view
        const combo = shuffle(pool, rand).slice(0, size);
        const slots = assignToolChartSlots(combo);
        expect(new Set(slots).size, `trial ${trial}: [${combo.join(', ')}] -> [${slots.join(', ')}]`).toBe(combo.length);
        // And the colours resolved from those slots are pairwise distinct too,
        // in both themes (the property that is actually visible to a user).
        for (const theme of ['dark', 'light'] as const) {
          const colors = colorsForToolsInView(combo, theme);
          expect(new Set(colors).size, `trial ${trial} ${theme}: [${combo.join(', ')}] -> [${colors.join(', ')}]`).toBe(combo.length);
        }
      }
    },
  );

  it('colorsForToolsInView resolves the shifted slots straight to colours for the given theme', () => {
    expect(colorsForToolsInView(['codex', 'marvis'], 'dark')).toEqual(['#907adc', '#2dd4bf']); // chart-2, chart-3
    expect(colorsForToolsInView(['codex', 'marvis'], 'light')).toEqual(['#8972fe', '#0d9488']);
    expect(colorsForToolsInView([], 'dark')).toEqual([]);
  });

  // --- T10.178 review P1-1: toolColorMap (whole-view leaf-item colouring) --

  describe('toolColorMap', () => {
    it('dedupes repeated leaf-item tool names by first occurrence, matches colorsForToolsInView, and keys are lower-cased', () => {
      // As if 3 models belonged to antigravity, antigravity, gemini in that
      // rank order (BarPanel's shape): antigravity's repeat must not consume
      // a second slot ahead of gemini, or shift gemini further than it should.
      const map = toolColorMap(['antigravity', 'antigravity', 'GEMINI'], 'dark');
      const [antigravityColor, geminiColor] = colorsForToolsInView(['antigravity', 'gemini'], 'dark');
      expect(map.get('antigravity')).toBe(antigravityColor);
      expect(map.get('gemini')).toBe(geminiColor);
      expect(map.get('antigravity')).not.toBe(map.get('gemini'));
      expect(map.size).toBe(2);
    });

    it('an out-of-table leaf-item tool name still continues the same-view shift instead of landing on an already-used slot', () => {
      expect(toolChartSlot('未来工具')).toBe(1); // shares antigravity/gemini's primary slot
      const map = toolColorMap(['antigravity', '未来工具', '未来工具'], 'light');
      const [antigravityColor, shiftedColor] = colorsForToolsInView(['antigravity', '未来工具'], 'light');
      expect(map.get('antigravity')).toBe(antigravityColor);
      expect(map.get('未来工具')).toBe(shiftedColor);
      expect(map.get('antigravity')).not.toBe(map.get('未来工具'));
    });

    it('returns an empty map for an empty view', () => {
      expect(toolColorMap([], 'dark').size).toBe(0);
    });
  });

  // --- Contrast (carried over from T10.161, recomputed for the shared slots) ----

  // T10.187 (palette B, user decision U-4) retuned --chart-4's light value so
  // every one of the 8 slots now clears 3:1 against the bare light page, not
  // just the card/panel: the old chart-slot-4 carve-out (opencode, workbuddy
  // fell to ~2.92:1) and its "KNOWN GAP" floor test are gone. See the
  // dedicated light-page assertion below for the per-slot numbers.
  it('every chart slot keeps >= 3:1 against the T10.150 panel, popover and light-page surfaces at full opacity, in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const tool of TOOL_IDENTITIES) {
        const color = colorForTool(tool, 0, theme);
        for (const [surfaceName, surface] of Object.entries(SURFACES[theme])) {
          const ratio = contrastRatio(color, surface);
          expect(ratio, `${theme} ${tool} (${color}) vs ${surfaceName} (${surface}): ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
        }
      }
    }
  });

  it('all 8 light chart-slot colours clear 3:1 against the bare page ground #f4f5f7 (T10.187 palette B; previously chart-slot 4 alone fell to ~2.92:1)', () => {
    expect(SURFACES.light.page).toBe('#f4f5f7');
    for (const color of colorsForToolsInView(SLOT_PROBE, 'light')) {
      const ratio = contrastRatio(color, SURFACES.light.page);
      expect(ratio, `${color} vs light page: ${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('every chart-slot identity colour actually drawn with alpha (BarPanel\'s bar gradient, CostEfficiencyQuadrantPanel\'s points) clears 3:1 against its own panel, at the alpha that theme actually uses', () => {
    // Dark theme: unchanged by this round's fix — 0.96 -> 0.74 (BarPanel) and
    // 0.88 (quadrant) already cleared 3:1 before T10.178 and still do.
    for (const alpha of [0.96, 0.88, 0.74]) {
      for (const color of colorsForToolsInView(SLOT_PROBE, 'dark')) {
        const ratio = contrastRatio(composite(color, alpha, SURFACES.dark.panel), SURFACES.dark.panel);
        expect(ratio, `dark ${color} @ alpha ${alpha}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
      }
    }
    // Light theme: T10.178 review P2-2 / root R-9 — BarPanel and
    // CostEfficiencyQuadrantPanel no longer draw a tool identity colour below
    // 0.96 in the light theme (see their own component tests for the actual
    // alphaStops/opacity they pass); confirming the floor those two now use
    // actually clears 3:1 for every slot, not just the ones in the fixture.
    for (const alpha of [1, 0.96]) {
      for (const color of colorsForToolsInView(SLOT_PROBE, 'light')) {
        const ratio = contrastRatio(composite(color, alpha, SURFACES.light.panel), SURFACES.light.panel);
        expect(ratio, `light ${color} @ alpha ${alpha}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
      }
    }
  });

  it('the 8 chart slots stay pairwise clearly distinct under normal vision (CIEDE2000 >= 10) in both themes', () => {
    expect(minPairwiseDeltaE(colorsForToolsInView(SLOT_PROBE, 'dark'), 'normal')).toBeGreaterThanOrEqual(10);
    expect(minPairwiseDeltaE(colorsForToolsInView(SLOT_PROBE, 'light'), 'normal')).toBeGreaterThanOrEqual(10);
  });

  // T10.187 (palette B, user decision U-4) retuned --chart-1..8 for colour
  // vision: the CVD floor test that only guarded against regressing past
  // commit 1449e7cc's pre-U-4 values is gone (redundant, per the note that
  // used to sit on the `it.fails` case below), and that case now passes for
  // real — `.fails` deleted, this is a live guarantee.
  it(
    'every pair of the 8 slots clears T10.161\'s colour-vision bar (deutan >= 5.8, protan >= 5.4, tritan >= 3.3) ' +
    'under Machado 2009 severity-1.0 CVD simulation, in both themes (T10.187 palette B, user decision U-4)',
    () => {
      for (const theme of ['dark', 'light'] as const) {
        const colors = colorsForToolsInView(SLOT_PROBE, theme);
        expect(minPairwiseDeltaE(colors, 'deutan')).toBeGreaterThanOrEqual(5.8);
        expect(minPairwiseDeltaE(colors, 'protan')).toBeGreaterThanOrEqual(5.4);
        expect(minPairwiseDeltaE(colors, 'tritan')).toBeGreaterThanOrEqual(3.3);
      }
    },
  );

  it('the CIEDE2000 helper reproduces the Sharma 2005 reference pairs', () => {
    expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
  });

  it('all light palette colors achieve WCAG AA contrast on white background', () => {
    const white = '#ffffff';
    for (const color of PALETTE_LIGHT) {
      const ratio = contrastRatio(color, white);
      expect(ratio, `Color ${color} contrast ratio ${ratio.toFixed(2)} should be >= 3.0:1`).toBeGreaterThanOrEqual(3.0);
    }
    for (const tool of ['claude', 'opencode', 'trae', 'kilo', 'kimi', 'minimax', 'reasonix', 'antigravity', 'codex']) {
      const color = colorForTool(tool, 0, 'light');
      const ratio = contrastRatio(color, white);
      expect(ratio, `Tool ${tool} (${color}) contrast ratio ${ratio.toFixed(2)} should be >= 3.0:1`).toBeGreaterThanOrEqual(3.0);
    }
  });

  // T10.206: rank/series bars draw these palettes through barSeriesStyle's
  // default alpha gradient (0.96 near axis -> 0.74 far axis, see
  // src/utils/chartTheme.ts) in both themes, not just at full opacity — the
  // 0.74 far end is the binding constraint. Dark p3 (#5e5ce6) and light p7
  // (#0284c7) fell below 3:1 there before this round.
  it('every rank palette colour clears 3:1 against its panel at the alphas barSeriesStyle draws rank bars with, in both themes (T10.206)', () => {
    for (const alpha of [0.96, 0.74]) {
      PALETTE_DARK.forEach((color, index) => {
        const ratio = contrastRatio(composite(color, alpha, SURFACES.dark.panel), SURFACES.dark.panel);
        expect(ratio, `dark p${index + 1} ${color} @ alpha ${alpha}: ${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(3.0);
      });
      PALETTE_LIGHT.forEach((color, index) => {
        const ratio = contrastRatio(composite(color, alpha, SURFACES.light.panel), SURFACES.light.panel);
        expect(ratio, `light p${index + 1} ${color} @ alpha ${alpha}: ${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(3.0);
      });
    }
  });

  // T10.206: light p4 (#b45309) and p5 (#c2410c) used to collapse into
  // essentially one colour under deuteranopia (ΔE00 = 0.23); p5 was darkened
  // (hue/saturation unchanged) to separate them. Same floor the 8 tool slots
  // already use above (deutan >= 5.8).
  it('light rank palette p4 and p5 stay pairwise distinguishable under deuteranopia (T10.206)', () => {
    const d = deltaE00(PALETTE_LIGHT[3], PALETTE_LIGHT[4], 'deutan');
    expect(d, `p4 ${PALETTE_LIGHT[3]} vs p5 ${PALETTE_LIGHT[4]}: deutan ΔE00=${d.toFixed(2)}`).toBeGreaterThanOrEqual(5.8);
  });

  it('getPalette returns theme-specific palettes', () => {
    expect(getPalette('dark')).toEqual(PALETTE_DARK);
    expect(getPalette('light')).toEqual(PALETTE_LIGHT);
    expect(PALETTE).toEqual(PALETTE_DARK);
  });
});
