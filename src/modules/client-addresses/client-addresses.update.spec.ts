import { FakeTable } from '../../common/testing/fake-tables';
import { ClientAddressesService } from './client-addresses.service';

/**
 * The point of a saved address (P3-05): a request made from a saved address is measured to it, so it has to belong to the text it is saved with.
 */

function world() {
  const clientAddress = new FakeTable({});

  clientAddress.insert({ id: 5, clientId: 1, address: '12 rue de Marseille', city: 'Tunis', latitude: 36.8, longitude: 10.18, isDefault: false });
  clientAddress.insert({ id: 6, clientId: 2, address: 'ailleurs', city: 'Sfax', latitude: 34.7, longitude: 10.7, isDefault: false });

  return { clientAddress, service: new ClientAddressesService({ clientAddress } as any) };
}

describe('updating a saved address (P3-05)', () => {
  it('a new text with no new point does not keep the old point', async () => {
    const w = world();

    await w.service.update(1, 5, { address: '3 avenue Habib Bourguiba' } as any);

    const row = w.clientAddress.rows.find((candidate) => candidate.id === 5)!;

    expect(row.address).toBe('3 avenue Habib Bourguiba');
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });

  it('a new city counts as a new text too', async () => {
    const w = world();

    await w.service.update(1, 5, { city: 'Sousse' } as any);
    expect(w.clientAddress.rows.find((candidate) => candidate.id === 5)!.latitude).toBeNull();
  });

  it('a new text with a new point keeps the new point', async () => {
    const w = world();

    await w.service.update(1, 5, { address: '3 avenue Habib Bourguiba', latitude: 36.81, longitude: 10.19 } as any);

    const row = w.clientAddress.rows.find((candidate) => candidate.id === 5)!;

    expect([row.latitude, row.longitude]).toEqual([36.81, 10.19]);
  });

  it('the same text sent again keeps the point (a form that sends every field is not a change)', async () => {
    const w = world();

    await w.service.update(1, 5, { address: '12 rue de Marseille', city: 'Tunis' } as any);

    const row = w.clientAddress.rows.find((candidate) => candidate.id === 5)!;

    expect([row.latitude, row.longitude]).toEqual([36.8, 10.18]);
  });

  it('a blank city is the same as no city: saving the form again does not clear the point', async () => {
    const w = world();

    w.clientAddress.rows.find((candidate) => candidate.id === 5)!.city = null;
    await w.service.update(1, 5, { city: '' } as any);

    const row = w.clientAddress.rows.find((candidate) => candidate.id === 5)!;

    expect([row.latitude, row.longitude]).toEqual([36.8, 10.18]);
  });

  it('a change that is not the text (the default address) keeps the point', async () => {
    const w = world();

    await w.service.update(1, 5, { isDefault: true } as any);
    expect(w.clientAddress.rows.find((candidate) => candidate.id === 5)!.latitude).toBe(36.8);
  });

  it('the address of somebody else is refused and not touched', async () => {
    const w = world();

    await expect(w.service.update(1, 6, { address: 'x' } as any)).rejects.toThrow('Accès refusé');
    expect(w.clientAddress.rows.find((candidate) => candidate.id === 6)!.address).toBe('ailleurs');
  });
});
