import { Recorder } from "./recorder.js";
const recorder = new Recorder(chrome);
chrome.debugger.onEvent.addListener((source, method, params) => recorder.handle(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => recorder.detached(source, reason));
chrome.storage.onChanged.addListener((changes, area) => recorder.changed(changes, area));
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  if (!["recorder-status", "recorder-start", "recorder-stop"].includes(message?.type)) return;
  void recorder.request(message).then(respond, error => respond({ ok: false, error: String(error) }));
  return true;
});
