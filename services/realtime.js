// Live updates for the supply chain, over Server-Sent Events.
//
// Every open supply chain page holds one GET stream, registered here against
// the business it is watching. Order and chat activity is published to both
// businesses on the order, so buyer and supplier see the same thing at the
// same moment without polling.
//
// State is per-process and deliberately in memory: nothing here is worth
// persisting, and a dropped connection simply reconnects (EventSource retries
// on its own) and re-reads the page.

const channels = new Map(); // businessId -> Set of open responses
const HEARTBEAT_MS = 25000;

// Writing to a socket the client already dropped throws, and inside the
// heartbeat timer that would take the process down — so every write is guarded.
function push(res, frame) {
  try {
    res.write(frame);
  } catch {
    // Client vanished mid-write; the close handler cleans up.
  }
}

function write(res, event, payload) {
  push(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// Attach a response as a live listener for one business. Returns a function
// that closes the stream down.
export function subscribe(businessId, res) {
  const key = Number(businessId);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Tell nginx-style proxies not to buffer this response.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Reconnect delay the browser should use if the connection drops.
  push(res, "retry: 3000\n\n");
  write(res, "ready", { businessId: key, at: new Date().toISOString() });

  if (!channels.has(key)) {
    channels.set(key, new Set());
  }
  channels.get(key).add(res);

  // Comment frames keep proxies and idle timeouts from closing the stream.
  const heartbeat = setInterval(() => push(res, ": ping\n\n"), HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    const set = channels.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        channels.delete(key);
      }
    }
  };

  res.on("close", close);
  return close;
}

// Push an event to every listener of the given businesses (duplicates are
// collapsed, so a business trading with itself is notified once).
export function publish(businessIds, event, payload) {
  const targets = new Set(
    (Array.isArray(businessIds) ? businessIds : [businessIds])
      .map(Number)
      .filter(Boolean)
  );

  for (const id of targets) {
    const listeners = channels.get(id);
    if (!listeners) continue;
    for (const res of listeners) {
      write(res, event, payload);
    }
  }
}

export function listenerCount(businessId) {
  return channels.get(Number(businessId))?.size || 0;
}
