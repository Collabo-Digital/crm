import { sanitizeProductHtml } from './sanitize-product-html.util';

describe('sanitizeProductHtml', () => {
  it.each([
    ['a script tag', '<p>Hi</p><script>alert(1)</script>', '<p>Hi</p>'],
    ['an inline event handler', '<img src="https://x.test/a.png" onerror="alert(1)">', '<img src="https://x.test/a.png" />'],
    ['a javascript: link', '<a href="javascript:alert(1)">Buy</a>', '<a>Buy</a>'],
    ['an obfuscated javascript: link', '<a href="  JaVaScRiPt:alert(1)">Buy</a>', '<a>Buy</a>'],
    ['an entity-encoded javascript: link', '<a href="&#106;avascript:alert(1)">Buy</a>', '<a>Buy</a>'],
    ['a data: image', '<img src="data:image/svg+xml;base64,PHN2Zz4=">', '<img />'],
    ['an iframe', '<p>a</p><iframe src="https://evil.test"></iframe>', '<p>a</p>'],
    ['a style element', '<style>body{display:none}</style><p>a</p>', '<p>a</p>'],
    ['a form', '<form action="https://evil.test"><input name="card"><button>Pay</button></form>', 'Pay'],
    ['an svg with a script', '<svg><script>alert(1)</script></svg>ok', 'ok'],
    ['an object embed', '<object data="https://evil.test/x.swf"></object>ok', 'ok'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">ok', 'ok'],
    ['a style that can load a URL', '<p style="background-image:url(javascript:alert(1));color:red">a</p>', '<p style="color:red">a</p>'],
    ['a style that can cover the page', '<div style="position:fixed;top:0">a</div>', '<div>a</div>'],
  ])('strips %s', (_label, input, expected) => {
    expect(sanitizeProductHtml(input)).toBe(expected);
  });

  it('keeps what the product editor produces', () => {
    const quill =
      '<h2>Fabric</h2><p><strong>Bold</strong>, <em>italic</em>, <u>underline</u> and <s>strike</s>.</p>' +
      '<ol><li>One</li><li>Two</li></ol><ul><li>Dot</li></ul>' +
      '<p class="ql-align-center">Centred</p>' +
      '<p><a href="https://shop.test/size" rel="noopener noreferrer" target="_blank">Size guide</a></p>';
    expect(sanitizeProductHtml(quill)).toBe(quill);
  });

  it('keeps tables, images and basic formatting from Shopify descriptions', () => {
    const html =
      '<table width="100%"><thead><tr><th colspan="2">Size</th></tr></thead>' +
      '<tbody><tr><td>S</td><td style="text-align:center;font-weight:bold">36</td></tr></tbody></table>' +
      '<img src="//cdn.shopify.com/s/files/1/a.jpg" alt="Front" width="600" />' +
      '<p><a href="mailto:help@shop.test">Email us</a> or <a href="/pages/returns">read returns</a>.</p>';
    expect(sanitizeProductHtml(html)).toBe(html);
  });

  it('adds rel="noopener noreferrer" to links that open a new tab', () => {
    expect(sanitizeProductHtml('<a href="https://x.test" target="_blank">x</a>')).toBe(
      '<a href="https://x.test" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it('gives the same result when run twice', () => {
    const inputs = [
      '<p>a&nbsp;b &amp; c &lt;d&gt;</p><script>x</script>',
      '<p style="color:rgb(1, 2, 3)">x</p><a href="https://x.test" target="_blank">y</a>',
      'Plain text with "quotes" & ampersands',
    ];
    for (const input of inputs) {
      const once = sanitizeProductHtml(input);
      expect(sanitizeProductHtml(once)).toBe(once);
    }
  });
});
