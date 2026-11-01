import { ArtisansController } from '../../modules/artisans/artisans.controller';
import { AuthController } from '../../modules/auth/auth.controller';
import { GuestController } from '../../modules/guest/guest.controller';

/**
 * The four routes that open a profile or send the first message to someone with no account read the language the app declares
 * (header X-App-Locale) and give it to their service (P3-04). The services are tested with a language given; these tests are what
 * make a controller that stops reading the header fail: every new account and every visitor would silently stay French.
 */

const asking = (language?: string | string[]) => ({ headers: language === undefined ? {} : { 'x-app-locale': language } });

function spy(names: string[]) {
  const calls: Record<string, any[][]> = {};
  const service: any = {};

  for (const name of names) {
    calls[name] = [];
    service[name] = async (...args: any[]) => (calls[name].push(args), { ok: true });
  }

  return { service, calls };
}

describe('the guest routes read the language of the call (P3-04)', () => {
  const make = () => {
    const { service, calls } = spy(['createGuestIntervention', 'requestAccountActivation']);

    return { controller: new GuestController(service, {} as any), calls };
  };

  it('creating a request gives the service the language of the page', async () => {
    const { controller, calls } = make();
    const dto: any = { serviceType: 'PLOMBIER' };

    await controller.createGuestIntervention(dto, asking('ar'));
    await controller.createGuestIntervention(dto, asking('fr'));
    await controller.createGuestIntervention(dto, asking());

    expect(calls.createGuestIntervention.map((args) => args[1])).toEqual(['ar', 'fr', null]);
    expect(calls.createGuestIntervention[0][0]).toBe(dto);
  });

  it('asking for the activation code gives the service the language of the page, after the address of the client', async () => {
    const { controller, calls } = make();
    const dto: any = { email: 'a@b.tn', phone: '22123456' };

    await controller.requestAccountActivation(dto, '10.0.0.1', asking('ar'));
    await controller.requestAccountActivation(dto, '', asking());

    expect(calls.requestAccountActivation[0]).toEqual([dto, '10.0.0.1', 'ar']);
    expect(calls.requestAccountActivation[1]).toEqual([dto, 'unknown', null]);
  });
});

describe('registering reads the language of the call (P3-04)', () => {
  it('an app that declares Arabic opens the account in Arabic, one that says nothing leaves the service its default', async () => {
    const { service, calls } = spy(['register']);
    const controller = new AuthController(service);
    const dto: any = { email: 'a@b.tn', password: 'Secret123' };

    await controller.register(dto, asking('ar'));
    await controller.register(dto, asking('fr'));
    await controller.register(dto, asking());
    await controller.register(dto, asking('de'));

    expect(calls.register.map((args) => args[1])).toEqual(['ar', 'fr', undefined, undefined]);
  });
});

describe('a technician’s application reads the language of the call (P3-04)', () => {
  const application = JSON.stringify({ name: 'Sami Ben Salah', email: 'sami@mail.tn', phone: '55 222 333', specialties: ['Plomberie'], yearsExperience: 4, zoneIds: [1] });

  it('gives the service the language the form was shown in', async () => {
    const { service, calls } = spy(['apply']);
    const controller = new ArtisansController(service);

    await controller.apply(application, {}, asking('ar'));
    await controller.apply(application, {}, asking());

    expect(calls.apply.map((args) => args[2])).toEqual(['ar', null]);
    expect(calls.apply[0][0].email).toBe('sami@mail.tn');
  });
});
