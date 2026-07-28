/**
 * "Quiet Guardian" design tokens — the Admin Dashboard's visual identity.
 *
 * Deliberately distinct from generic AI-SaaS defaults: no near-black +
 * neon accent, no warm-cream + terracotta serif, no broadsheet hairline
 * grid. This is a family-safety product — the palette reads as calm and
 * trustworthy (deep teal-ink, sage green) rather than clinical/alarmed
 * (no red/black surveillance aesthetic) or saccharine (no pastel/candy
 * "kids app" look — the *parent* is the user here).
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#1B2422', // primary text
          soft: '#3A453F', // secondary text
        },
        guardian: {
          // Deep teal-ink — primary brand surface (sidebar, dark sections)
          950: '#0F1E1B',
          900: '#16302C',
          700: '#234A42',
          500: '#3D6D61',
        },
        sage: {
          // Growth / safety accent — used for positive states, primary actions
          600: '#5B7955',
          500: '#6F8F6A',
          400: '#8FAB89',
          100: '#E4EBE1',
        },
        amber: {
          // Sparse highlight accent — CTAs, active states. NOT terracotta.
          600: '#B98527',
          500: '#D9A441',
          100: '#F7ECD2',
        },
        brick: {
          // Muted alert red — reserved ONLY for real risk/danger states.
          600: '#8F3B31',
          500: '#B54B3F',
          100: '#F3DEDA',
        },
        sand: {
          // Warm off-white background with a green undertone (not cliché cream)
          50: '#F3F4EF',
          100: '#EAEBE2',
          200: '#DCDED2',
        },
      },
      fontFamily: {
        display: ['"Fraunces"', 'Georgia', 'serif'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        card: '14px',
      },
      boxShadow: {
        // Soft, low-elevation — this product does not use glossy SaaS shadows.
        quiet: '0 1px 2px rgba(22, 48, 44, 0.06), 0 4px 12px rgba(22, 48, 44, 0.05)',
      },
    },
  },
  plugins: [],
};
