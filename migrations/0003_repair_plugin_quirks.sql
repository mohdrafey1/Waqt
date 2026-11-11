-- v3: repair heartbeats stored before Waqt understood two plugin quirks.

-- 1) Browser and desktop apps send "<<LAST_LANGUAGE>>", meaning
--    "the language last used in this project".
UPDATE heartbeats SET language = COALESCE((
    SELECT x.language FROM heartbeats x
    WHERE x.project = heartbeats.project AND x.time <= heartbeats.time
      AND x.language NOT IN ('', '<<LAST_LANGUAGE>>')
    ORDER BY x.time DESC LIMIT 1
  ), '')
  WHERE language = '<<LAST_LANGUAGE>>';

-- 2) An AI model (e.g. "Opus") stored as the editor: keep it as the model,
--    and take the real editor from another heartbeat of the same AI session.
UPDATE heartbeats SET ai_model = editor
  WHERE ai_model = '' AND lower(editor) IN ('opus','sonnet','haiku','fable','mythos','gpt','gemini','gemma','qwen','deepseek','llama','mistral','codestral','devstral','grok','kimi','glm','minimax','phi','nova','composer','o');
UPDATE heartbeats SET editor = COALESCE((
    SELECT x.editor FROM heartbeats x
    WHERE x.ai_session = heartbeats.ai_session AND x.ai_session != ''
      AND x.editor != '' AND lower(x.editor) NOT IN ('opus','sonnet','haiku','fable','mythos','gpt','gemini','gemma','qwen','deepseek','llama','mistral','codestral','devstral','grok','kimi','glm','minimax','phi','nova','composer','o')
    LIMIT 1
  ), '')
  WHERE lower(editor) IN ('opus','sonnet','haiku','fable','mythos','gpt','gemini','gemma','qwen','deepseek','llama','mistral','codestral','devstral','grok','kimi','glm','minimax','phi','nova','composer','o');

-- 3) Friendlier names for what the WakaTime desktop app reports.
UPDATE heartbeats SET editor = 'Chrome' WHERE editor = 'GoogleChrome';
UPDATE heartbeats SET editor = 'Docker Desktop' WHERE editor = 'DockerDesktop';

-- Rebuild daily totals from the repaired heartbeats.
INSERT INTO settings (key, value) VALUES ('needs_rebuild', '1')
  ON CONFLICT(key) DO UPDATE SET value = '1';
