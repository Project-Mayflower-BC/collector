import { readSession } from "./db.js";
import { exportFilename, exportJson, makeExport } from "./decode.js";

// Hidden page that turns a stored recording into a blob URL for chrome.downloads.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "offscreen-export") {
    readSession(message.sessionId).then(recording => respond({ ok: true, filename: exportFilename(recording.session),
      url: URL.createObjectURL(new Blob([exportJson(makeExport(recording))], { type: "application/json" })) }),
    error => respond({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "offscreen-revoke") {
    URL.revokeObjectURL(message.url);
    respond({ ok: true });
  }
});
