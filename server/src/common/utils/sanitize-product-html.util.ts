import sanitizeHtml from 'sanitize-html';

const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
    'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small', 'mark',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'img', 'figure', 'figcaption',
  ],
  // Inline handlers (onclick, onerror, ...) are never listed, so they are dropped.
  allowedAttributes: {
    '*': ['class', 'style'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    table: ['width'],
    col: ['span', 'width'],
    colgroup: ['span'],
    th: ['colspan', 'rowspan', 'scope', 'width'],
    td: ['colspan', 'rowspan', 'width'],
    ol: ['start'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify)$/],
      color: [COLOR],
      'background-color': [COLOR],
      'font-weight': [/^(normal|bold|[1-9]00)$/],
      'font-style': [/^(normal|italic)$/],
      'text-decoration': [/^(none|underline|line-through)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  // Shopify's own descriptions load images from `//cdn.shopify.com/...`.
  allowProtocolRelative: true,
  transformTags: {
    // A link that opens a new tab must not give that page a handle on ours.
    a: (tagName, attribs) => ({
      tagName,
      attribs: attribs.target ? { ...attribs, rel: 'noopener noreferrer' } : attribs,
    }),
  },
};

/**
 * Product description HTML, cut down to what a description needs: headings,
 * lists, tables, images, links and basic formatting. Scripts, styles,
 * iframes, forms, event handlers and javascript:/data: URLs are removed.
 *
 * Descriptions are pushed to the merchant's live Shopify store as
 * `descriptionHtml` and written to CSV exports, and AGENT and VENDOR members
 * can edit them, so everything that stores or sends one goes through this.
 * The CRM editor (Quill) produces no embeds, so iframes are not kept.
 */
export function sanitizeProductHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
