import type { WidgetSettings } from './growth.util';

export interface WidgetScriptConfig {
    key: string;
    /** This API's public base, e.g. https://api.example.com/api/v1. */
    api: string;
    /** The button's short link; it redirects to wa.me and counts the click. */
    chatUrl: string | null;
    storeName: string;
    settings: WidgetSettings;
}

/**
 * The script a merchant pastes into their site:
 *   <script src="https://…/api/v1/widget/KEY.js" async></script>
 * A floating WhatsApp button, an optional greeting bubble, and an optional
 * number-capture pop-up with an explicit consent checkbox, whose last step
 * (unless turned off) is a button that sends the sign-up's code on WhatsApp.
 * It lives in a shadow root so the site's CSS cannot reach it, writes every
 * merchant text with textContent (never as HTML), sends sign-ups
 * form-encoded (no CORS preflight) and remembers per visitor, in
 * localStorage, that the pop-up was shown or the greeting dismissed.
 */
export function widgetScript(config: WidgetScriptConfig): string {
    // JSON inside a script: "<" escaped so "</script>" in a setting cannot close it.
    const json = JSON.stringify(config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `/* Collabo chat widget */
(function () {
  if (window.__collaboWidget) return;
  window.__collaboWidget = true;
  var C = ${json};
  var B = C.settings.button, P = C.settings.popup;
  var store = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  var DAY = 86400000, side = B.position === 'left' ? 'left' : 'right';
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
  function beacon(type) { try { var d = new URLSearchParams({ type: type }); if (navigator.sendBeacon) navigator.sendBeacon(C.api + '/widget/' + C.key + '/event', d); } catch (e) {} }

  function mount() {
    if (B.hideOnMobile && window.matchMedia && window.matchMedia('(max-width: 640px)').matches && !P.enabled) return;
    var host = el('div'); host.setAttribute('data-collabo-widget', '');
    host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + side + ':0;';
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var css = el('style');
    css.textContent =
      ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
      '.btn{position:fixed;bottom:20px;' + side + ':20px;display:flex;align-items:center;gap:8px;border:0;border-radius:999px;padding:12px 18px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.18)}' +
      '.btn svg{width:22px;height:22px;fill:#fff}' +
      '.greet{position:fixed;bottom:78px;' + side + ':20px;max-width:260px;background:#fff;color:#111;border-radius:14px;padding:12px 30px 12px 14px;font-size:14px;line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,.16)}' +
      '.x{position:absolute;top:6px;right:8px;border:0;background:none;font-size:16px;line-height:1;color:#777;cursor:pointer}' +
      '.veil{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.card{position:relative;width:100%;max-width:380px;background:#fff;color:#111;border-radius:16px;padding:22px}' +
      '.card h2{margin:0 0 6px;font-size:19px}.card p{margin:0 0 14px;font-size:14px;line-height:1.45;color:#444}' +
      '.row{display:flex;gap:6px;margin-bottom:10px}' +
      'input[type=tel],input[type=text]{width:100%;border:1px solid #ccc;border-radius:10px;padding:10px 12px;font-size:15px}' +
      'input.cc{width:72px;flex:none}' +
      '.consent{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:#444;margin:4px 0 14px;line-height:1.4}' +
      '.go{width:100%;border:0;border-radius:10px;padding:12px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.go[disabled]{opacity:.6}' +
      'a.go{display:block;text-align:center;text-decoration:none}' +
      '.msg{font-size:13px;margin-top:10px}.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}' +
      '@media (max-width:640px){.btn span{display:none}.btn{padding:14px}' + (B.hideOnMobile ? '.btn,.greet{display:none}' : '') + '}';
    root.appendChild(css);

    if (C.chatUrl) {
      var btn = el('button', 'btn'); btn.type = 'button'; btn.style.background = B.color;
      btn.setAttribute('aria-label', B.label || 'Chat on WhatsApp');
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.2c0-.1-.2-.2-.4-.3z"/></svg>';
      if (B.label) btn.appendChild(el('span', '', B.label));
      btn.addEventListener('click', function () { window.open(C.chatUrl, '_blank', 'noopener'); });
      root.appendChild(btn);

      if (B.greeting && store('collabo-greet-' + C.key) !== '1') {
        setTimeout(function () {
          var g = el('div', 'greet', B.greeting);
          var x = el('button', 'x', '\\u00d7'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
          x.addEventListener('click', function () { g.remove(); store('collabo-greet-' + C.key, '1'); });
          g.appendChild(x);
          g.addEventListener('click', function (e) { if (e.target !== x) btn.click(); });
          root.appendChild(g);
        }, (B.greetingDelaySeconds || 0) * 1000);
      }
    }

    var seen = Number(store('collabo-popup-' + C.key) || 0);
    if (P.enabled && Date.now() - seen > 7 * DAY) {
      setTimeout(function () { showPopup(root); }, (P.delaySeconds || 0) * 1000);
    }
    document.body.appendChild(host);
  }

  function showPopup(root) {
    store('collabo-popup-' + C.key, String(Date.now()));
    beacon('popup_view');
    var veil = el('div', 'veil'); veil.setAttribute('role', 'dialog'); veil.setAttribute('aria-modal', 'true');
    var card = el('form', 'card');
    var x = el('button', 'x', '\\u00d7'); x.type = 'button'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', function () { veil.remove(); });
    card.appendChild(x);
    card.appendChild(el('h2', '', P.title));
    if (P.text) card.appendChild(el('p', '', P.text));
    var name = el('input'); name.type = 'text'; name.placeholder = 'Your name (optional)'; name.autocomplete = 'name'; name.maxLength = 80;
    var nameRow = el('div', 'row'); nameRow.appendChild(name); card.appendChild(nameRow);
    var cc = el('input', 'cc'); cc.type = 'tel'; cc.value = '+' + P.defaultCountryCode; cc.setAttribute('aria-label', 'Country code'); cc.maxLength = 5;
    var phone = el('input'); phone.type = 'tel'; phone.placeholder = 'WhatsApp number'; phone.autocomplete = 'tel-national'; phone.required = true; phone.maxLength = 16;
    var row = el('div', 'row'); row.appendChild(cc); row.appendChild(phone); card.appendChild(row);
    var hp = el('input', 'hp'); hp.type = 'text'; hp.tabIndex = -1; hp.autocomplete = 'off'; hp.setAttribute('aria-hidden', 'true'); card.appendChild(hp);
    var consent = el('label', 'consent'); var box = el('input'); box.type = 'checkbox'; box.required = true;
    consent.appendChild(box); consent.appendChild(el('span', '', P.consentText)); card.appendChild(consent);
    var go = el('button', 'go', P.buttonLabel); go.type = 'submit'; go.style.background = B.color; card.appendChild(go);
    var msg = el('div', 'msg'); card.appendChild(msg);
    card.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!box.checked) { msg.textContent = 'Please tick the box to agree to messages on WhatsApp.'; return; }
      go.disabled = true; msg.textContent = '';
      var body = new URLSearchParams({ phone: (cc.value + phone.value).replace(/[^\\d+]/g, ''), name: name.value, consent: 'yes', consentText: P.consentText, page: location.href.slice(0, 500), website: hp.value });
      fetch(C.api + '/widget/' + C.key + '/signup', { method: 'POST', body: body, mode: 'cors', credentials: 'omit' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) {
            var url = res.j && res.j.data && res.j.data.confirmUrl;
            card.innerHTML = ''; card.appendChild(x);
            if (url) {
              card.appendChild(el('h2', '', 'One last step'));
              card.appendChild(el('p', '', 'Tap the button and send the message that opens in WhatsApp. It confirms this number is yours.'));
              var wa = el('a', 'go', 'Confirm on WhatsApp'); wa.href = url; wa.target = '_blank'; wa.rel = 'noopener'; wa.style.background = B.color;
              card.appendChild(wa);
            } else card.appendChild(el('h2', '', P.successText));
          }
          else { go.disabled = false; msg.textContent = (res.j && res.j.message) || 'Something went wrong. Please try again.'; }
        })
        .catch(function () { go.disabled = false; msg.textContent = 'Something went wrong. Please try again.'; });
    });
    veil.addEventListener('click', function (e) { if (e.target === veil) veil.remove(); });
    veil.appendChild(card);
    root.appendChild(veil);
    phone.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;
}
