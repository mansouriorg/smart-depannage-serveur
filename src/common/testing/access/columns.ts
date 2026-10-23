import { textColumnsOf } from '../memory-prisma';
import { Household, markStart } from '../world';

/**
 * What an answer must not show of a model, column by column: the text of a text column (the world marks every one, so a view
 * that renames the column still shows the mark), and the column's name as a property (a view that sends the row with the
 * column in it, even empty). A column that holds no text, a date or a number, has no mark: its name is all there is to look for.
 */
export function withheldColumns(household: Household, model: string, columns: string[]): string[] {
  const text = new Set(textColumnsOf(model));

  return columns.flatMap((column) => [...(text.has(column) ? [markStart(household, `${model}.${column}`)] : []), `column:${column}`]);
}
