export default {
  async fetch(request, env) {

    // Bearer authentication.
    // Set AUTH_TOKEN as a Secret for the worker
    const auth = request.headers.get("Authorization") || "";
    const expected = `Bearer ${env.AUTH_TOKEN}`;

    if (auth !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Restrict usage to the HTTP verb "POST"
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    
    const raw = await request.text();

    // Patch: grafana escape the parenthesis, that prevents the JSON in input to be valid.
    // This convert "\(" into "(" and "\)" into ")".
    const cleaned = raw
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")");

    let payload;
    try {
      payload = JSON.parse(cleaned);
    } catch {
      // Uncomment the following line for debugging purpose only, to see the payload send by Grafana in the worker logs
      //console.log("RAW BODY >>>", raw);
      return new Response("Invalid JSON", { status: 400 });
    }

    // JSONify function for KV structures send by Grafana
    function parseKvString(str) {
      if (!str || typeof str !== "string") return {};
      const out = {};
      for (const part of str.split(",")) {
        const p = part.trim();
        if (!p) continue;
        const idx = p.indexOf("=");
        if (idx === -1) {
          out[p] = "";
        } else {
          const key = p.slice(0, idx).trim();
          const val = p.slice(idx + 1).trim();
          out[key] = val;
        }
      }
      return out;
    }

    // Extract status
    const status = payload.status || "unknown";

    
    const alertsFiring = Array.isArray(payload.alerts_firing)
      ? payload.alerts_firing
      : [];

    const alertsResolved = Array.isArray(payload.alerts_resolved)
      ? payload.alerts_resolved
      : [];

    let sourceAlerts;
    if (status === "firing" && alertsFiring.length) {
      sourceAlerts = alertsFiring;
    } else if (status === "resolved" && alertsResolved.length) {
      sourceAlerts = alertsResolved;
    } else if (alertsFiring.length) {
      sourceAlerts = alertsFiring;
    } else {
      sourceAlerts = alertsResolved;
    }

    const alert = sourceAlerts[0] || {};

    const labels = parseKvString(alert.labels);
    const annotations = parseKvString(alert.annotations);

    // Extract alert name
    const alertname = labels.alertname || "Unknown alert";

    // Extract summary
    const summary = annotations.summary || "No summary provided";

    // Extract dashboard_url
    const dashboardURL = alert.dashboard_url || null;

    // Extract silence_url
    const silenceURL = alert.silence_url || null;

    const isFiring = status === "firing";

    const body =
      `${alertname} is **${isFiring ? "firing" : "resolved"}**\n` +
      `(${summary}).`;

    // Extract tags
    const tags = isFiring ? "red_circle" : "green_circle";

    // Build ntfy URL
    const topic = env.TOPIC;;
    const ntfyUrl = `https://ntfy.sh/${topic}`;

    const headers = {
      "Title": `Grafana alert (${status})`,
      "Priority": "default",
      "Markdown": "yes",
      "Tags": tags,
      "Content-Type": "text/plain; charset=utf-8",
    };

    const actions = [];

    if (dashboardURL) {
      actions.push(`view,Dashboard,${dashboardURL},clear=false`);
    }

    if (silenceURL) {
      actions.push(`view,Silence alert,${silenceURL},clear=true`);
    }

    if (actions.length > 0) {
      headers["Actions"] = actions.join(";");
    }

    await fetch(ntfyUrl, {
      method: "POST",
      headers,
      body,
    });

    return new Response("OK", { status: 200 });
  },
};
