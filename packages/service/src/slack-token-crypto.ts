import crypto from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const VERSION = "v1";

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

export function parseSlackTokenEncryptionKey(value: string | undefined): Buffer | null {
  if (value === undefined || value === "") return null;
  const key = decodeCanonicalBase64(value, "FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY");
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("FEATURE_REC_SLACK_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptSlackToken(input: {
  token: string;
  teamId: string;
  key: Buffer;
  iv?: Buffer;
}): string {
  if (!input.token) throw new Error("Slack bot token must not be empty");
  if (!input.teamId) throw new Error("Slack team ID must not be empty");
  if (input.key.byteLength !== KEY_BYTES) throw new Error("Slack token encryption key is invalid");
  const iv = input.iv ?? crypto.randomBytes(IV_BYTES);
  if (iv.byteLength !== IV_BYTES) throw new Error(`Slack token IV must be ${IV_BYTES} bytes`);

  const cipher = crypto.createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.teamId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(input.token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSlackToken(input: {
  envelope: string;
  teamId: string;
  key: Buffer;
}): string {
  if (input.key.byteLength !== KEY_BYTES) throw new Error("Slack token encryption key is invalid");
  const parts = input.envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Slack bot token ciphertext has an unsupported envelope");
  }
  const iv = decodeCanonicalBase64(parts[1], "Slack bot token IV");
  const authTag = decodeCanonicalBase64(parts[2], "Slack bot token auth tag");
  const ciphertext = decodeCanonicalBase64(parts[3], "Slack bot token ciphertext");
  if (iv.byteLength !== IV_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
    throw new Error("Slack bot token ciphertext has invalid parameters");
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", input.key, iv);
  decipher.setAAD(Buffer.from(input.teamId, "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
