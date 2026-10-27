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
