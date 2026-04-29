// allocation-agent operator dashboard — Netlify-served static, talks to the
// Render API. Identity is sent as `X-Mock-Tailscale-User` (the API gates this
// header on `ALLOW_MOCK_AUTH`); when `ALLOW_MOCK_AUTH` is off in production,
// requests fall through unauthenticated and the API returns 401 if
// `REQUIRE_AUTH=true`.

(() => {
  const apiBase =
    localStorage.getItem("apiBase") ||
    document.querySelector('meta[name="api-base"]').content;
  const flowerBase =
    localStorage.getItem("flowerBase") ||
    document.querySelector('meta[name="flower-base"]').content;

  const $ = (id) => document.getElementById(id);

  $("flower-link").href = flowerBase;
  $("docs-link").href = apiBase + "/docs";

  // Identity: persisted across refreshes via localStorage.
  const emailInput = $("mock-email");
  emailInput.value = localStorage.getItem("mockEmail") || "";

  function jwtPayload(token) {
    try { return JSON.parse(atob(token.split(".")[1])); } catch { return null; }
  }
  function jwtIsLive(token) {
    const p = jwtPayload(token);
    return p && p.exp && p.exp * 1000 > Date.now();
  }

  function setSignedIn(on, email) {
    $("signin-google").hidden = on;
    $("signout").hidden = !on;
    $("mock-fallback").hidden = on;
    if (on && email) {
      $("me").textContent = "Signed in as " + email;
      $("me").className = "";
    }
  }

  // Boot: if a fresh JWT exists, prefer it as identity.
  const jwt = localStorage.getItem("jwt");
  if (jwt && jwtIsLive(jwt)) {
    const p = jwtPayload(jwt);
    if (p && p.email) {
      localStorage.setItem("mockEmail", p.email);
      setSignedIn(true, p.email);
    }
  } else if (jwt) {
    localStorage.removeItem("jwt"); // expired
  }

  $("signin-google").addEventListener("click", () => {
    sessionStorage.setItem("oauthReturnTo", location.pathname);
    const state = Math.random().toString(36).slice(2);
    const redirectUri = location.origin + "/dashboard/auth-callback.html";
    location.assign("/api/auth/authorize?redirect_uri=" + encodeURIComponent(redirectUri) + "&state=" + state);
  });

  $("signout").addEventListener("click", () => {
    localStorage.removeItem("jwt");
    localStorage.removeItem("mockEmail");
    setSignedIn(false);
    refresh();
  });

  $("apply-identity").addEventListener("click", () => {
    const v = emailInput.value.trim();
    if (v) {
      localStorage.setItem("mockEmail", v);
    } else {
      localStorage.removeItem("mockEmail");
    }
    refresh();
  });

  function fetchJSON(path) {
    const headers = {};
    const mock = localStorage.getItem("mockEmail");
    if (mock) headers["X-Mock-Tailscale-User"] = mock;
    return fetch(apiBase + path, { headers }).then((r) => {
      if (!r.ok) throw new Error(path + " → HTTP " + r.status);
      return r.json();
    });
  }

  function setStatus(text, cls) {
    const el = $("status-pill");
    el.textContent = text;
    el.className = "pill " + cls;
  }

  function renderQueues(data) {
    const el = $("queues");
    el.innerHTML = Object.entries(data.queues || {})
      .map(([name, depth]) => {
        const display = depth === null || depth === undefined ? "—" : depth;
        const cls =
          depth === null || depth === undefined
            ? "dim"
            : depth > 50
            ? "hot"
            : "";
        return `<div class="card"><div class="label">${name}</div><div class="value ${cls}">${display}</div></div>`;
      })
      .join("");
  }

  function renderWorkers(data) {
    const el = $("workers");
    const hosts = Object.entries(data.workers || {});
    if (!hosts.length) {
      el.innerHTML =
        '<div class="card"><div class="label">No workers responding</div><div class="value dim">0</div></div>';
      return;
    }
    el.innerHTML = hosts
      .map(
        ([host, w]) => `
        <div class="card">
          <div class="label">${host}</div>
          <div class="value">${w.active}<span class="muted" style="font-size:0.8rem;font-weight:400"> active</span></div>
          <div class="muted">${w.registered_tasks} tasks registered</div>
        </div>`
      )
      .join("");
  }

  function renderOutcomes(rows) {
    const counts = (rows || []).reduce((acc, o) => {
      acc[o.status] = (acc[o.status] || 0) + 1;
      return acc;
    }, {});
    const summary = Object.keys(counts)
      .sort()
      .map((k) => `${k}: ${counts[k]}`)
      .join(" · ");
    $("rollup").textContent = (rows || []).length
      ? "Batch summary — " + summary
      : "No outcomes yet.";
    $("rows").innerHTML = (rows || [])
      .map((o) => {
        const cls = ["submitted", "error", "captcha", "blocked", "needs_auth", "skipped"].includes(o.status)
          ? o.status
          : "error";
        return `<tr>
          <td>${o.candidate_id}</td>
          <td>${o.job_id}</td>
          <td>${o.ats}</td>
          <td><span class="pill ${cls}">${o.status}</span></td>
          <td>${o.finished_at || ""}</td>
        </tr>`;
      })
      .join("");
  }

  async function refresh() {
    try {
      const [me, h, q, w, rows] = await Promise.all([
        fetchJSON("/api/auth/me"),
        fetchJSON("/api/health"),
        fetchJSON("/api/queues"),
        fetchJSON("/api/workers"),
        fetchJSON("/api/outcomes?limit=50"),
      ]);

      $("me").textContent = me.authenticated
        ? `${me.login} (${me.source})`
        : "not authenticated";
      $("me").className = me.authenticated ? "" : "muted";

      const ok = h.ok && h.redis;
      setStatus(ok ? "ok" : "degraded", ok ? "submitted" : "captcha");

      renderQueues(q);
      renderWorkers(w);
      renderOutcomes(rows);

      $("fetched").textContent =
        "Last refresh: " + new Date().toLocaleTimeString() +
        " · API: " + apiBase;
    } catch (e) {
      setStatus("offline: " + e.message, "error");
      $("fetched").textContent = "API: " + apiBase + " (unreachable)";
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
