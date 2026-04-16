// Reference integration app for @paid-ai/embed.
// Start with: npm start (or npm run dev for watch mode).

import { createRequire } from "module";
import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";

dotenv.config({ path: ".env.local" });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3943);

// Mutable runtime config — initialised from env vars, overridable via the UI.
// Key ID, issuer, and audience are auto-fetched from the backend when possible.
const config: Record<string, string> = {
  PAID_API_BASE: process.env.PAID_API_BASE ?? "https://api.agentpaid.io",
  PAID_APP_BASE: process.env.PAID_APP_BASE ?? "https://app.paid.ai",
  PAID_API_KEY: process.env.PAID_API_KEY ?? "",
  PAID_SHARE_AUTH_SECRET: process.env.PAID_SHARE_AUTH_SECRET ?? "",
  PAID_SHARE_AUTH_ISSUER: process.env.PAID_SHARE_AUTH_ISSUER ?? "paid",
  PAID_SHARE_AUTH_AUDIENCE: process.env.PAID_SHARE_AUTH_AUDIENCE ?? "",
};

function requireConfig(name: string): string {
  const value = config[name];
  if (!value) {
    throw new Error(
      `${name} is not configured. Set it in the UI or .env.local.`,
    );
  }
  return value;
}

const app = express();
app.use(express.json());

const REQUIRED_VARS = [
  "PAID_API_BASE",
  "PAID_APP_BASE",
  "PAID_API_KEY",
  "PAID_SHARE_AUTH_SECRET",
] as const;

// Track whether the connection has been verified at least once.
let connectionVerified = false;

// Secret fields are never returned by /config — we surface a boolean
// "configured" flag instead. The raw values only live in this process's
// memory + .env.local on disk. Leaking them would be bad even for a
// localhost-only tool since a reflected XSS on this app could exfiltrate.
const SECRET_FIELDS = new Set(["PAID_API_KEY", "PAID_SHARE_AUTH_SECRET"]);

function buildConfigResponse() {
  const values: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELDS.has(key)) {
      secretsSet[key] = Boolean(value);
    } else {
      values[key] = value;
    }
  }
  return { values, secretsSet };
}

app.get("/config", (_req, res) => {
  const missingVars = REQUIRED_VARS.filter((v) => !config[v]);
  const { values, secretsSet } = buildConfigResponse();
  res.json({
    paidAppBase: config.PAID_APP_BASE,
    paidApiBase: config.PAID_API_BASE,
    ready: connectionVerified && missingVars.length === 0,
    missingVars,
    values,
    secretsSet,
  });
});

app.post("/config/reset", (_req, res) => {
  for (const key of Object.keys(config)) {
    config[key] = "";
  }
  config.PAID_SHARE_AUTH_ISSUER = "paid";
  connectionVerified = false;
  res.json({ ok: true });
});

app.post("/config", async (req, res) => {
  const allowed = Object.keys(config);
  for (const [key, value] of Object.entries(req.body ?? {})) {
    if (!allowed.includes(key) || typeof value !== "string") continue;
    // For secret fields, treat an empty string as "keep existing" — the UI
    // leaves secret inputs empty when the value is already configured so the
    // server never has to send the raw value to the browser. Users hit the
    // explicit /config/reset if they want to clear.
    if (SECRET_FIELDS.has(key) && value === "") continue;
    config[key] = value;
  }
  const missingVars = REQUIRED_VARS.filter((v) => !config[v]);
  if (missingVars.length > 0) {
    const { values, secretsSet } = buildConfigResponse();
    return res.json({
      ok: false,
      ready: false,
      missingVars,
      values,
      secretsSet,
    });
  }

  // Verify the connection actually works by hitting the backend.
  let connectionError: string | null = null;
  try {
    const r = await fetch(
      `${config.PAID_API_BASE}/api/v2/value-receipts?limit=1`,
      {
        headers: { Authorization: `Bearer ${config.PAID_API_KEY}` },
      },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      if (r.status === 401) {
        connectionError =
          "Invalid API key. Check that you copied the full key from Settings > API keys.";
      } else if (r.status === 404) {
        connectionError =
          "SDK endpoints not found. Make sure your Paid backend is up to date.";
      } else {
        connectionError =
          `API returned ${r.status}` +
          (body?.error
            ? `: ${body.error}`
            : body?.message
              ? `: ${body.message}`
              : "");
      }
    }
  } catch (err) {
    connectionError = `Cannot reach ${config.PAID_API_BASE}: ${(err as Error).message}`;
  }

  if (connectionError) {
    const { values, secretsSet } = buildConfigResponse();
    return res.json({
      ok: false,
      ready: false,
      connectionError,
      missingVars: [],
      values,
      secretsSet,
    });
  }

  // Connection verified.
  connectionVerified = true;
  const { values, secretsSet } = buildConfigResponse();
  res.json({
    ok: true,
    ready: true,
    missingVars: [],
    values,
    secretsSet,
  });
});

