(() => {
  const BRIDGE_KEY = "__lighthouseUnverifiedLinkAlertBridge__";
  if (window[BRIDGE_KEY]) return;
  window[BRIDGE_KEY] = true;

  function normalizeTweetUrl(url) {
    const match = String(url || "").match(/https:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/i);
    return match ? match[0].replace("twitter.com", "x.com") : "";
  }

  function publishTargetTweetUrl(url) {
    const tweetUrl = normalizeTweetUrl(url);
    if (!tweetUrl) return;
    window.dispatchEvent(new CustomEvent("lighthouse-target-tweet-url", {
      detail: { tweetUrl }
    }));
  }

  // Deliberate risk acceptance (reviewed 2026-09-11): auto-dismiss ONLY the
  // platform's "unverified link" warning so an accepted order is not blocked
  // by a modal the user cannot see in time. Every other alert() still shows.
  // If Lighthouse adds further safety warnings, widen the match only after a
  // conscious decision — this bridge exists to skip a warning on purpose.
  const nativeAlert = window.alert.bind(window);
  window.alert = (message) => {
    const text = String(message || "");
    if (/此推文含有未经验证的链接[\s\S]*KOL\s*接单时仔细分辨/.test(text)) {
      window.dispatchEvent(new CustomEvent("lighthouse-unverified-link-alert-dismissed"));
      return;
    }
    return nativeAlert(message);
  };

  // Lighthouse opens the target post with window.open(). When a click was
  // initiated by an extension content script Chrome may block that popup, but
  // the URL is still available here in the page's main world. The background
  // worker can then create the same exact tab after the official five-second
  // wait instead of abandoning the already locked order.
  const nativeOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    publishTargetTweetUrl(url);
    return nativeOpen(url, target, features);
  };

  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (anchor) publishTargetTweetUrl(anchor.href);
  }, true);
})();
