import { isStoredFileUrl } from './stored-file-url';

describe('the address of a file the platform keeps (P1-11)', () => {
  it('accepts the two spellings of the download route', () => {
    expect(isStoredFileUrl('/files/12/download')).toBe(true);
    expect(isStoredFileUrl('/api/files/12/download')).toBe(true);
  });

  it('refuses anything a person could have typed', () => {
    for (const url of [
      'https://example.com/files/12/download',
      'https://evil.tn/id.jpg',
      '/files/12/download?x=1',
      '/files//download',
      '/files/abc/download',
      '/files/12/download/extra',
      '/uploads/12.pdf',
      '../files/12/download',
      '/files/12345678901/download',
      '',
      null,
      undefined,
      12,
    ]) {
      expect(isStoredFileUrl(url)).toBe(false);
    }
  });
});
