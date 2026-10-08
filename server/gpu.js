import { logEvent } from './logger.js';

// Client for an external GPU broker's lease API (the "broker" backend). The
// broker owns llama-server and ComfyUI, possibly shared with other apps on the
// same machine; Bragi borrows the GPU one lease at a time:
//
//   POST /v1/gpu/leases -> held-open NDJSON stream
//     queued* -> granted -> ping* -> (revoked | stream end)
//
// Releasing a lease = closing the connection.

export function brokerUrl(config) {
  return String(config.gpuBroker?.url ?? 'http://127.0.0.1:7710').replace(/\/+$/, '');
}

// Renders go through the broker only when comfyui.via is "broker".
export function comfyViaBroker(config) {
  return config.comfyui?.via === 'broker';
}

function notRunning(config) {
  return new Error(`The GPU broker is not running at ${brokerUrl(config)}`);
}

// The lease ended under us (revoked or lost) — the caller should wait for a
// new one and carry on, not report an error.
export function preemptedError(reason) {
  const err = new Error(`GPU lease revoked${reason ? `: ${reason}` : ''}`);
  err.preempted = true;
  return err;
}

class Lease {
  constructor({ id, baseUrl, profile, controller }) {
    this.id = id;
    this.baseUrl = baseUrl;
    this.profile = profile;
    this.isRevoked = false;
    this.revokeReason = null;
    this._controller = controller;
    this._callbacks = [];
    // Aborted on revoke or release: pass it to requests made under the lease.
    this._abort = new AbortController();
    this.signal = this._abort.signal;
    this.revoked = new Promise((resolve) => this._callbacks.push(resolve));
  }

  // Runs right away if the lease is already gone.
  onRevoke(cb) {
    if (this.isRevoked) cb(this.revokeReason);
    else this._callbacks.push(cb);
  }

  _revoke(reason) {
    if (this.isRevoked) return;
    this.isRevoked = true;
    this.revokeReason = reason;
    this._abort.abort(preemptedError(reason));
    for (const cb of this._callbacks.splice(0)) {
      try {
        cb(reason);
      } catch (err) {
        console.warn('[gpu] revoke callback failed:', err.message);
      }
    }
  }

  release() {
    if (!this._released) logEvent('engine', `GPU lease ${this.id} released`);
    this._released = true;
    this._controller.abort();
    this._revoke('released');
  }
}

// Split a fetch body into parsed NDJSON objects.
async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        console.warn('[gpu] ignoring malformed lease line:', line.slice(0, 200));
      }
    }
  }
}

// Wait for a lease. Resolves on "granted" with a Lease; rejects on "failed",
// a 400, an unreachable broker, or when `signal` aborts (err.aborted).
// onQueued(holder) is called while another workload holds the GPU. `urgent`
// marks work the user asked for and is waiting on (the broker may then let it
// skip ahead).
export async function acquire(
  config,
  { workload, profile, controlVectors, purpose, urgent, signal, onQueued } = {},
) {
  const controller = new AbortController();
  const aborted = () => {
    const err = new Error('Stopped waiting for the GPU');
    err.aborted = true;
    return err;
  };
  if (signal?.aborted) throw aborted();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const body = { workload, client: 'bragi', purpose: purpose ?? null, urgent: Boolean(urgent) };
  if (workload === 'llm') {
    body.profile = profile ?? 'bragi';
    if (body.profile === 'bragi') body.control_vectors = (controlVectors ?? []).filter(Boolean);
  }
  logEvent('engine', `requesting GPU lease (${workload}${body.profile ? `/${body.profile}` : ''})`, body);

  let res;
  try {
    res = await fetch(`${brokerUrl(config)}/v1/gpu/leases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    signal?.removeEventListener('abort', onAbort);
    if (signal?.aborted) throw aborted();
    throw notRunning(config);
  }
  if (!res.ok) {
    signal?.removeEventListener('abort', onAbort);
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 300);
    try {
      message = JSON.parse(text).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(`The GPU broker refused the lease (${res.status}): ${message}`);
  }

  // Iterated by hand: breaking out of a for-await would close the stream.
  const lines = readLines(res.body);
  let lease = null;
  try {
    while (!lease) {
      const { value: msg, done } = await lines.next();
      if (done) break;
      if (msg.event === 'queued') {
        logEvent('engine', `GPU lease queued behind ${msg.holder ?? '?'}`);
        onQueued?.(msg.holder ?? null);
      } else if (msg.event === 'granted') {
        lease = new Lease({
          id: msg.lease,
          baseUrl: String(msg.base_url ?? '').replace(/\/+$/, ''),
          profile: msg.profile ?? null,
          controller,
        });
        logEvent('engine', `GPU lease ${lease.id} granted (${workload}) -> ${lease.baseUrl}`);
      } else if (msg.event === 'failed') {
        throw new Error(`The GPU broker could not start ${workload}: ${msg.error ?? 'unknown error'}`);
      }
      // ping: keep-alive, nothing to do
    }
  } catch (err) {
    controller.abort();
    if (signal?.aborted) throw aborted();
    if (err.name === 'AbortError' || err.name === 'TypeError') throw notRunning(config);
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (!lease) {
    controller.abort();
    if (signal?.aborted) throw aborted();
    throw new Error('The GPU broker closed the lease before granting it');
  }

  // Keep reading in the background: a revocation (or the stream dropping)
  // ends the lease.
  (async () => {
    try {
      for await (const msg of lines) {
        if (msg.event === 'revoked') {
          logEvent('engine', `GPU lease ${lease.id} revoked: ${msg.reason ?? ''}`);
          lease._revoke(msg.reason ?? 'revoked');
        } else if (msg.event === 'failed') {
          lease._revoke(msg.error ?? 'failed');
        }
      }
      lease._revoke('lease stream ended');
    } catch {
      lease._revoke('lease connection lost');
    }
  })();
  return lease;
}
