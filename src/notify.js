// 사장님에게 알림을 보냅니다. NOTIFY_URL 로 본문을 텍스트 그대로 POST 하므로
// ntfy(https://ntfy.sh) 토픽 주소를 넣으면 휴대폰 푸시로 받을 수 있습니다.
// 알림이 실패해도 키오스크는 멈추지 않습니다.

export function createNotifier(url) {
  return async function notify(message) {
    console.log(`[알림] ${message}`);
    if (!url) return false;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: message,
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (err) {
      console.error(`[알림 실패] ${err.message}`);
      return false;
    }
  };
}
