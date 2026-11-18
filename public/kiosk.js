// 손님 화면. 프레임워크 없이 브라우저 기본 기능만 씁니다.
const $ = (id) => document.getElementById(id);
const won = (n) => n.toLocaleString("ko-KR") + "원";
const GREETING = "안녕하세요! 상품이 궁금하면 말이나 글로 물어보세요. 바코드를 찍으면 바로 장바구니에 담겨요.";

let sessionId = null;
let busy = false;

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  if (data.sessionId) sessionId = data.sessionId;
  if (data.items) renderCart(data);
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---- 대화 ----
function say(who, text) {
  const bubble = el("div", "bubble " + who, text);
  $("log").append(bubble);
  $("log").scrollTop = $("log").scrollHeight;
  if (who === "clerk" && $("speak").checked && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  return bubble;
}

async function ask(text) {
  if (busy || !text.trim()) return;
  busy = true;
  say("me", text);
  const waiting = say("clerk waiting", "…");
  try {
    const data = await api("/api/chat", { text });
    waiting.remove();
    say("clerk", data.reply);
    setStatus(data.mode === "offline" ? "AI 연결이 원활하지 않아 간단한 안내만 가능합니다." : "");
  } catch (err) {
    waiting.remove();
    say("clerk", "죄송해요, 잠시 문제가 생겼어요. 다시 말씀해 주시거나 사장님 호출을 눌러 주세요.");
  } finally {
    busy = false;
  }
}

function setStatus(text) {
  $("status").textContent = text;
  $("status").hidden = !text;
}

$("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value;
  $("text").value = "";
  ask(text);
});

// ---- 음성 입력 (브라우저가 지원할 때만 버튼이 보입니다) ----
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition && window.isSecureContext) {
  const rec = new Recognition();
  rec.lang = navigator.language || "ko-KR";
  rec.onresult = (e) => ask(e.results[0][0].transcript);
  rec.onend = () => $("mic").classList.remove("on");
  rec.onerror = () => $("mic").classList.remove("on");
  $("mic").hidden = false;
  $("mic").addEventListener("click", () => {
    try {
      rec.start();
      $("mic").classList.add("on");
    } catch {
      rec.stop();
    }
  });
}

// ---- 장바구니 ----
function renderCart({ items, total }) {
  const list = $("items");
  list.replaceChildren();
  items.forEach((item, index) => {
    const li = el("li");
    const name = el("span", "name", item.name + (item.quantity > 1 ? ` ×${item.quantity}` : ""));
    if (item.source === "price_tag") name.append(el("small", null, " 가격표 인식"));
    const remove = el("button", "remove", "빼기");
    remove.addEventListener("click", () => api("/api/cart/remove", { index }));
    li.append(name, el("span", "price", won(item.price * item.quantity)), remove);
    list.append(li);
  });
  if (!items.length) list.append(el("li", "empty", "아직 담은 상품이 없어요."));
  $("total").textContent = won(total);
  $("pay").disabled = !items.length;
}

// ---- 바코드 리더기 ----
// USB/블루투스 리더기는 키보드처럼 숫자를 아주 빠르게 입력하고 Enter 를 누릅니다.
// 글자 사이 간격이 짧은 입력만 바코드로 보고, 사람이 치는 글자는 그대로 둡니다.
const SCAN_GAP_MS = 40;
let scanBuffer = "";
let lastKeyAt = 0;

document.addEventListener(
  "keydown",
  (e) => {
    const now = performance.now();
    if (now - lastKeyAt > SCAN_GAP_MS) scanBuffer = "";
    lastKeyAt = now;
    if (e.key === "Enter") {
      if (scanBuffer.length >= 4) {
        e.preventDefault();
        e.stopPropagation();
        const code = scanBuffer;
        // 입력창에 포커스가 있었다면 리더기가 넣은 글자를 지웁니다.
        const input = $("text");
        if (input.value.endsWith(code)) input.value = input.value.slice(0, -code.length);
        onScan(code);
      }
      scanBuffer = "";
    } else if (e.key.length === 1) {
      scanBuffer += e.key;
    }
  },
  true,
);

async function onScan(code) {
  try {
    const data = await api("/api/scan", { code });
    say("clerk", data.message);
  } catch (err) {
    say("clerk", err.message);
  }
}

// ---- 가격표 촬영 (바코드가 없는 상품) ----
function shrinkImage(file, maxSide = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

$("tag").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  showSheet("가격표를 읽는 중이에요…");
  try {
    const { tag } = await api("/api/scan-tag", { image: await shrinkImage(file) });
    if (!tag.found) {
      showSheet(tag.error || "가격표를 읽지 못했어요. 가격이 잘 보이게 다시 찍거나 사장님을 호출해 주세요.", [
        ["닫기", closeSheet],
      ]);
      return;
    }
    showSheet(`${tag.name}\n${won(tag.price)}\n\n가격표와 같은지 확인해 주세요.`, [
      ["맞아요, 담기", async () => { await api("/api/scan-tag/confirm"); closeSheet(); }, "primary"],
      ["아니에요", closeSheet],
    ]);
  } catch (err) {
    showSheet(err.message, [["닫기", closeSheet]]);
  }
});

// ---- 결제·호출 화면 ----
function showSheet(text, buttons = [], image = "") {
  const sheet = $("sheet");
  sheet.replaceChildren();
  if (image) {
    const img = el("img", "qr");
    img.src = image;
    img.alt = "결제 QR";
    sheet.append(img);
  }
  sheet.append(el("p", "sheet-text", text));
  const row = el("div", "row");
  for (const [label, onClick, cls] of buttons) {
    const button = el("button", cls || "", label);
    button.addEventListener("click", onClick);
    row.append(button);
  }
  sheet.append(row);
  $("overlay").hidden = false;
}
function closeSheet() {
  $("overlay").hidden = true;
}

$("pay").addEventListener("click", async () => {
  try {
    const { order, payment: pay } = await api("/api/checkout");
    const guide = pay.qrUrl
      ? "QR 을 휴대폰으로 찍어 아래 금액을 보내 주세요."
      : "매장에 안내된 방법으로 아래 금액을 결제해 주세요.";
    showSheet(
      `${guide}\n\n결제 금액 ${won(order.total)}${pay.note ? "\n" + pay.note : ""}`,
      [
        ["송금했어요", finishPayment, "primary"],
        ["취소", async () => { await api("/api/checkout/cancel"); closeSheet(); }],
      ],
      pay.qrUrl,
    );
  } catch (err) {
    showSheet(err.message, [["닫기", closeSheet]]);
  }
});

async function finishPayment() {
  try {
    await api("/api/checkout/paid");
    showSheet("감사합니다! 사장님이 입금을 확인할 거예요.\n안녕히 가세요.");
    setTimeout(() => location.reload(), 5000);
  } catch (err) {
    showSheet(err.message, [["닫기", closeSheet]]);
  }
}

$("call").addEventListener("click", async () => {
  try {
    const { sent } = await api("/api/call-owner");
    showSheet(
      sent
        ? "사장님께 알림을 보냈어요. 잠시만 기다려 주세요."
        : "호출을 기록했어요. 급하시면 매장에 적힌 연락처로 전화해 주세요.",
      [["닫기", closeSheet]],
    );
  } catch (err) {
    showSheet(err.message, [["닫기", closeSheet]]);
  }
});

// ---- 시작 ----
api("/api/session")
  .then((data) => {
    setStatus(data.aiMode === "offline" ? "AI 없이 간단 안내 모드로 동작 중입니다." : "");
    say("clerk", GREETING);
  })
  .catch(() => setStatus("서버에 연결할 수 없습니다."));
