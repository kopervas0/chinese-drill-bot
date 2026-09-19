import { shuffle } from "./util.js";

const TONE_MARKS: Record<string, string[]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

const MARKED = new Map<string, { base: string; tone: number }>();
for (const [base, marks] of Object.entries(TONE_MARKS)) {
  marks.forEach((ch, tone) => MARKED.set(ch, { base, tone }));
}

export function hasTones(pinyin: string): boolean {
  return [...pinyin].some((ch) => MARKED.has(ch));
}

// Неверные варианты пиньиня: тот же слог(и), но с другим тоном.
export function toneVariants(pinyin: string, count: number): string[] {
  const chars = [...pinyin];
  const marked = chars.flatMap((ch, i) => (MARKED.has(ch) ? [i] : []));
  if (marked.length === 0) return [];

  if (marked.length === 1) {
    const i = marked[0];
    const { base, tone } = MARKED.get(chars[i])!;
    return shuffle([0, 1, 2, 3].filter((t) => t !== tone))
      .slice(0, count)
      .map((t) => {
        const copy = [...chars];
        copy[i] = TONE_MARKS[base][t];
        return copy.join("");
      });
  }

  const seen = new Set([pinyin]);
  const result: string[] = [];
  for (let attempt = 0; attempt < 60 && result.length < count; attempt++) {
    const copy = [...chars];
    const changes = Math.random() < 0.4 ? 2 : 1;
    for (const i of shuffle(marked).slice(0, changes)) {
      const { base, tone } = MARKED.get(copy[i])!;
      let next: number;
      do {
        next = Math.floor(Math.random() * 4);
      } while (next === tone);
      copy[i] = TONE_MARKS[base][next];
    }
    const variant = copy.join("");
    if (!seen.has(variant)) {
      seen.add(variant);
      result.push(variant);
    }
  }
  return result;
}
