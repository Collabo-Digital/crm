import { imageTypeOf } from './image-type.util';

describe('imageTypeOf', () => {
  it('knows PNG and JPEG by their first bytes', () => {
    expect(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe('image/png');
    expect(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
  });

  it('refuses everything else, whatever it is called', () => {
    expect(imageTypeOf(Buffer.from('GIF89a\x01\x00', 'latin1'))).toBeNull();
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageTypeOf(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toBeNull();
    expect(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(0))).toBeNull();
  });
});
