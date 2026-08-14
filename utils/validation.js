// Shared between account registration and the public lead-capture form —
// both take a raw email off a form and need to know it is at least shaped
// like one before it is stored. Not a full RFC 5322 parser (nothing
// reasonably is); it is the same shape check <input type="email"> does in a
// browser, which matters here precisely because that HTML attribute is not
// itself a guarantee — anyone posting the form directly bypasses it, and one
// of the two paths that used to skip a server-side check as well was
// registration itself.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShaped(value) {
  return typeof value === "string" && EMAIL_RE.test(value);
}
