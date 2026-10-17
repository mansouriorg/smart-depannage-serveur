import { balanced, listSourceFiles, readSource, stripComments } from '../../common/testing/source-scan';

/**
 * P1-07 guard: a before/after photo gets onto a job in ONE place, ProofsService, and nowhere
 * can a photo be reached without logging in or be swapped once it was judged.
 *
 * It reads the source: a text scan that stops mistakes, not someone determined.
 */

const code = (rel: string) => stripComments(readSource(rel));

/** The body of `name(...) {...}` in a source text. */
function bodyOf(source: string, name: string): string {
  const found = new RegExp(`\\b${name}\\s*\\(`).exec(source);

  if (!found) return '';

  const parenthesis = found.index + found[0].length - 1;
  const params = balanced(source, parenthesis);
  const open = source.indexOf('{', parenthesis + params.length + 2);

  return balanced(source, open);
}

/** The decorators in front of a method of a controller, and its signature. */
function routeOf(source: string, method: string): string {
  const found = new RegExp(`\\n\\s*(?:async\\s+)?${method}\\s*\\(`).exec(source);

  if (!found) return '';

  const start = source.lastIndexOf('\n\n', found.index);

  return source.slice(start < 0 ? 0 : start, found.index + found[0].length);
}

const COLUMN = /\b(?:before|after)Photo(?:Url|Lat|Lng|At)\b/;

