import { chatParties, messageRecipients } from './message-audience';

const job = { clientId: 10, artisanId: 20 };

describe('chatParties', () => {
  it('knows the three chats and nothing else', () => {
    expect(chatParties('CLIENT_ARTISAN')).toEqual({ client: true, artisan: true, support: false });
    expect(chatParties('CLIENT_SUPPORT')).toEqual({ client: true, artisan: false, support: true });
    expect(chatParties('ARTISAN_SUPPORT')).toEqual({ client: false, artisan: true, support: true });
    expect(chatParties('INTERNAL_ADMIN')).toBe(null);
    expect(chatParties('whatever')).toBe(null);
  });
});

describe('messageRecipients', () => {
  const who = (audience: string, sender: 'client' | 'artisan' | 'support', artisanId: number | null = 20) =>
    messageRecipients({
      audience,
      senderId: sender === 'client' ? 10 : sender === 'artisan' ? 20 : 99,
      senderIsSupport: sender === 'support',
      clientId: job.clientId,
      artisanId,
    });

  it('client to artisan: only the artisan, never the support team', () => {
    expect(who('CLIENT_ARTISAN', 'client')).toEqual({ clientId: null, artisanId: 20, support: false });
  });

  it('artisan to client: only the client', () => {
    expect(who('CLIENT_ARTISAN', 'artisan')).toEqual({ clientId: 10, artisanId: null, support: false });
  });

  it('a support message in the client chat reaches the client, not the artisan', () => {
    expect(who('CLIENT_SUPPORT', 'support')).toEqual({ clientId: 10, artisanId: null, support: false });
  });

  it('a support message in the artisan chat reaches the artisan, not the client', () => {
    expect(who('ARTISAN_SUPPORT', 'support')).toEqual({ clientId: null, artisanId: 20, support: false });
  });

  it('a client or artisan writing to support alerts the support team only', () => {
    expect(who('CLIENT_SUPPORT', 'client')).toEqual({ clientId: null, artisanId: null, support: true });
    expect(who('ARTISAN_SUPPORT', 'artisan')).toEqual({ clientId: null, artisanId: null, support: true });
  });

  it('staff speaking in the client-artisan chat alert both of them', () => {
    expect(who('CLIENT_ARTISAN', 'support')).toEqual({ clientId: 10, artisanId: 20, support: false });
  });

  it('nobody to tell when no artisan is assigned yet', () => {
    expect(who('CLIENT_ARTISAN', 'client', null)).toEqual({ clientId: null, artisanId: null, support: false });
  });

  it('internal notes and unknown audiences reach nobody', () => {
    expect(who('INTERNAL_ADMIN', 'support')).toEqual({ clientId: null, artisanId: null, support: false });
  });
});