// Resolve a publicUrlToken to a VR id (needed by the login page to mint a valid JWT).
app.get("/api/resolve-token/:token", async (req, res) => {
  try {
    const apiBase = requireConfig("PAID_API_BASE");
    const apiKey = requireConfig("PAID_API_KEY");
    const r = await fetch(`${apiBase}/api/v2/value-receipts?limit=100`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await r.json();
    const vr = (body.data ?? []).find(
      (v: { publicUrlToken?: string }) => v.publicUrlToken === req.params.token,
    );
    if (vr) {
      res.json({ id: vr.id, customerId: vr.customerId ?? null });
    } else {
      res.status(404).json({ error: "Value receipt not found for this token" });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Mint a JWT for a given VR + customer. Exposes knobs (expired / wrong-sig /
// override claims) so you can exercise every branch of the shareAuth
// middleware without editing code.
app.post("/mint", (req, res) => {
  try {
    const secret = requireConfig("PAID_SHARE_AUTH_SECRET");
    const {
      resourceId,
      sub,
      ttlSeconds = 3600,
      resource = "value-receipt",
      forceExpired = false,
      wrongSignature = false,
      overrideAud,
      overrideIss,
    } = req.body ?? {};
    if (!sub) {
      return res.status(400).json({ error: "sub is required" });
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: overrideIss ?? (config.PAID_SHARE_AUTH_ISSUER || "paid"),
      sub,
      resource,
      iat: now,
      exp: forceExpired ? now - 60 : now + ttlSeconds,
    };
    if (resourceId) payload.resourceId = resourceId;
    const aud = overrideAud ?? config.PAID_SHARE_AUTH_AUDIENCE;
    if (aud) payload.aud = aud;
    const token = jwt.sign(
      payload,
      wrongSignature ? `${secret}-tampered` : secret,
      { algorithm: "HS256" },
    );
    res.json({ token, payload });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Verify a JWT against the backend's public VR endpoint. Returns the HTTP
// status and body so the test host UI can show whether the token is accepted.
app.post("/api/verify-jwt", async (req, res) => {
  try {
    const { token: jwtToken, publicUrlToken } = req.body ?? {};
    if (!jwtToken || !publicUrlToken) {
      return res
        .status(400)
        .json({ error: "token and publicUrlToken are required" });
    }
    const apiBase = requireConfig("PAID_API_BASE");
    const url = `${apiBase}/api/public/value-receipts/${encodeURIComponent(publicUrlToken)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const body = await r.json().catch(() => null);
    res.json({ status: r.status, ok: r.ok, body });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Proxy helper: list customers via the v2 API (supports limit & offset).
app.get("/api/customers", async (req, res) => {
  try {
    const apiBase = requireConfig("PAID_API_BASE");
    const apiKey = requireConfig("PAID_API_KEY");
    const limit = Number(req.query.limit) || 20;
    const offset = Number(req.query.offset) || 0;
    const response = await fetch(
      `${apiBase}/api/v2/customers?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = await response.json();
    res.status(response.status).json(body);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Proxy helper: list value receipts via the SDK API. Browser never sees the API key.
app.get("/api/value-receipts", async (_req, res) => {
  try {
    const apiBase = requireConfig("PAID_API_BASE");
    const apiKey = requireConfig("PAID_API_KEY");
    const response = await fetch(`${apiBase}/api/v2/value-receipts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const body = await response.json();
    res.status(response.status).json(body);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Proxy helper: publish/unpublish a value receipt via the v2 API.
app.post("/api/value-receipts/:id/:action", async (req, res) => {
  try {
    const apiBase = requireConfig("PAID_API_BASE");
    const apiKey = requireConfig("PAID_API_KEY");
    const { id, action } = req.params;
    const allowedActions = ["publish", "unpublish"];
    if (!allowedActions.includes(action)) {
      return res.status(400).json({ error: "Unknown action" });
    }
    const url = `${apiBase}/api/v2/value-receipts/${id}/${action}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body ?? {}),
    });
    const body = await response.json();
    res.status(response.status).json(body);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Login URL flow: simulates the host app's login page. In a real app this would
// show a login form; here we just auto-mint a token and redirect back.
app.get("/auth/share-login", (req, res) => {
  const redirect = req.query.redirect;
  if (typeof redirect !== "string" || !redirect) {
    return res.status(400).send("Missing ?redirect= parameter");
  }

  // Only allow redirects back to the configured Paid app host. Without this
  // check an attacker could send a victim to /auth/share-login?redirect=<evil>,
  // the login page would mint a JWT for the victim's configured customer, and
  // then redirect the token to the attacker's URL — a token-harvest open
  // redirect. Also guards against HTML/JS injection since parseable URLs can't
  // contain raw <, >, or " in their origins.
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirect);
  } catch {
    return res.status(400).send("redirect parameter is not a valid URL");
  }
  let appBaseOrigin: string;
  try {
    appBaseOrigin = new URL(config.PAID_APP_BASE).origin;
  } catch {
    return res
      .status(500)
      .send("PAID_APP_BASE is not configured or invalid");
  }
  if (redirectUrl.origin !== appBaseOrigin) {
    return res
      .status(400)
      .send(
        `redirect origin ${redirectUrl.origin} is not the configured PAID_APP_BASE (${appBaseOrigin})`,
      );
  }

  // Even after origin validation, belt-and-braces: HTML-escape for the <code>
  // display, and pass to the inline script via a data attribute rather than
  // interpolating into a JS string literal. dataset values are always plain
  // strings — no way to break out of the string context.
  const redirectHtml = escapeHtml(redirectUrl.toString());
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Test host — share auth login</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f6f7f9; color: #111827; }
    .card {
      max-width: 440px; margin: 3rem auto; background: #fff;
      border-radius: 8px; border: 1px solid #e5e7eb; padding: 1.75rem 2rem;
    }
    h2 { margin: 0 0 0.25rem; font-size: 1.15rem; }
    .subtitle { color: #6b7280; font-size: 0.85rem; line-height: 1.5; margin: 0 0 1.25rem; }
    .note {
      background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 6px;
      padding: 0.65rem 0.75rem; font-size: 0.8rem; color: #0369a1;
      line-height: 1.45; margin-bottom: 1.25rem;
    }
    label { display: block; font-size: 0.8rem; font-weight: 500; color: #6b7280; margin-bottom: 0.25rem; }
    input, select {
      width: 100%; padding: 0.5rem; border: 1px solid #d1d5db;
      border-radius: 4px; font-size: 0.9rem; margin-bottom: 1rem; font-family: inherit;
    }
    button {
      background: #111827; color: #fff; border: 0; padding: 0.6rem 1.25rem;
      border-radius: 4px; font-size: 0.9rem; cursor: pointer; font-family: inherit;
    }
    button:hover { opacity: 0.85; }
    .redirect-info {
      margin-top: 1rem; font-size: 0.75rem; color: #6b7280;
      word-break: break-all; line-height: 1.4;
    }
  </style>
</head>
<body data-redirect="${redirectHtml}">
  <div class="card">
    <h2>Test host login</h2>
    <p class="subtitle">
      This page simulates your application's login flow for the Paid share-auth
      redirect. In production, you would authenticate the user with your own auth
      system here.
    </p>
    <div class="note">
      <strong>How it works:</strong> When an unauthenticated user visits a shared
      value receipt link, Paid redirects them to this login URL. After login, this
      page mints a JWT and redirects back with the token attached.
    </div>
    <form id="f">
      <label>Customer</label>
      <div style="position:relative;margin-bottom:1rem">
        <input id="customer-search" placeholder="Search customers..." autocomplete="off"
               style="width:100%;padding:0.5rem;border:1px solid #d1d5db;border-radius:4px;font-size:0.9rem;font-family:inherit;margin:0" />
        <div id="customer-dropdown" style="display:none;position:absolute;z-index:20;left:0;right:0;top:100%;max-height:200px;overflow-y:auto;background:#fff;border:1px solid #d1d5db;border-top:0;border-radius:0 0 4px 4px;box-shadow:0 4px 12px rgba(0,0,0,0.1)"></div>
        <input type="hidden" name="sub" id="customer-value" />
      </div>
      <button type="submit">Login and redirect back</button>
    </form>
    <div class="redirect-info">
      Redirecting back to: <code>${redirectHtml}</code>
    </div>
  </div>
  <script>
    // Read the redirect target from a data attribute rather than inlining it
    // into a JS string literal — eliminates HTML/JS injection surface.
    const redirectUrl = new URL(document.body.dataset.redirect);
    const pathParts = redirectUrl.pathname.split("/");
    const publicUrlToken = pathParts[pathParts.length - 1];
    let resolvedVrId = null;
    let resolvedCustomerId = null;

    let allCustomers = [];
    const PAGE_SIZE = 20;

    async function loadAllCustomers() {
      const first = await fetch("/api/customers?limit=" + PAGE_SIZE + "&offset=0").then(r => r.json());
      allCustomers = first.data || [];
      const total = first.pagination?.total ?? allCustomers.length;
      if (total > PAGE_SIZE) {
        const fetches = [];
        for (let off = PAGE_SIZE; off < total; off += PAGE_SIZE) {
          fetches.push(fetch("/api/customers?limit=" + PAGE_SIZE + "&offset=" + off).then(r => r.json()));
        }
        const pages = await Promise.all(fetches);
        for (const p of pages) allCustomers.push(...(p.data || []));
      }
    }

    function renderDropdown(filter) {
      const dd = document.getElementById("customer-dropdown");
      const q = (filter || "").toLowerCase();
      const matches = q
        ? allCustomers.filter(c => ((c.name||"")+(c.externalId||"")+(c.id||"")).toLowerCase().includes(q))
        : allCustomers;
      if (matches.length === 0) {
        dd.innerHTML = '<div style="padding:0.5rem 0.75rem;font-size:0.85rem;color:#6b7280">No customers found</div>';
        dd.style.display = "block";
        return;
      }
      dd.innerHTML = "";
      for (const c of matches.slice(0, 50)) {
        const div = document.createElement("div");
        div.textContent = (c.name || c.id) + " (" + (c.externalId || c.id) + ")";
        div.style.cssText = "padding:0.45rem 0.75rem;font-size:0.9rem;cursor:pointer;";
        div.onmouseenter = () => div.style.background = "#f3f4f6";
        div.onmouseleave = () => div.style.background = "";
        div.onmousedown = (ev) => {
          ev.preventDefault();
          document.getElementById("customer-value").value = c.externalId || c.id;
          document.getElementById("customer-search").value = div.textContent;
          dd.style.display = "none";
        };
        // Pre-select the VR's owning customer
        if (resolvedCustomerId && c.id === resolvedCustomerId) {
          document.getElementById("customer-value").value = c.externalId || c.id;
          document.getElementById("customer-search").value = div.textContent;
        }
        dd.appendChild(div);
      }
      if (matches.length > 50) {
        const more = document.createElement("div");
        more.textContent = "+ " + (matches.length - 50) + " more — refine your search";
        more.style.cssText = "padding:0.4rem 0.75rem;font-size:0.8rem;color:#6b7280;font-style:italic;";
        dd.appendChild(more);
      }
      dd.style.display = "block";
    }

    const searchInput = document.getElementById("customer-search");
    let searchTimer = null;
    searchInput.addEventListener("focus", () => renderDropdown(searchInput.value));
    searchInput.addEventListener("blur", () => setTimeout(() => document.getElementById("customer-dropdown").style.display = "none", 150));
    searchInput.addEventListener("input", (ev) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderDropdown(ev.target.value), 100);
    });

    (async () => {
      try {
        const resolveR = await fetch("/api/resolve-token/" + encodeURIComponent(publicUrlToken));
        if (resolveR.ok) {
          const data = await resolveR.json();
          resolvedVrId = data.id;
          resolvedCustomerId = data.customerId;
        }
        await loadAllCustomers();
        // Trigger pre-selection if VR owner was resolved
        if (resolvedCustomerId) renderDropdown("");
      } catch (err) {
        searchInput.placeholder = "Failed to load customers";
      }
    })();

    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const sub = document.getElementById("customer-value").value;
      if (!sub) { alert("Search and select a customer first"); return; }
      // Use pre-resolved VR id, or resolve now if needed
      let vrId = resolvedVrId;
      if (!vrId) {
        const resolve = await fetch("/api/resolve-token/" + encodeURIComponent(publicUrlToken));
        const data = await resolve.json();
        vrId = data.id;
      }
      if (!vrId) { alert("Could not resolve value receipt"); return; }
      const r = await fetch("/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceId: vrId, sub }),
      });
      const { token } = await r.json();
      const dest = new URL(document.body.dataset.redirect);
      dest.searchParams.set("token", token);
      window.location.href = dest.toString();
    });
  </script>
</body>
</html>`);
});

// Refresh URL flow: simulates silent token refresh for embedded iframes.
// In a real app this would validate a session cookie; here we just mint.
app.post("/api/share-token/refresh", (req, res) => {
  try {
    const secret = requireConfig("PAID_SHARE_AUTH_SECRET");
    const { resourceId, sub = "c_test" } = req.body ?? {};
    if (!resourceId) {
      return res.status(400).json({ error: "resourceId is required" });
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
      iss: config.PAID_SHARE_AUTH_ISSUER || "paid",
      sub,
      resource: "value-receipt",
      resourceId,
      iat: now,
      exp: now + 3600,
    };
    if (config.PAID_SHARE_AUTH_AUDIENCE)
      payload.aud = config.PAID_SHARE_AUTH_AUDIENCE;
    const token = jwt.sign(payload, secret, { algorithm: "HS256" });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

// Serve the SDK bundle from the npm package.
const require_ = createRequire(import.meta.url);
const sdkPath = path.dirname(require_.resolve("@paid-ai/embed"));
app.use("/sdk", express.static(sdkPath));

app.listen(PORT, async () => {
  console.log(`[test-host] listening on http://localhost:${PORT}`);
  console.log(`[test-host] serving SDK from ${sdkPath}`);
  // Verify the connection on startup if env vars are present.
  if (config.PAID_API_BASE && config.PAID_API_KEY) {
    try {
      const r = await fetch(
        `${config.PAID_API_BASE}/api/v2/value-receipts?limit=1`,
        {
          headers: { Authorization: `Bearer ${config.PAID_API_KEY}` },
        },
      );
      if (r.ok) {
        connectionVerified = true;
        console.log(
          `[test-host] verified connection to ${config.PAID_API_BASE}`,
        );
      }
    } catch {
      // Not reachable yet — user will verify via the UI.
    }
  }
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => process.exit(0));
}
