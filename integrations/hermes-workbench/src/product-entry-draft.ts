import { z } from 'zod';
import { sensitiveDraftValues } from './agent-onboarding-draft';

const Fields = z
  .object({
    directory: z.string().max(4096),
    command: z.string().max(4096),
    script: z.string().max(4096),
    args: z.array(z.string().max(8192)).max(128),
    nodeMode: z.boolean(),
  })
  .strict();
const Draft = z
  .object({ version: z.literal(1), productId: z.string().min(1).max(128), fields: Fields })
  .strict();
export type ProductEntryFields = z.infer<typeof Fields>;
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (id: string) => `control-plane-product-entry-v1:${encodeURIComponent(id)}`;
const sensitive = (fields: ProductEntryFields) =>
  sensitiveDraftValues([fields.directory, fields.command, fields.script, ...fields.args]);
export function clearProductEntryDraft(storage: Store, id: string) {
  try {
    storage.removeItem(key(id));
  } catch {
    /* optional browser storage */
  }
}
export function writeProductEntryDraft(
  storage: Store,
  productId: string,
  fields: ProductEntryFields,
) {
  try {
    const data = Draft.parse({ version: 1, productId, fields });
    if (sensitive(fields)) {
      clearProductEntryDraft(storage, productId);
      return 'sensitive' as const;
    }
    if (!fields.directory && !fields.command && !fields.script && !fields.args.length) {
      clearProductEntryDraft(storage, productId);
      return 'empty' as const;
    }
    const text = JSON.stringify(data);
    if (text.length > 262144) throw Error('Draft too large');
    storage.setItem(key(productId), text);
    return 'saved' as const;
  } catch {
    clearProductEntryDraft(storage, productId);
    return 'unavailable' as const;
  }
}
export function readProductEntryDraft(
  storage: Store,
  productId: string,
): ProductEntryFields | undefined {
  try {
    const text = storage.getItem(key(productId));
    if (!text || text.length > 262144) return undefined;
    const data = Draft.parse(JSON.parse(text));
    if (data.productId !== productId || sensitive(data.fields)) return undefined;
    return data.fields;
  } catch {
    return undefined;
  }
}
