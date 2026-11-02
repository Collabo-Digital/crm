import { ShopifyPushService } from './shopify-push.service';
import { PRODUCT_DESCRIPTION_QUERY } from './shopify-graphql.types';

/**
 * What a push sends as `descriptionHtml`. Descriptions are stored sanitised,
 * including ones pulled from Shopify, so the push must not overwrite the
 * live store's description when sanitising is the only difference.
 */

const AUTH = { shopDomain: 'shop.myshopify.com', accessToken: 'tok', channelId: 'ch_shopify' };
const GID = 'gid://shopify/Product/1';

function build(remoteDescription: string | null) {
  const graphql = {
    request: jest.fn((_auth: unknown, query: string) =>
      Promise.resolve(
        query === PRODUCT_DESCRIPTION_QUERY
          ? { product: { descriptionHtml: remoteDescription } }
          : {},
      ),
    ),
  };
  const service = new ShopifyPushService(
    {} as never,
    {} as never,
    graphql as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const descriptionUpdate = (bodyHtml: string | null) =>
    service['descriptionUpdate'](AUTH, GID, bodyHtml);
  return { service, graphql, descriptionUpdate };
}

describe('ShopifyPushService — description on an update push', () => {
  it('leaves Shopify’s description alone when ours is its sanitised copy', async () => {
    const remote = '<p>Linen.</p><iframe src="https://www.youtube.com/embed/x"></iframe>';
    const { descriptionUpdate, graphql } = build(remote);
    expect(await descriptionUpdate('<p>Linen.</p>')).toEqual({});
    expect(graphql.request).toHaveBeenCalledWith(AUTH, PRODUCT_DESCRIPTION_QUERY, { id: GID });
  });

  it('sends a description edited in the CRM', async () => {
    const { descriptionUpdate } = build('<p>Linen.</p>');
    expect(await descriptionUpdate('<p>Pure linen.</p>')).toEqual({
      descriptionHtml: '<p>Pure linen.</p>',
    });
  });

  it('never sends unsafe markup stored before descriptions were sanitised', async () => {
    const { descriptionUpdate } = build('<p>Old</p>');
    expect(await descriptionUpdate('<p>New</p><script>steal()</script>')).toEqual({
      descriptionHtml: '<p>New</p>',
    });
  });

  it('still clears a description removed in the CRM', async () => {
    const { descriptionUpdate } = build('<p>Linen.</p>');
    expect(await descriptionUpdate(null)).toEqual({ descriptionHtml: null });
  });

  it('sends nothing when neither side has a description', async () => {
    const { descriptionUpdate } = build(null);
    expect(await descriptionUpdate(null)).toEqual({});
  });
});

describe('ShopifyPushService — description on a create push', () => {
  it('sanitises the description it sends', () => {
    const { service } = build(null);
    const input = service['buildProductSetInput'](
      {
        title: 'Shirt',
        bodyHtml: '<p onclick="steal()">Soft</p><script>steal()</script>',
        vendor: null,
        productType: null,
        status: 'DRAFT',
        tags: [],
        options: null,
        variants: [],
        images: [],
      },
      false,
      false,
      false,
      null,
      (v) => (v == null ? null : String(v)),
    );
    expect(input.descriptionHtml).toBe('<p>Soft</p>');
  });
});
