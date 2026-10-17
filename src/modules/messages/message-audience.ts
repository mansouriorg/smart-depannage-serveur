/**
 * Who is in each conversation (P1-02).
 *
 * A job has three chats. A message belongs to exactly one of them and must only
 * reach the people in it:
 *
 *   CLIENT_ARTISAN   the customer and the artisan
 *   CLIENT_SUPPORT   the customer and the support team
 *   ARTISAN_SUPPORT  the artisan and the support team
 *
 * Staff can read every chat from the dashboard (that is checked by the message
 * service), but they are only *notified* about the chats they are part of.
 */

export type ChatAudience = 'CLIENT_ARTISAN' | 'CLIENT_SUPPORT' | 'ARTISAN_SUPPORT';

export const CHAT_PARTIES: Record<
  ChatAudience,
  { client: boolean; artisan: boolean; support: boolean }
> = {
  CLIENT_ARTISAN: { client: true, artisan: true, support: false },
  CLIENT_SUPPORT: { client: true, artisan: false, support: true },
  ARTISAN_SUPPORT: { client: false, artisan: true, support: true },
};

export type MessageParticipants = {
  client: boolean;
  artisan: boolean;
  support: boolean;
};

/** The parties of a chat, or null for an audience that is not a chat (internal notes...). */
export function chatParties(audience: string): MessageParticipants | null {
  return (CHAT_PARTIES as Record<string, MessageParticipants>)[audience] ?? null;
}

export type MessageRecipients = {
  /** The customer, when they are in this chat and did not write the message. */
  clientId: number | null;
  /** The artisan, when they are in this chat and did not write the message. */
  artisanId: number | null;
  /** True when the support team is in this chat and the sender is not one of them. */
  support: boolean;
};

/**
 * Who should be told about a new message: everybody in the chat except the
 * sender. A support message never reaches the other party of the job, and a
 * client-artisan message never reaches the support team.
 */
export function messageRecipients(params: {
  audience: string;
  senderId: number;
  senderIsSupport: boolean;
  clientId: number;
  artisanId: number | null;
}): MessageRecipients {
  const parties = chatParties(params.audience);

  if (!parties) {
    return { clientId: null, artisanId: null, support: false };
  }

  return {
    clientId: parties.client && params.clientId !== params.senderId ? params.clientId : null,
    artisanId:
      parties.artisan && params.artisanId !== null && params.artisanId !== params.senderId
        ? params.artisanId
        : null,
    support: parties.support && !params.senderIsSupport,
  };
}
