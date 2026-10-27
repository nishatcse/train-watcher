const { GoogleAuth } = require("google-auth-library");

class FcmError extends Error {
  constructor(message, { code, unregistered = false } = {}) {
    super(message);
    this.name = "FcmError";
    this.code = code;
    this.unregistered = unregistered;
  }
}

/**
 * FCM HTTP v1 with a service account kept server-side only. The legacy server key is
 * deprecated and must never be used or shipped in the APK.
 */
function createFcm({ serviceAccount, fetchImpl = fetch, authClient = null }) {
  if (!serviceAccount) return null;
  const projectId = serviceAccount.project_id;
  const auth = authClient || new GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });

  return {
    projectId,
    async send(token, data, { ttlSeconds = 600 } = {}) {
      const accessToken = await auth.getAccessToken();
      const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            // Data-only + HIGH priority: the app itself decides how loud to ring, and
            // Android delivers it even in Doze.
            android: { priority: "HIGH", ttl: `${ttlSeconds}s` },
            data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return true;
      const body = await response.json().catch(() => ({}));
      const status = body.error && body.error.status;
      const unregistered = status === "NOT_FOUND" || status === "UNREGISTERED" || (status === "INVALID_ARGUMENT" && /registration token/i.test(body.error.message || ""));
      throw new FcmError(`FCM send failed (HTTP ${response.status} ${status || ""})`, { code: status, unregistered });
    },
  };
}

module.exports = { createFcm, FcmError };
