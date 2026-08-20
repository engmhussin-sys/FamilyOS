import { useEffect, useState } from 'react';

export type VizMode = 'light' | 'dark';

/**
 * Which set of validated steps the charts draw with.
 *
 * Dark mode is SELECTED, not flipped: `vizTokens` carries its own dark
 * steps, validated against the dark surface `#1F1C18`. An automatic
 * inversion of the light palette would land outside the dark lightness
 * band and below 3:1 on that surface — which is exactly what the
 * validator caught for amber `#D98E12` (L 0.706).
 *
 * Resolution order matches the dataviz palette guidance: an explicit
 * `data-theme` on the document element wins both ways, and the OS
 * preference is the fallback.
 */
export function resolveVizMode(root: HTMLElement, prefersDark: boolean): VizMode {
  const stamped = root.getAttribute('data-theme');
  if (stamped === 'dark') return 'dark';
  if (stamped === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

export function useVizMode(): VizMode {
  const [mode, setMode] = useState<VizMode>(() => {
    if (typeof window === 'undefined') return 'light';
    return resolveVizMode(document.documentElement, window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  });

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const recompute = () => setMode(resolveVizMode(document.documentElement, media?.matches ?? false));

    media?.addEventListener?.('change', recompute);
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      media?.removeEventListener?.('change', recompute);
      observer.disconnect();
    };
  }, []);

  return mode;
}