describe('the proof columns of an intervention have one writer (P1-07)', () => {
  it('only the proof service, the one-off migration and a reader name them', () => {
    const files = listSourceFiles().filter((rel) => COLUMN.test(code(rel)));

    expect(files).toEqual([
      'modules/artisans/artisans.service.ts', // reads afterPhotoUrl: "add the after photo before finishing"
      'modules/proofs/legacy-proofs.ts', // the one-off migration of the photos taken before the rules
      'modules/proofs/proofs.service.ts',
    ]);
  });

  it('the artisans service only reads them', () => {
    const source = code('modules/artisans/artisans.service.ts');
    const lines = source.split('\n').filter((line) => COLUMN.test(line));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => /^\s*if \(!intervention\.afterPhotoUrl\) \{\s*$/.test(line))).toBe(true);
  });

  it('the update DTO of a job no longer accepts them', () => {
    expect(COLUMN.test(code('modules/interventions/dto/update-intervention.dto.ts'))).toBe(false);
  });

  it('nothing but the proof service stores a proof photo or its row', () => {
    const offenders = listSourceFiles().filter((rel) => {
      if (rel === 'modules/proofs/proofs.service.ts' || rel === 'modules/files/files.service.ts') return false;

      return /\b(?:stageProofPhoto|recordProofAsset|proofCapture\.(?:create|update|updateMany|delete|deleteMany|upsert))\b/.test(code(rel));
    });

    // The one-off migration writes its own rows; it is run by hand (npm run proofs:migrate), not a route.
    expect(offenders.filter((rel) => rel !== 'modules/proofs/legacy-proofs.ts')).toEqual([]);
  });

  it('the proof service stores a photo only after judging it, and the closing of the job goes through the status table', () => {
    const source = code('modules/proofs/proofs.service.ts');
    const submit = bodyOf(source, 'async submit');
    const keep = bodyOf(source, 'private async keep');

    // The verdict comes before the file is staged (a refused photo is never written).
    expect(submit.indexOf('assessCapture(')).toBeGreaterThan(-1);
    expect(submit.indexOf('assessCapture(')).toBeLessThan(submit.indexOf('this.keep('));
    expect(/stageProofPhoto/.test(submit)).toBe(false);
    expect(keep.indexOf('stageProofPhoto(')).toBeGreaterThan(-1);

    // One transaction, under the lock of the job, with the status written by transitionStatusDetailed.
    expect(keep.indexOf('$transaction(')).toBeGreaterThan(-1);
    expect(keep.indexOf('lockJob(')).toBeGreaterThan(keep.indexOf('$transaction('));
    expect(keep.indexOf('transitionStatusDetailed(')).toBeGreaterThan(keep.indexOf('lockJob('));
    expect(/\bstatus\s*:\s*['"]?(?:COMPLETED|Status)/.test(keep.replace(/status:\s*assessment\.verdict/, ''))).toBe(false);

    // The file is taken away again when the transaction fails.
    expect(/discardStagedPhoto\(/.test(keep)).toBe(true);

    // The job is read with both photo columns: the back office's photo only fills an empty place.
    expect(/select:\s*\{[^}]*beforePhotoUrl:\s*true[^}]*afterPhotoUrl:\s*true/.test(keep)).toBe(true);
  });

  it('the time of a proof is the clock of the server, never the phone\'s', () => {
    const source = code('modules/proofs/proofs.service.ts');

    // beforePhotoAt / afterPhotoAt are written with receivedAt (or put back from an earlier proof),
    // and clientCapturedAt only goes to the audit row.
    const written = [...source.matchAll(/PhotoAt:\s*([\w?.]+)/g)].map((match) => match[1]);

    expect(written.length).toBeGreaterThan(3);
    expect(written.every((value) => value === 'receivedAt' || value === 'back?.receivedAt')).toBe(true);
    expect(/clientCapturedAt/.test(source.slice(source.indexOf('private async keep'), source.indexOf('private async afterKept')))).toBe(false);
    expect(/workCompletedAt:\s*receivedAt/.test(source)).toBe(true);
  });
});

describe('a proof photo is never served without a login (P1-07)', () => {
  it('the public folder of proofs is not served any more', () => {
    const source = code('app.module.ts');

    expect(/serveRoot:\s*['"]\/uploads\/proofs['"]/.test(source)).toBe(false);
    expect(/'uploads',\s*'proofs'/.test(source)).toBe(false);
    expect(/serveRoot:\s*['"]\/uploads\/public['"]/.test(source)).toBe(true);
  });

  it('no controller writes an upload to a folder: proofs are received in memory', () => {
    const upload = code('modules/proofs/proof-upload.ts');

    expect(/memoryStorage\(\)/.test(upload)).toBe(true);
    expect(/diskStorage/.test(upload)).toBe(false);
    expect(/fileSize/.test(upload)).toBe(true);
    // Nothing else of the form is read without a limit either.
    for (const limit of ['files', 'fields', 'fieldSize', 'parts', 'headerPairs']) {
      expect(new RegExp(`\\b${limit}:\\s*\\d+`).test(upload)).toBe(true);
    }

    for (const rel of ['modules/interventions/interventions.controller.ts', 'modules/proofs/proofs.controller.ts']) {
      const source = code(rel);

      expect(/diskStorage|uploads\/proofs/.test(source)).toBe(false);
    }
  });

  it('the only mention of the old folder is the migration', () => {
    const files = listSourceFiles().filter((rel) => /uploads\\?\/proofs|'uploads',\s*'proofs'/.test(code(rel)));

    expect(files).toEqual(['modules/proofs/legacy-proofs.ts']);
  });

  it('the address kept on the job is the authenticated download route', () => {
    const source = code('modules/proofs/proofs.service.ts');

    expect(/`\/api\/files\/\$\{asset\.id\}\/download`/.test(source)).toBe(true);
    expect(/publicUrl/.test(source)).toBe(false);
  });

  it('the files module keeps proofs private and unchangeable', () => {
    const source = code('modules/files/files.service.ts');

    expect(/export const PROOF_PURPOSES[^;]*ARTISAN_BEFORE_PHOTO[^;]*ARTISAN_AFTER_PHOTO/.test(source)).toBe(true);
    expect(/refuseToTouchProof\(/.test(bodyOf(source, 'async deleteFile'))).toBe(true);
    expect(/refuseToTouchProof\(/.test(bodyOf(source, 'async replaceFile'))).toBe(true);
    expect(/PROOF_PURPOSES\.includes\(asset\.purpose\)/.test(bodyOf(source, 'async setVisibility'))).toBe(true);
    // No more column of the intervention follows a replacement.
    expect(COLUMN.test(bodyOf(source, 'private async replaceUrlReferences'))).toBe(false);
    // The older routes that took a proof without checking it are gone.
    expect(/uploadArtisanBeforePhoto|uploadArtisanAfterPhoto/.test(source)).toBe(false);
    expect(/uploadArtisanBeforePhoto|uploadArtisanAfterPhoto|before-photo|after-photo/.test(code('modules/files/files.controller.ts'))).toBe(false);
    expect(/uploadBeforePhoto|uploadAfterPhoto|before-photo|after-photo/.test(code('modules/artisans/artisans.controller.ts'))).toBe(false);
  });
});

describe('who may send a proof and who may judge one (P1-07)', () => {
  it('the upload route checks the role before it reads the photo, and keeps clients out', () => {
    const route = routeOf(code('modules/proofs/proofs.controller.ts'), 'add');

    expect(route.indexOf("AuthGuard('jwt')")).toBeGreaterThan(-1);
    expect(route.indexOf('RolesGuard')).toBeGreaterThan(-1);

    const roles = /@Roles\(([^)]*)\)/.exec(route)![1];

    expect(roles).toContain('Role.ARTISAN');
    expect(/Role\.CLIENT|Role\.ACCOUNTANT/.test(roles)).toBe(false);
    // Guards run before interceptors: the role is checked before the photo is read.
    expect(route.indexOf('@UseGuards(')).toBeLessThan(route.indexOf('@UseInterceptors('));
    expect(/FileInterceptor\('photo', PROOF_UPLOAD\)/.test(route)).toBe(true);
  });

  it('the queue and the decision are for the back office only', () => {
    const source = code('modules/proofs/proofs.controller.ts');

    for (const name of ['list', 'review']) {
      const route = routeOf(source, name);
      const roles = /@Roles\(([^)]*)\)/.exec(route)![1];

      expect(route.indexOf("AuthGuard('jwt')")).toBeGreaterThan(-1);
      expect(route.indexOf('RolesGuard')).toBeGreaterThan(-1);
      expect(/Role\.ARTISAN|Role\.CLIENT|Role\.ACCOUNTANT/.test(roles)).toBe(false);
    }
  });

  it('closing a job with a photo is for the artisan, read in memory, through the proof service', () => {
    const controller = code('modules/interventions/interventions.controller.ts');
    const route = routeOf(controller, 'completeWork');

    expect(/@Roles\(Role\.ARTISAN\)/.test(route)).toBe(true);
    expect(/FileInterceptor\('photo', PROOF_UPLOAD\)/.test(route)).toBe(true);

    const service = code('modules/interventions/interventions.service.ts');
    const body = bodyOf(service, 'async completeWork');

    expect(/this\.proofs\.submit\(/.test(body)).toBe(true);
    expect(/completeJob:\s*true/.test(body)).toBe(true);
    expect(/transitionStatus|\.intervention\.(?:update|findUnique)/.test(body)).toBe(false);
  });

  it('the proof service tells the controller the verdict only in words, and the service decides the status of a decision once', () => {
    const source = code('modules/proofs/proofs.service.ts');
    const review = bodyOf(source, 'async review');

    // The decision is a compare-and-set on the status the row had when it was read.
    expect(/updateMany\(\{\s*where:\s*\{\s*id:\s*proofId,\s*status:\s*'NEEDS_REVIEW'/.test(review)).toBe(true);
    expect(/isTicketStaff\(reviewer\.role\)/.test(review)).toBe(true);
  });
});

describe('what a refused photo leaves behind (P1-07)', () => {
  it('a refused capture is recorded without the picture, its bytes or its fingerprint', () => {
    const submit = bodyOf(code('modules/proofs/proofs.service.ts'), 'async submit');
    const refused = /proofCapture\.create\(\{[\s\S]*?\}\);/.exec(submit)![0];

    expect(/status:\s*'REJECTED'/.test(refused)).toBe(true);
    for (const column of ['fileAssetId', 'photoUrl', 'sha256', 'dhash']) {
      expect(new RegExp(`${column}:\\s*null`).test(refused)).toBe(true);
    }
  });

  it('the answer to the artisan carries no distance, limit or reason of the review', () => {
    const view = bodyOf(code('modules/proofs/proofs.service.ts'), 'private viewFor');

    expect(/distance|reasons|accuracy|latitude|longitude|sha256|dhash/i.test(view)).toBe(false);
  });
});
