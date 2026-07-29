// Live supply chain updates.
//
// Every supply chain page opens one Server-Sent Events stream for the business
// it belongs to. Order movements repaint the status in place; chat messages are
// appended to the thread. Only a change that alters which actions are available
// reloads the page, and never while the user is mid-message.

(function () {
  var config = window.MONEYTREE_SUPPLY;
  if (!config || !config.businessId) return;

  var pill = document.getElementById("live-pill");
  var log = document.getElementById("chat-log");
  var form = document.getElementById("chat-form");
  var input = document.getElementById("chat-input");
  var send = document.getElementById("chat-send");
  var currentStatus = config.status;
  var reloading = false;

  function setPill(state, text) {
    if (!pill) return;
    pill.className = "live-pill " + state;
    pill.lastChild.textContent = " " + text;
  }

  function stamp(value) {
    return new Date(value).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  }

  function toast(text) {
    var el = document.createElement("div");
    el.className = "flash flash-success live-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  function scrollLog() {
    if (log) log.scrollTop = log.scrollHeight;
  }

  // --- Chat ---

  function renderMessage(message) {
    if (!log || log.querySelector('[data-msg-id="' + message.id + '"]')) return;

    var el = document.createElement("div");
    el.dataset.msgId = message.id;

    if (message.kind === "event") {
      el.className = "chat-event";
      el.appendChild(document.createTextNode(message.body + " "));
      var when = document.createElement("small");
      when.className = "muted";
      when.textContent = stamp(message.createdAt);
      el.appendChild(when);
    } else {
      var mine = Number(message.businessId) === Number(config.businessId);
      el.className = "chat-msg " + (mine ? "user" : "bot");

      var who = document.createElement("span");
      who.className = "chat-who";
      who.textContent =
        (message.businessName || "Someone") +
        (message.userName ? " · " + message.userName : "");
      el.appendChild(who);
      el.appendChild(document.createTextNode(message.body));

      var time = document.createElement("span");
      time.className = "chat-time";
      time.textContent = stamp(message.createdAt);
      el.appendChild(time);
    }

    log.appendChild(el);
    scrollLog();
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var body = input.value.trim();
      if (!body) return;

      input.value = "";
      send.disabled = true;

      fetch(
        "/business/" + config.businessId + "/supply/orders/" + config.orderId + "/messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: body })
        }
      )
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.message) renderMessage(data.message);
          else toast(data.error || "Message could not be sent.");
        })
        .catch(function () {
          input.value = body;
          toast("Message could not be sent — check your connection.");
        })
        .finally(function () {
          send.disabled = false;
          input.focus();
        });
    });
    scrollLog();
  }

  // --- Order movements ---

  function paintRow(row, data) {
    var badge = row.querySelector("[data-live-status]");
    if (badge) {
      badge.textContent = data.label;
      badge.className = "badge " + data.badge + " just-changed";
    }
    var icon = row.querySelector("[data-live-icon]");
    if (icon) icon.textContent = data.icon;

    var eta = row.querySelector("[data-live-eta]");
    if (eta && data.eta) {
      var prefix = data.status === "received" ? "received "
        : data.status === "delivered" ? "delivered "
        : data.status === "cancelled" || data.status === "declined" ? "closed "
        : "ETA ";
      eta.textContent = prefix + data.eta;
    }

    var late = row.querySelector("[data-live-late]");
    if (late && ["delivered", "received", "cancelled", "declined"].indexOf(data.status) >= 0) {
      late.classList.add("is-hidden");
    }
  }

  function paintDetail(data) {
    var label = document.querySelector("[data-live-label]");
    if (label) label.textContent = data.label;

    var icon = document.querySelector("[data-live-icon]");
    if (icon && icon.firstChild) icon.firstChild.textContent = data.icon + " ";

    var blurb = document.querySelector("[data-live-blurb]");
    if (blurb) blurb.textContent = data.blurb;

    var eta = document.querySelector("[data-live-eta]");
    if (eta && data.eta) eta.textContent = data.eta;

    var progress = document.querySelector("[data-live-progress]");
    if (progress) progress.style.width = data.progress + "%";
  }

  function refreshSoon() {
    if (reloading) return;
    reloading = true;
    // A draft in the box is worth more than an instant refresh.
    if (input && input.value.trim()) {
      toast("This order moved on — refresh to see the new actions.");
      reloading = false;
      return;
    }
    setTimeout(function () { window.location.reload(); }, 1200);
  }

  // --- Stream ---

  var stream = new EventSource("/business/" + config.businessId + "/supply/stream");

  stream.addEventListener("ready", function () {
    setPill("", "live");
  });

  stream.addEventListener("message", function (event) {
    var data = JSON.parse(event.data);
    if (config.orderId && Number(data.orderId) === Number(config.orderId)) {
      renderMessage(data);
    } else if (data.kind !== "event") {
      toast("New message on order #" + data.orderId);
    }
  });

  stream.addEventListener("order", function (event) {
    var data = JSON.parse(event.data);

    document
      .querySelectorAll('[data-live-order="' + data.orderId + '"]')
      .forEach(function (row) { paintRow(row, data); });

    if (config.orderId && Number(data.orderId) === Number(config.orderId)) {
      paintDetail(data);
      if (data.status !== currentStatus) {
        currentStatus = data.status;
        refreshSoon();
      }
    } else {
      toast("Order #" + data.orderId + " is now " + data.label.toLowerCase() + ".");
    }
  });

  stream.addEventListener("partner", function (event) {
    var data = JSON.parse(event.data);
    if (data.status === "pending") {
      toast((data.buyerName || "A business") + " asked to buy from you.");
    } else if (data.status === "active") {
      toast("Connection accepted by " + (data.supplierName || "your supplier") + ".");
    } else if (data.status === "removed") {
      toast((data.name || "A partner") + " disconnected.");
    }
  });

  stream.onerror = function () {
    setPill("offline", "reconnecting…");
  };
})();
