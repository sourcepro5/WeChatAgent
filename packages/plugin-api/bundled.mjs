// Only these reviewed first-party packages belong in source/installer releases.
export const BUNDLED_PLUGINS = Object.freeze([
  Object.freeze({id: 'chat-notes', version: '1.1.0', source: 'examples/plugins/chat-notes', files:['README.md','index.mjs','plugin.json','ui.json','ui/page.html','ui/page.js','ui/settings.html','ui/settings.js','ui/style.css']}),
  Object.freeze({id: 'fish-notebook', version: '1.1.1', source: 'optional-extensions/fish-notebook', zip: 'optional-extensions/packages/fish-notebook-1.1.1.zip', files:['README.md','index.mjs','lib/notebook.mjs','plugin.json','ui.json','ui/page.html','ui/page.js','ui/style.css']}),
  Object.freeze({id: 'speech-recognition', version: '1.5.0', source: 'optional-extensions/speech-recognition', zip: 'optional-extensions/packages/speech-recognition-1.5.0.zip', files:['README.md','index.mjs','lib/recognize.mjs','lib/presets.mjs','lib/diagnostics.mjs','lib/settings-actions.mjs','plugin.json','ui.json','ui/settings.html','ui/settings.js','ui/style.css','assets/config-test.wav']}),
]);
