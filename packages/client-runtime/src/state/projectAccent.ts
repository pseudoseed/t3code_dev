/**
 * Stable per-project accent colors for the sidebar.
 *
 * Projects carry no color in the data model, so the color is derived from the
 * project key. The derivation must be pure and identical on web and mobile:
 * the same project has to land on the same hue on every surface, and across
 * restarts, without a round trip to the server.
 */

/**
 * Hand-picked hues rather than `hash % 360`. An unconstrained hue lands in the
 * muddy yellow-green band often enough to look like a bug, and neighbouring
 * hues become indistinguishable at 13px. These twelve stay apart from each
 * other and keep their identity against both sidebar surfaces.
 */
const ACCENT_HUES = [212, 265, 320, 348, 18, 40, 62, 142, 168, 190, 238, 292] as const;

export interface ProjectAccentColors {
  readonly hue: number;
  /** Project name text. */
  readonly text: string;
  /** Section rule / divider under the project header. */
  readonly line: string;
  /** Section container fill. Very low alpha: it sits behind thread rows. */
  readonly tint: string;
}

export interface ProjectAccent {
  readonly hue: number;
  readonly light: ProjectAccentColors;
  readonly dark: ProjectAccentColors;
}

/** FNV-1a. Small, dependency-free, and well spread over short ASCII keys. */
function hashProjectKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function projectAccentHue(projectKey: string): number {
  return ACCENT_HUES[hashProjectKey(projectKey) % ACCENT_HUES.length]!;
}

/**
 * Colors for one project key. Both schemes are returned together so a caller
 * can hand them to CSS custom properties once instead of re-deriving on every
 * theme change.
 */
export function projectAccent(projectKey: string): ProjectAccent {
  const hue = projectAccentHue(projectKey);
  return {
    hue,
    light: {
      hue,
      // Dark and desaturated enough to stay readable as bold text on a light
      // sidebar; the hue still reads at a glance.
      text: `hsl(${hue} 62% 38%)`,
      line: `hsl(${hue} 62% 38% / 0.28)`,
      tint: `hsl(${hue} 62% 38% / 0.05)`,
    },
    dark: {
      hue,
      text: `hsl(${hue} 72% 72%)`,
      line: `hsl(${hue} 72% 72% / 0.26)`,
      tint: `hsl(${hue} 72% 72% / 0.06)`,
    },
  };
}
