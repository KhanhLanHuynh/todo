"use strict";

const crypto = require("crypto");

const COOKIE = "dtt_session";
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required");
  return value;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || payload.exp < Date.now() || typeof payload.uid !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(/; */)) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = decodeURIComponent(part.slice(0, index).trim());
    if (key === name) return decodeURIComponent(part.slice(index + 1));
  }
  return "";
}

function cookieHeader(token, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function setSessionCookie(res, userId) {
  const token = sign({ uid: userId, exp: Date.now() + MAX_AGE_MS });
  res.setHeader("Set-Cookie", cookieHeader(token, MAX_AGE_SEC));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", cookieHeader("", 0));
}

function requireUser(req, res, next) {
  const payload = readSession(req);
  if (!payload) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  req.userId = payload.uid;
  next();
}

module.exports = { setSessionCookie, clearSessionCookie, requireUser };
