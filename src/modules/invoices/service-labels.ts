/** The trade as a customer reads it on an invoice ("PLOMBIER" is a code, not a word for a document). */
const SERVICE_LABELS: Record<string, string> = {
  PLOMBIER: 'Plomberie',
  MENUISIER: 'Menuiserie',
  SERRURIER: 'Serrurerie',
  ELECTRICIEN: 'Électricité',
  CHAUFFAGISTE: 'Chauffage',
  VITRIER: 'Vitrerie',
  CLIMATICIEN: 'Climatisation',
  AUTRE: 'Dépannage',
};

export function serviceLabel(type: string | null | undefined): string {
  if (!type) return 'Dépannage';

  return SERVICE_LABELS[String(type)] ?? 'Dépannage';
}
