/**
 * What a visitor sends to join the platform (P1-11), as the JSON `data` field of a multipart
 * request that also carries the documents. The documents are files, not addresses: an applicant
 * used to type the URL of a document, and the back office opened whatever was typed. The zones
 * are picked from the platform's list (GET /service-zones), not typed.
 *
 * A multipart request has no typed body for the global pipe to check, so the rules live in
 * apply-form.ts (parseApplication), which is the only way to make one of these.
 */
export interface ApplyArtisanDto {
  name: string;
  email: string;
  phone: string;
  companyName?: string;
  companyNumber?: string;
  insuranceNumber?: string;
  specialty?: string;
  specialties: string[];
  yearsExperience: number;
  bio?: string;
  /** Numbers from GET /service-zones: where the applicant accepts to work. */
  zoneIds: number[];
}
