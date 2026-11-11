// Parses the user agent the WakaTime CLI sends, e.g.
// "wakatime/v1.130.0 (linux-6.8.0-x86_64) go1.24.4 cursor/1.2.3 vscode-wakatime/25.0.0"

const OS_NAMES: Record<string, string> = {
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

const EDITOR_NAMES: Record<string, string> = {
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
};

function prettyEditor(raw: string): string {
  const key = raw.toLowerCase().replace(/-wakatime$/, '').replace(/[\s.]/g, '');
  if (EDITOR_NAMES[key]) return EDITOR_NAMES[key];
  if (!key || key === 'unknown') return '';
  return raw.replace(/-wakatime$/i, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 40);
}

// The CLI puts the AI model first for AI activity, e.g. "opus/4.1-medium claude/2.0 ...".
// ("claude/..." itself is the Claude Code editor, never a model: the CLI drops that prefix.)
const MODEL_FAMILIES = new Set([
  'opus', 'sonnet', 'haiku', 'fable', 'mythos', 'gpt', 'o', 'gemini', 'gemma', 'qwen', 'deepseek',
  'llama', 'mistral', 'codestral', 'devstral', 'grok', 'kimi', 'glm', 'minimax', 'phi', 'nova', 'composer',
]);

function modelToken(token: string | undefined): string {
  if (!token) return '';
  const [name, version] = token.split('/');
  if (!version || !/^\d/.test(version)) return '';
  return MODEL_FAMILIES.has(name.toLowerCase()) ? token : '';
}

export function prettyModelToken(token: string): string {
  if (!token) return '';
  const [family, version = ''] = token.split('/');
  const special: Record<string, string> = { gpt: 'GPT', o: 'o', glm: 'GLM' };
  const fam = special[family.toLowerCase()] ?? family.charAt(0).toUpperCase() + family.slice(1);
  return version ? `${fam} ${version}` : fam;
}

export function parseUserAgent(ua: string): { editor: string; os: string; model: string } {
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
