// Parses the user agent the WakaTime CLI sends (shared by the Worker and the browser import), e.g.
// "wakatime/v1.130.0 (linux-6.8.0-x86_64) go1.24.4 cursor/1.2.3 vscode-wakatime/25.0.0"

export const OS_NAMES = {
  darwin: 'macOS',
  mac: 'macOS',
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
  win32: 'Windows',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  android: 'Android',
  ios: 'iOS',
  chromeos: 'ChromeOS',
};

const EDITOR_NAMES = {
  vscode: 'VS Code',
  code: 'VS Code',
  vscodium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  kiro: 'Kiro',
  trae: 'Trae',
  qoder: 'Qoder',
  zed: 'Zed',
  idea: 'IntelliJ IDEA',
  intellij: 'IntelliJ IDEA',
  intellijidea: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
  webstorm: 'WebStorm',
  phpstorm: 'PhpStorm',
  goland: 'GoLand',
  clion: 'CLion',
  rider: 'Rider',
  rubymine: 'RubyMine',
  datagrip: 'DataGrip',
  rustrover: 'RustRover',
  fleet: 'Fleet',
  androidstudio: 'Android Studio',
  studio: 'Android Studio',
  xcode: 'Xcode',
  sublime: 'Sublime Text',
  sublime_text: 'Sublime Text',
  sublimetext: 'Sublime Text',
  vim: 'Vim',
  neovim: 'Neovim',
  nvim: 'Neovim',
  emacs: 'Emacs',
  helix: 'Helix',
  atom: 'Atom',
  eclipse: 'Eclipse',
  netbeans: 'NetBeans',
  visualstudio: 'Visual Studio',
  notepadpp: 'Notepad++',
  jupyter: 'Jupyter',
  jupyterlab: 'JupyterLab',
  chrome: 'Chrome',
  firefox: 'Firefox',
  edge: 'Edge',
  safari: 'Safari',
  brave: 'Brave',
  figma: 'Figma',
  obsidian: 'Obsidian',
  postman: 'Postman',
  terminal: 'Terminal',
  bash: 'Terminal',
  zsh: 'Terminal',
  fish: 'Terminal',
  powershell: 'Terminal',
  iterm2: 'iTerm2',
  claude: 'Claude Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  copilot: 'Copilot',
  arduino: 'Arduino IDE',
  azdata: 'Azure Data Studio',
  // Names the WakaTime desktop apps report
  googlechrome: 'Chrome',
  chromium: 'Chromium',
  microsoftedge: 'Edge',
  arc: 'Arc',
  dockerdesktop: 'Docker Desktop',
  slack: 'Slack',
  notion: 'Notion',
  warp: 'Warp',
  ghostty: 'Ghostty',
  terminalapp: 'Terminal',
};

function prettyEditor(raw) {
  const key = raw.toLowerCase().replace(/-wakatime$/, '').replace(/[\s.]/g, '');
  if (EDITOR_NAMES[key]) return EDITOR_NAMES[key];
  if (!key || key === 'unknown') return '';
  return raw.replace(/-wakatime$/i, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 40);
}

// The CLI puts the AI model first for AI activity, e.g. "opus/4.1-medium claude/2.0 ...".
// ("claude/..." itself is the Claude Code editor, never a model: the CLI drops that prefix.)
export const MODEL_FAMILIES = new Set([
  'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'gpt', 'o', 'gemini', 'gemma', 'qwen', 'deepseek',
  'llama', 'mistral', 'codestral', 'devstral', 'grok', 'kimi', 'glm', 'minimax', 'phi', 'nova', 'composer',
]);

function modelToken(token) {
  if (!token) return '';
  const name = token.split('/')[0];
  // A known model family is a model whatever its version looks like ("opus/5-5", "opus/unknown").
  return MODEL_FAMILIES.has(name.toLowerCase()) ? token : '';
}

/** True when a name is really an AI model family, e.g. an editor wrongly labelled "Opus". */
export function isModelName(name) {
  return !!name && MODEL_FAMILIES.has(String(name).split(/[\s/]/)[0].toLowerCase());
}

export function prettyModelToken(token) {
  if (!token) return '';
  const [family, raw = ''] = token.split('/');
  const special = { gpt: 'GPT', o: 'o', glm: 'GLM' };
  const fam = special[family.toLowerCase()] ?? family.charAt(0).toUpperCase() + family.slice(1);
  // "5-5" is how the CLI writes 5.5 ("claude-opus-5-5" → "opus/5-5"); "unknown" means no version.
  const version = /^\d/.test(raw) ? raw.replace(/^(\d+)-(\d+)(?=$|-)/, '$1.$2') : '';
  return version ? `${fam} ${version}` : fam;
}

/** @returns {{ editor: string, os: string, model: string }} */
export function parseUserAgent(ua) {
  if (!ua) return { editor: '', os: '', model: '' };
  let os = '';
  const osMatch = ua.match(/\(([a-z0-9]+)[-)]/i);
  if (osMatch) os = OS_NAMES[osMatch[1].toLowerCase()] || osMatch[1];

  // Tokens after the "(...)" block: [goVersion, editor/version, plugin/version, ...]
  const after = ua.includes(')') ? ua.slice(ua.indexOf(')') + 1) : ua;
  const tokens = after.trim().split(/\s+/).filter((t) => t && !/^go\d/.test(t) && !/^wakatime\//.test(t));
  const model = modelToken(tokens[0]);
  if (model) tokens.shift();
  let editor = '';
  if (tokens.length > 0) {
    const first = tokens[0].split('/')[0];
    editor = prettyEditor(first);
    // Plugins that send only "name-wakatime/x" (no separate editor token)
    if (!editor && tokens[1]) editor = prettyEditor(tokens[1].split('/')[0]);
  }
  return { editor, os, model: prettyModelToken(model) };
}
