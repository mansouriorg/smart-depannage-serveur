/**
 * The address the files module gives a file it keeps: "/files/12/download" (or with the "/api"
 * prefix). The file is private and is read with a login. An address typed by a person (the older
 * application form let an applicant type one) is not a file of the platform: nobody has seen it,
 * and the document viewer cannot open it.
 */
const STORED_FILE_URL = /^(?:\/api)?\/files\/(\d{1,10})\/download$/;

export function isStoredFileUrl(url: unknown): boolean {
  return typeof url === 'string' && STORED_FILE_URL.test(url);
}
