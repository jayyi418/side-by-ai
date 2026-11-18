import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env 가 있으면 읽습니다. 없어도 기본값으로 동작합니다.
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  /* .env 없음 */
}

const env = process.env;

export function loadConfig(overrides = {}) {
  const adminPin = env.ADMIN_PIN || crypto.randomInt(100000, 999999).toString();
  return {
    root,
    port: Number(env.PORT) || 8080,
    dataDir: path.resolve(root, env.DATA_DIR || "data"),
    presetDir: path.resolve(root, "presets", env.PRESET || "vintage-shop"),
    // auto: Claude 를 쓰되 실패하면 오프라인 응대로 전환 / offline: 항상 오프라인 응대
    aiMode: env.AI_MODE === "offline" ? "offline" : "auto",
    model: env.AI_MODEL || "claude-opus-5-5",
    effort: env.AI_EFFORT || "low",
    adminPin,
    adminPinGenerated: !env.ADMIN_PIN,
    // 사장님 호출·결제 알림을 받을 주소 (ntfy 토픽 URL 등, 본문을 텍스트로 POST)
    notifyUrl: env.NOTIFY_URL || "",
    // 결제 안내: 사장님의 송금 QR 이미지 주소와 안내 문구
    paymentQrUrl: env.PAYMENT_QR_URL || "",
    paymentNote: env.PAYMENT_NOTE || "",
    sessionIdleMs: (Number(env.SESSION_IDLE_SEC) || 180) * 1000,
    ...overrides,
  };
}
