export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* keep status code */
    }
    throw new Error(message);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Live server-state stream; reconnects automatically (EventSource behavior).
export function subscribeState(onState) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => onState(JSON.parse(e.data));
  return () => es.close();
}
