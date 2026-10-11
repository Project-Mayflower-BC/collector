export function isColonistUrl(value, protocols = ["https:", "wss:"]) {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) &&
      (url.hostname === "colonist.io" || url.hostname.endsWith(".colonist.io"));
  } catch {
    return false;
  }
}

export function safeUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/token|auth|password|secret|cookie|session|(^|[._-])sid($|[._-])/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.href;
}
