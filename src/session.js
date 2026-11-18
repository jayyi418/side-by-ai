import crypto from "node:crypto";

// 손님 한 명의 방문 = 세션 하나. 대화 내용과 장바구니를 메모리에만 들고 있다가
// 결제가 끝나거나 일정 시간 조용하면 지웁니다.

export class Sessions {
  constructor(idleMs) {
    this.idleMs = idleMs;
    this.map = new Map();
  }

  get(id) {
    const now = Date.now();
    for (const [key, s] of this.map) if (now - s.touchedAt > this.idleMs) this.map.delete(key);
    let session = id && this.map.get(id);
    if (!session) {
      session = { id: crypto.randomUUID(), messages: [], cart: [], pendingTag: null, touchedAt: now };
      this.map.set(session.id, session);
    }
    session.touchedAt = now;
    return session;
  }

  end(id) {
    this.map.delete(id);
  }
}

export function cartTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function cartView(session) {
  return { sessionId: session.id, items: session.cart, total: cartTotal(session.cart) };
}

/** 등록 상품을 장바구니에 담습니다. 재고보다 많이 담으려 하면 오류를 던집니다. */
export function addProduct(session, product, quantity = 1, source = "barcode") {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("수량은 1 이상이어야 합니다.");
  const line = session.cart.find((i) => i.productId === product.id);
  const wanted = (line?.quantity || 0) + quantity;
  if (wanted > product.stock) {
    throw new Error(
      product.stock === 0
        ? `'${product.name}'은(는) 품절입니다.`
        : `'${product.name}'은(는) ${product.stock}개만 남아 있습니다.`,
    );
  }
  if (line) line.quantity = wanted;
  else {
    session.cart.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      quantity,
      source,
    });
  }
}

/** 가격표를 카메라로 읽어 담는 미등록 상품. 사장님이 나중에 확인할 수 있게 출처를 남깁니다. */
export function addTagItem(session, { name, price }) {
  session.cart.push({ productId: null, name, price, quantity: 1, source: "price_tag" });
}

export function removeLine(session, index) {
  if (Number.isInteger(index) && index >= 0 && index < session.cart.length) {
    session.cart.splice(index, 1);
  }
}
