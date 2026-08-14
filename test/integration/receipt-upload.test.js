// A photo of a paper receipt is never a vector graphic. SVG carries a
// <script>, and this app serves an uploaded file straight back to its own
// uploader behind a link that opens it directly rather than inside an <img>
// — so accepting SVG here would be a stored-XSS route in, even though it can
// only ever hit the uploader's own session. Real HTTP multipart, per this
// project's own note that curl multipart is flaky here — fetch + FormData +
// Blob is what actually exercises multer's fileFilter.
process.env.CASHFLOW_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { closePool, dropUser, q, skipWithoutDb } from "./helpers.js";

let server;
let base;
let cookie = "";
let userId;

async function post(path, form) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual"
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith("cashflow.sid")) cookie = c.split(";")[0];
  }
  return { status: res.status, location: res.headers.get("location") };
}

async function upload(bytes, filename, mimetype) {
  const form = new FormData();
  form.append("receipt", new Blob([bytes], { type: mimetype }), filename);
  const res = await fetch(base + "/receipts/upload", {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
    redirect: "manual"
  });
  return { status: res.status, location: res.headers.get("location") };
}

describe("uploading a receipt", { skip: skipWithoutDb }, () => {
  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const email = `receipt-upload-${Date.now()}@example.test`;
    const signup = await post("/auth/register", {
      name: "Upload Test", email, password: "a good long password", currency: "KES"
    });
    assert.equal(signup.status, 302, `signup should redirect, got ${signup.status}`);
    assert.ok(cookie, "signup must set a session cookie");
    userId = (await q("SELECT id FROM users WHERE email = $1", [email]))[0].id;
  });

  after(async () => {
    await dropUser(userId);
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  test("a real image type is accepted", async () => {
    // Multer's fileFilter reads the mimetype the client declared, not the
    // bytes, so a Blob with a jpeg content-type is enough to prove the
    // accept path — content-based sniffing is a different, separate concern
    // from what this filter does.
    const r = await upload(Buffer.from([0xff, 0xd8, 0xff]), "receipt.jpg", "image/jpeg");
    assert.equal(r.status, 302);
    assert.match(r.location || "", /^\/receipts\/\d+\/review$/, "a real upload reaches the review page");

    const rows = await q("SELECT id FROM receipts WHERE user_id = $1", [userId]);
    assert.equal(rows.length, 1);
  });

  test("an SVG — even one with no script in it — is refused", async () => {
    const r = await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "receipt.svg", "image/svg+xml");
    assert.equal(r.status, 302);
    assert.equal(r.location, "/receipts", "refused uploads bounce back to the receipts page, not a review page");

    const rows = await q("SELECT id FROM receipts WHERE user_id = $1", [userId]);
    assert.equal(rows.length, 1, "still just the one from the accepted upload above — nothing was written for the SVG");
  });

  test("an SVG carrying an actual <script> is refused the same way", async () => {
    const payload = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(document.cookie)</script></svg>";
    const r = await upload(Buffer.from(payload), "receipt.svg", "image/svg+xml");
    assert.equal(r.location, "/receipts");

    const rows = await q("SELECT id FROM receipts WHERE user_id = $1", [userId]);
    assert.equal(rows.length, 1);
  });

  test("a non-image entirely is refused", async () => {
    const r = await upload(Buffer.from("not a picture"), "notes.txt", "text/plain");
    assert.equal(r.location, "/receipts");
  });
});
