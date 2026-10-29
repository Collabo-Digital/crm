import {
  buildShopifyCsv,
  groupRowsIntoProducts,
  parseShopifyCsv,
} from './shopify-csv.format';

const variant = {
  sku: 'SKU-1',
  barcode: null,
  price: 100,
  compareAtPrice: null,
  cost: null,
  inventoryQuantity: 1,
  trackQuantity: true,
  continueSellingWhenOutOfStock: false,
  weight: null,
  weightUnit: null,
  requiresShipping: true,
  taxable: true,
  option1: null,
  option2: null,
  option3: null,
};

function exportBody(bodyHtml: string | null): string {
  const csv = buildShopifyCsv([
    {
      title: 'Shirt',
      bodyHtml,
      vendor: null,
      productType: null,
      tags: [],
      status: 'ACTIVE',
      publishedAt: null,
      options: [],
      variants: [variant],
      images: [],
    },
  ]);
  return parseShopifyCsv(csv)[0]['Body (HTML)'];
}

describe('product description HTML in the Shopify CSV', () => {
  it('exports a stored description without its scripts or handlers', () => {
    // Rows saved before descriptions were sanitised on write.
    expect(
      exportBody('<p onclick="steal()">Soft <b>cotton</b></p><script>steal()</script>'),
    ).toBe('<p>Soft <b>cotton</b></p>');
  });

  it('imports a description without its scripts or javascript: links', () => {
    const { products } = groupRowsIntoProducts([
      {
        Handle: 'shirt',
        Title: 'Shirt',
        'Body (HTML)':
          '<h2>Care</h2><ul><li>Cold wash</li></ul><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>',
        'Variant Price': '100',
      },
    ]);
    expect(products[0].bodyHtml).toBe(
      '<h2>Care</h2><ul><li>Cold wash</li></ul><a>x</a><img src="x" />',
    );
  });

  it('imports a description that is only unsafe markup as no description', () => {
    const { products } = groupRowsIntoProducts([
      { Handle: 'shirt', Title: 'Shirt', 'Body (HTML)': '<script>alert(1)</script>', 'Variant Price': '100' },
    ]);
    expect(products[0].bodyHtml).toBeUndefined();
  });
});

describe('product image addresses in an imported CSV', () => {
  const imported = (...srcs: string[]) =>
    groupRowsIntoProducts([
      { Handle: 'shirt', Title: 'Shirt', 'Variant Price': '100', 'Image Src': srcs[0] },
      ...srcs.slice(1).map((src) => ({ Handle: 'shirt', 'Image Src': src })),
    ]);

  it('keeps web addresses and our own upload paths', () => {
    const { products, errors } = imported(
      'https://cdn.shopify.com/s/files/1/0001/products/kurta.jpg?v=17',
      'http://localhost:3000/uploads/products/org_1/0b6c1f9e-2f7a-4f4e-9d55-4d7a2f0b1c3e.png',
      '/uploads/products/org_1/0b6c1f9e-2f7a-4f4e-9d55-4d7a2f0b1c3e.png',
      'https://example.com/.well-known/a..b.png',
    );

    expect(errors).toEqual([]);
    expect(products[0].images.map((i) => i.src)).toEqual([
      'https://cdn.shopify.com/s/files/1/0001/products/kurta.jpg?v=17',
      'http://localhost:3000/uploads/products/org_1/0b6c1f9e-2f7a-4f4e-9d55-4d7a2f0b1c3e.png',
      '/uploads/products/org_1/0b6c1f9e-2f7a-4f4e-9d55-4d7a2f0b1c3e.png',
      'https://example.com/.well-known/a..b.png',
    ]);
  });

  it.each([
    ['a climb out of the uploads folder', 'http://x/uploads/products/../../dist/src/main.js'],
    ['an encoded climb', 'http://x/uploads/products/%2e%2E/%2e%2e/dist/src/main.js'],
    ['a climb with backslashes', 'http://x/uploads\\products\\..\\..\\dist\\src\\main.js'],
    ['a climb hidden by a tab', 'http://x/uploads/products/.\t./.\t./dist/src/main.js'],
    ['a path that climbs', '/uploads/products/../../dist/src/main.js'],
    ['a path deeper than one of our uploads', '/uploads/products/org_1/a/b.png'],
    ['a relative path', 'images/kurta.jpg'],
    ['an absolute file path', '/etc/passwd'],
    ['a file address', 'file:///etc/passwd'],
    ['a script address', 'javascript:alert(1)'],
    ['a data address', 'data:image/png;base64,iVBORw0KGgo='],
  ])('leaves out %s, with an error for its row, and still imports the product', (_what, src) => {
    const { products, errors } = imported('https://cdn.shopify.com/s/files/1/0001/products/kurta.jpg', src);

    expect(products).toHaveLength(1);
    expect(products[0].images.map((i) => i.src)).toEqual(['https://cdn.shopify.com/s/files/1/0001/products/kurta.jpg']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 3, handle: 'shirt' });
    expect(errors[0].message).toContain('Image Src');
  });
});
