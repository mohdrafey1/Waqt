// Language colors follow GitHub Linguist so cards feel familiar on GitHub.
const LANGUAGE_COLORS: Record<string, string> = {
  javascript: '#f1e05a',
  jsx: '#f1e05a',
  typescript: '#3178c6',
  tsx: '#7aa2f7',
  python: '#3572A5',
  java: '#b07219',
  kotlin: '#A97BFF',
  go: '#00ADD8',
  rust: '#dea584',
  c: '#555555',
  'c++': '#f34b7d',
  'c#': '#178600',
  'objective-c': '#438eff',
  swift: '#F05138',
  dart: '#00B4AB',
  php: '#4F5D95',
  ruby: '#701516',
  html: '#e34c26',
  css: '#663399',
  scss: '#c6538c',
  sass: '#a53b70',
  less: '#1d365d',
  vue: '#41b883',
  'vue.js': '#41b883',
  svelte: '#ff3e00',
  astro: '#ff5a03',
  json: '#cbcb41',
  json5: '#267CB9',
  yaml: '#cb171e',
  toml: '#9c4221',
  xml: '#0060ac',
  markdown: '#083fa1',
  mdx: '#fcb32c',
  sql: '#e38c00',
  shell: '#89e051',
  bash: '#89e051',
  zsh: '#89e051',
  'bash script': '#89e051',
  powershell: '#012456',
  batchfile: '#C1F12E',
  dockerfile: '#384d54',
  docker: '#384d54',
  makefile: '#427819',
  lua: '#000080',
  r: '#198CE7',
  julia: '#a270ba',
  scala: '#c22d40',
  haskell: '#5e5086',
  elixir: '#6e4a7e',
  erlang: '#B83998',
  clojure: '#db5855',
  perl: '#0298c3',
  zig: '#ec915c',
  nim: '#ffc200',
  ocaml: '#ef7a08',
  'f#': '#b845fc',
  groovy: '#4298b8',
  gradle: '#02303a',
  terraform: '#7B42BC',
  hcl: '#844FBA',
  graphql: '#e10098',
  prisma: '#0c344b',
  solidity: '#AA6746',
  matlab: '#e16737',
  assembly: '#6E4C13',
  vim: '#199f4b',
  'vim script': '#199f4b',
  'emacs lisp': '#c065db',
  latex: '#3D6117',
  tex: '#3D6117',
  text: '#9198a1',
  'jupyter notebook': '#DA5B0B',
  blade: '#f7523f',
  twig: '#c1d026',
  nix: '#7e7eff',
  crystal: '#000100',
  'ini': '#d1dbe0',
  csv: '#237346',
  git: '#F44D27',
  'git config': '#F44D27',
  other: '#8b949e',
};

export const PALETTE = [
  '#8b5cf6',
  '#06b6d4',
  '#f59e0b',
  '#ef4444',
  '#10b981',
  '#ec4899',
  '#3b82f6',
  '#84cc16',
  '#f97316',
  '#14b8a6',
  '#a855f7',
  '#eab308',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorFor(dim: string, name: string, index: number): string {
  if (dim === 'languages') {
    return LANGUAGE_COLORS[name.toLowerCase()] || PALETTE[hash(name) % PALETTE.length];
  }
  return PALETTE[index % PALETTE.length];
}

export function isHex(s: string | undefined): s is string {
  return !!s && /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s);
}

function toRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Mix two hex colors. t=0 gives a, t=1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
