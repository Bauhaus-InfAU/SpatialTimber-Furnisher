/**
 * Seeded pseudo-random number generator (mulberry32).
 * Produces identical sequences for a given integer seed —
 * equivalent to Python's random.seed(n) for our purposes.
 */
export function makePrng(seed: number) {
  let s = seed >>> 0;

  function next(): number {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    /** random float in [0, 1) */
    random(): number { return next(); },

    /** random float in [min, max) */
    uniform(min: number, max: number): number { return min + next() * (max - min); },

    /** random integer in [min, max] inclusive */
    randint(min: number, max: number): number { return Math.floor(min + next() * (max - min + 1)); },

    /** random element from array */
    choice<T>(arr: T[]): T { return arr[Math.floor(next() * arr.length)]; },
  };
}

export type Prng = ReturnType<typeof makePrng>;
